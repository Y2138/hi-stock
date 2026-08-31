// Agent 数据库只读能力：渐进式 Schema 发现 + 带 schema_hash 的结构化查询。
// 永不接收原始 SQL；标识符由服务端白名单校验，值只通过参数绑定进入 SQL。
import type pg from "pg";
import { sha256Json } from "./hash.js";
import {
  validateDatabaseQueryInput,
  validateDatabaseSchemaInput,
} from "./tool-validation.js";

export type Db = Pick<pg.Pool | pg.PoolClient, "query">;

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const MAX_QUERY_ROWS = 500;
const MAX_BATCH_QUERIES = 30;
const MAX_DESCRIBE_TABLES = 20;
// ponytail: 前 128 位足以识别 Schema 漂移，也避免模型抄错长哈希尾部；出现可测碰撞时再改服务端令牌。
const SCHEMA_VERSION_HEX_LENGTH = 32;

/** 完成事实源切换后只为迁移审计或历史数据保留，不向新会话暴露的退役表。 */
const HIDDEN_LEGACY_TABLES = [
  "task_definition",
  "task_run",
  "strategy_doc",
  "strategy_version",
  "script_registry",
  "script_version",
  "data_dataset",
  "backtest_artifact",
  "content_document",
  "content_revision",
  "content_legacy_import",
  "portfolio_position_snapshot_daily",
  "portfolio_account_snapshot",
  "portfolio_account_state",
] as const;

const SENSITIVE_COLUMNS = new Map<string, Set<string>>([
  ["llm_provider", new Set(["api_key"])],
  ["system_setting", new Set(["hithink_api_key"])],
  ["backtest_run_source", new Set(["source_code"])],
]);

interface BusinessMeta {
  domain: string;
  description: string;
  write_policy: string;
  constraints?: string[];
}

const TABLE_BUSINESS: Record<string, BusinessMeta> = {
  market_instrument: {
    domain: "行情",
    description: "股票、ETF、指数、板块、基金和期货的统一标的主数据。",
    write_policy: "只允许由行情数据源 service 维护；Agent 不直接写入。",
    constraints: ["code 全局唯一；资产能力以 capabilities 为准。"],
  },
  market_bar: {
    domain: "行情",
    description: "日线、分析用 30 分钟线和期货日线的唯一行情事实源；页面只展示日线。",
    write_policy: "只允许 fetch_market_data 经 datasource service 幂等写入。",
    constraints: ["同一标的、频率、交易日和 bar_time 唯一。"],
  },
  market_fetch_run: {
    domain: "行情",
    description: "行情拉取批次、降级链路和数据缺口记录。",
    write_policy: "只允许 datasource service 写入。",
  },
  hithink_dataset_snapshot: {
    domain: "扶摇扩展数据",
    description: "集合竞价、热榜、个股异动和基金研究能力按规范化请求保存的最新官方快照。",
    write_policy: "只允许 fetch_hithink_data 经白名单 datasource service 幂等写入；Agent 只读。",
    constraints: ["基金持仓、配置和持有人数据是定期披露，不是实时持仓；payload 空值不得补零。"],
  },
  portfolio_position: {
    domain: "持仓",
    description: "按标的汇总的当前持仓状态。",
    write_policy: "只允许 portfolio_write 经持仓 service 与事件流原子维护。",
    constraints: ["不能脱离 portfolio_position_change 单独改写当前态。"],
  },
  portfolio_position_change: {
    domain: "持仓",
    description: "买入、卖出、调整和备注组成的持仓事件流；卖出固化成交前成本和本笔已实现毛盈亏，未计费用。",
    write_policy: "只允许 portfolio_write 经持仓 service 追加。",
  },
  portfolio_realized_pnl_baseline: {
    domain: "持仓",
    description: "累计已实现盈亏的一次性历史基线；增量只统计 through_created_at 之后的卖出事件。",
    write_policy: "只允许数据库迁移建立；运行时只读。",
  },
  market_board: {
    domain: "行情",
    description: "行业、概念、区域和特色板块目录。",
    write_policy: "只允许板块目录同步 service 维护；Agent 只读。",
  },
  market_board_membership: {
    domain: "行情",
    description: "带 effective_from/effective_to 的板块成分历史关系。",
    write_policy: "只允许板块成分同步 service 维护；Agent 只读。",
  },
  market_indicator_value: {
    domain: "行情指标",
    description: "按正式计算版本生成的 MA、DIF、DEA 和 MACD 柱当前值。",
    write_policy: "只允许指标工作器维护；Agent 只读。",
  },
  market_indicator_run: {
    domain: "行情指标",
    description: "指标输入哈希、复权口径、计算版本、状态和 gaps。",
    write_policy: "只允许指标工作器维护；Agent 只读。",
  },
  market_limit_event: {
    domain: "市场结构",
    description: "涨停、跌停和炸板的按日规范化结果。",
    write_policy: "只允许市场结构同步 service 维护；Agent 只读。",
  },
  market_dragon_tiger_entry: {
    domain: "市场结构",
    description: "龙虎榜 all/org/hot_money 的按日规范化结果。",
    write_policy: "只允许市场结构同步 service 维护；Agent 只读。",
  },
  pool_membership: {
    domain: "标的池",
    description: "短线/长线池带有效期的策略角色历史，包含完整研究属性和近期关注；所属行业只读取同花顺官方关系，同一标的只有一个当前角色。",
    write_policy: "只允许 pool_write 经标的池 service 关闭旧行并创建新行。",
    constraints: ["角色变更保留历史；当前有效行以 effective_to IS NULL 判定。"],
  },
  agent_memory_artifact: {
    domain: "Agent 记忆",
    description: "经确认保存的可复用方法、模板、数据源经验、任务编排、故障恢复和长期偏好；不是业务事实副本。",
    write_policy: "只允许 memory_write 经记忆 service 创建、更新、替代或废弃。",
  },
  backtest_run: {
    domain: "回测",
    description: "Agent 自驱回测的研究大纲、假设、策略快照、源码继承关系、输入摘要、指标、结论、缺口与终态。",
    write_policy: "只允许 run_backtest 在隔离临时工作区创建运行；历史记录只读。",
    constraints: ["代码正文只进入 backtest_run_source；不保存补丁、stdout/stderr、中间文件或临时路径。"],
  },
  backtest_run_comparison: {
    domain: "回测",
    description: "本次 Agent 回测与历史回测之间的对比关系。",
    write_policy: "只允许 run_backtest 随新运行创建；Agent 和页面只读。",
  },
  backtest_run_source: {
    domain: "回测",
    description: "成功回测的候选源码与最终化后可复用源码版本；通用查询只开放状态和时间元数据。",
    write_policy: "只允许 run_backtest 暂存、finalize_backtest 固化；源码正文只能由 read_backtest_source 读取。",
  },
  strategy_state: {
    domain: "当前策略",
    description: "当前最终策略的整体序号、清单哈希与最近采纳演进。",
    write_policy: "系统保护表；只允许当前策略页面真人批准提案时更新。",
  },
  strategy_document: {
    domain: "当前策略",
    description: "策略与核心指引的稳定身份、展示顺序和当前技术修订指针。",
    write_policy: "只允许当前策略页面真人批准 strategy_publish_request 提案时更新。",
  },
  strategy_document_revision: {
    domain: "当前策略",
    description: "发布所需的不可变技术修订；页面只展示当前最终正文，不提供历史版本入口。",
    write_policy: "只允许真人策略发布事务追加。",
  },
  strategy_evolution_log: {
    domain: "当前策略",
    description: "用户可见的简要策略演进：大纲、结论、调整点与采纳状态。",
    write_policy: "只允许 strategy_publish_request 创建，真人审核决定采纳状态。",
  },
  strategy_publish_proposal: {
    domain: "当前策略",
    description: "待真人审核的策略发布提案；审核结束即清除拟议全文。",
    write_policy: "Agent 只能通过 strategy_publish_request 创建 pending；YOLO 和普通确认均不能批准。",
  },
  strategy_evolution_backtest: {
    domain: "当前策略",
    description: "策略演进摘要关联的已完成回测运行。",
    write_policy: "只允许 strategy_publish_request 在创建提案时写入。",
  },
  content_legacy_import: {
    domain: "内容",
    description: "旧文件路径、mtime、SHA 与目标版本的只读迁移证据。",
    write_policy: "只允许一次性 legacy importer 维护；Agent 只读。",
  },
  job_prompt: {
    domain: "系统作业",
    description: "agent_flow 作业提示词的稳定身份与当前版本。",
    write_policy: "只允许 job_write 或作业管理 API 维护。",
  },
  job_prompt_revision: {
    domain: "系统作业",
    description: "作业提示词的不可变版本。",
    write_policy: "只允许 job_write 或作业管理 API 追加。",
  },
  volume_snapshot: {
    domain: "数据卷",
    description: "本地 PostgreSQL 数据卷快照及 manifest。",
    write_policy: "只允许数据卷 service 维护；对话 Agent 只读。",
  },
  job_definition: {
    domain: "系统作业",
    description: "M3 受控调度作业定义。",
    write_policy: "只允许 job_write 或作业管理 API 维护；trigger_job 只触发执行。",
  },
  job_run: {
    domain: "系统作业",
    description: "系统作业排队、执行、重试、日志和产物。",
    write_policy: "系统保护表；只允许 scheduler/runner service 维护。",
  },
  job_run_output: {
    domain: "系统作业",
    description: "按任务、目标日和运行关联的 Markdown 结果；包含迁入的历史交易计划。",
    write_policy: "只允许 scheduler/runner 与受控历史迁移写入；任务中心直接读取。",
  },
  fundamental_snapshot: {
    domain: "基本面",
    description: "按标的、数据日期和报告期保存的财务指标快照。",
    write_policy: "只允许 fetch_market_data 经 datasource service 幂等写入；Agent 只读。",
  },
  valuation_snapshot: {
    domain: "估值",
    description: "按标的和数据日期保存的 PE/PB/PS/股息率与市值快照。",
    write_policy: "只允许 fetch_market_data 经 datasource service 幂等写入；Agent 只读。",
  },
  analysis_run: {
    domain: "分析",
    description: "板块温度、关键位和长线估值的请求、输入摘要、结果与缺口。",
    write_policy: "只允许 analysis_run 工具、分析 API 或 analysis 作业维护。",
  },
  llm_provider: {
    domain: "模型配置",
    description: "LLM 厂商协议与本机连接配置；凭据列被隐藏。",
    write_policy: "只允许设置页模型配置 service 维护；Agent 只读非敏感列。",
  },
  llm_model: {
    domain: "模型配置",
    description: "LLM 模型目录与能力。",
    write_policy: "只允许设置页模型配置 service 维护。",
  },
  llm_setting: {
    domain: "模型配置",
    description: "当前启用模型。",
    write_policy: "只允许设置页模型配置 service 维护。",
  },
  agent_setting: {
    domain: "Agent 系统",
    description: "Agent 执行模式设置。",
    write_policy: "系统保护表；YOLO 只能由用户在设置页切换。",
  },
  system_setting: {
    domain: "系统设置",
    description: "本机系统级数据源配置；凭据列被隐藏。",
    write_policy: "系统保护表；只允许设置页维护，Agent 只读非敏感列。",
  },
  agent_confirmation: {
    domain: "Agent 系统",
    description: "确认制写提案及决策结果。",
    write_policy: "系统保护表；只允许确认流程维护。",
  },
  agent_tool_audit: {
    domain: "Agent 系统",
    description: "Agent 工具参数与结果哈希审计。",
    write_policy: "系统保护表；只允许工具执行框架追加。",
  },
  agent_external_cli_run: {
    domain: "Agent 系统",
    description: "外部 CLI 桥运行审计。",
    write_policy: "系统保护表；只允许 CLI bridge 维护。",
  },
  chat_session_event: {
    domain: "Agent 系统",
    description: "所有对话共用、可按单调游标重放的低频执行事件；不保存逐 token 文本。",
    write_policy: "系统保护表；只允许对话执行器追加。",
  },
  chat_session: {
    domain: "对话",
    description: "交互与任务共用的 Agent session 元数据、来源、父关系和终态。",
    write_policy: "只允许对话 service 维护。",
  },
  chat_message: {
    domain: "对话",
    description: "会话消息和工具调用的序列化记录。",
    write_policy: "只允许对话 service 追加。",
  },
  chat_attachment: {
    domain: "对话",
    description: "会话上传附件元数据。",
    write_policy: "只允许上传 service 维护。",
  },
  schema_migrations: {
    domain: "系统",
    description: "已应用数据库迁移及文件哈希。",
    write_policy: "系统保护表；只允许迁移器写入。",
  },
};

function fallbackBusiness(table: string): BusinessMeta {
  const prefix = table.split("_")[0] ?? table;
  return {
    domain: prefix,
    description: `${table} 业务表（尚未配置专用业务说明）。`,
    write_policy: "未注册领域写策略；Agent 只读。",
  };
}

function businessOf(table: string): BusinessMeta {
  return TABLE_BUSINESS[table] ?? fallbackBusiness(table);
}

function quoteIdent(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`非法数据库标识符：${value}`);
  return `"${value}"`;
}

function isSensitive(table: string, column: string): boolean {
  return SENSITIVE_COLUMNS.get(table)?.has(column) ?? false;
}

interface RawColumn {
  table_name: string;
  attnum: number;
  name: string;
  data_type: string;
  nullable: boolean;
  default_value: string | null;
  identity: boolean;
  generated: boolean;
}

interface RawConstraint {
  table_name: string;
  name: string;
  type: "p" | "u" | "f" | "c";
  columns: number[] | null;
  referenced_table: string | null;
  referenced_columns: number[] | null;
  definition: string;
}

interface RawIndex {
  table_name: string;
  name: string;
  unique: boolean;
  primary: boolean;
  definition: string;
  predicate: string | null;
  columns: string[];
}

export interface SchemaColumn {
  name: string;
  data_type: string;
  nullable: boolean;
  default_value: string | null;
  identity: boolean;
  generated: boolean;
  enum_values?: string[];
}

export interface TableSchemaDescription {
  table: string;
  domain: string;
  description: string;
  schema_hash: string;
  columns: SchemaColumn[];
  primary_key: string[];
  unique_keys: Array<{ name: string; columns: string[]; predicate?: string | null }>;
  foreign_keys: Array<{
    name: string;
    columns: string[];
    referenced_table: string;
    referenced_columns: string[];
  }>;
  referenced_by: Array<{
    table: string;
    name: string;
    columns: string[];
    referenced_columns: string[];
  }>;
  checks: Array<{ name: string; definition: string }>;
  relationships: string[];
  business_constraints: string[];
  write_policy: string;
  hidden_sensitive_columns: number;
}

interface InternalTableSchema extends TableSchemaDescription {
  all_columns: Array<SchemaColumn & { attnum: number; sensitive: boolean }>;
  indexes: RawIndex[];
}

function groupByTable<T extends { table_name: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const group = grouped.get(row.table_name);
    if (group) group.push(row);
    else grouped.set(row.table_name, [row]);
  }
  return grouped;
}

function enumValues(definition: string, column: string): string[] | undefined {
  if (!definition.includes(column) || (!definition.includes(" IN (") && !definition.includes("ANY (ARRAY["))) {
    return undefined;
  }
  const values = [...definition.matchAll(/'((?:''|[^'])*)'(?:\:\:[a-zA-Z0-9_ ]+)?/g)]
    .map((match) => match[1]!.replace(/''/g, "'"));
  return values.length > 0 ? [...new Set(values)] : undefined;
}

async function loadSchemas(db: Db, requested?: string[]): Promise<InternalTableSchema[]> {
  if (requested) requested.forEach(quoteIdent);
  const hiddenRequested = requested?.filter((table) =>
    (HIDDEN_LEGACY_TABLES as readonly string[]).includes(table),
  );
  if (hiddenRequested?.length) {
    throw new Error(`数据库表已退役，不向 Agent 开放：${hiddenRequested.join("、")}`);
  }
  const tableResult = await db.query<{ table_name: string }>(
    `SELECT c.relname AS table_name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND NOT (c.relname = ANY($2::text[]))
        AND ($1::text[] IS NULL OR c.relname = ANY($1::text[]))
      ORDER BY c.relname`,
    [requested?.length ? requested : null, HIDDEN_LEGACY_TABLES],
  );
  const tables = tableResult.rows.map((row) => row.table_name);
  if (requested?.length) {
    const missing = requested.filter((table) => !tables.includes(table));
    if (missing.length) throw new Error(`数据库表不存在：${missing.join("、")}`);
  }
  if (tables.length === 0) return [];

  const [columnResult, constraintResult, indexResult] = await Promise.all([
    db.query<RawColumn>(
      `SELECT c.relname AS table_name, a.attnum, a.attname AS name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
              NOT a.attnotnull AS nullable,
              pg_get_expr(d.adbin, d.adrelid) AS default_value,
              a.attidentity <> '' AS identity,
              a.attgenerated <> '' AS generated
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
        ORDER BY c.relname, a.attnum`,
      [tables],
    ),
    db.query<RawConstraint>(
      `SELECT c.relname AS table_name, con.conname AS name, con.contype AS type,
              con.conkey::int[] AS columns, ref.relname AS referenced_table,
              con.confkey::int[] AS referenced_columns,
              pg_get_constraintdef(con.oid, true) AS definition
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_class ref ON ref.oid = con.confrelid
        WHERE n.nspname = 'public'
        ORDER BY c.relname, con.conname`,
    ),
    db.query<RawIndex>(
      `SELECT c.relname AS table_name, idx.relname AS name, i.indisunique AS unique,
              i.indisprimary AS primary, pg_get_indexdef(i.indexrelid) AS definition,
              pg_get_expr(i.indpred, i.indrelid) AS predicate,
              ARRAY(
                SELECT pg_get_indexdef(i.indexrelid, key_no, true)
                  FROM generate_series(1, i.indnkeyatts) AS key_no
                 ORDER BY key_no
              )::text[] AS columns
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class idx ON idx.oid = i.indexrelid
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
        ORDER BY c.relname, idx.relname`,
      [tables],
    ),
  ]);

  const columnsByTable = groupByTable(columnResult.rows);
  const constraintsByTable = groupByTable(constraintResult.rows);
  const indexesByTable = groupByTable(indexResult.rows);

  const nameFor = (table: string, attnum: number): string => {
    const column = columnsByTable.get(table)?.find((item) => item.attnum === attnum);
    return column?.name ?? `attnum:${attnum}`;
  };

  return tables.map((table) => {
    const rawColumns = columnsByTable.get(table) ?? [];
    const constraints = constraintsByTable.get(table) ?? [];
    const checks = constraints
      .filter((item) => item.type === "c")
      .map((item) => ({ name: item.name, definition: item.definition }));
    const allColumns = rawColumns.map((column) => {
      const values = checks.flatMap((check) => enumValues(check.definition, column.name) ?? []);
      return {
        attnum: column.attnum,
        name: column.name,
        data_type: column.data_type,
        nullable: column.nullable,
        default_value: column.default_value,
        identity: column.identity,
        generated: column.generated,
        sensitive: isSensitive(table, column.name),
        ...(values.length ? { enum_values: [...new Set(values)] } : {}),
      };
    });
    const primary = constraints.find((item) => item.type === "p");
    const uniqueKeys = (indexesByTable.get(table) ?? [])
      .filter((index) => index.unique)
      .map((index) => ({
        name: index.name,
        columns: index.columns,
        predicate: index.predicate,
      }));
    const foreignKeys = constraints
      .filter((item) => item.type === "f" && item.referenced_table)
      .map((item) => ({
        name: item.name,
        columns: (item.columns ?? []).map((attnum) => nameFor(table, attnum)),
        referenced_table: item.referenced_table!,
        referenced_columns: (item.referenced_columns ?? []).map((attnum) =>
          nameFor(item.referenced_table!, attnum)),
      }));
    const referencedBy = constraintResult.rows
      .filter((item) => item.type === "f" && item.referenced_table === table)
      .map((item) => ({
        table: item.table_name,
        name: item.name,
        columns: (item.columns ?? []).map((attnum) => nameFor(item.table_name, attnum)),
        referenced_columns: (item.referenced_columns ?? []).map((attnum) => nameFor(table, attnum)),
      }));
    const business = businessOf(table);
    const structural = {
      table,
      columns: allColumns,
      constraints,
      indexes: indexesByTable.get(table) ?? [],
      business,
    };
    const schemaHash = sha256Json(structural);
    const visibleColumns = allColumns
      .filter((column) => !column.sensitive)
      .map(({ attnum: _attnum, sensitive: _sensitive, ...column }) => column);
    return {
      table,
      domain: business.domain,
      description: business.description,
      schema_hash: schemaHash,
      columns: visibleColumns,
      primary_key: (primary?.columns ?? []).map((attnum) => nameFor(table, attnum)),
      unique_keys: uniqueKeys,
      foreign_keys: foreignKeys,
      referenced_by: referencedBy,
      checks,
      relationships: [
        ...foreignKeys.map((item) => `${table}.${item.columns.join("+")} → ${item.referenced_table}.${item.referenced_columns.join("+")}`),
        ...referencedBy.map((item) => `${item.table}.${item.columns.join("+")} → ${table}.${item.referenced_columns.join("+")}`),
      ],
      business_constraints: business.constraints ?? [],
      write_policy: business.write_policy,
      hidden_sensitive_columns: allColumns.filter((column) => column.sensitive).length,
      all_columns: allColumns,
      indexes: indexesByTable.get(table) ?? [],
    } satisfies InternalTableSchema;
  });
}

export type DatabaseSchemaInput =
  | { operation: "list_tables"; domains?: string[]; tables?: string[] }
  | { operation: "describe_tables"; tables: Array<{ table: string; schema_hash: string }> };

export class DatabaseSchemaChangedError extends Error {
  readonly code = "DATABASE_SCHEMA_CHANGED";

  constructor(tables: string[]) {
    super(`数据库 Schema 已变化（${tables.join("、")}），本次操作未执行；请调用 database_schema.list_tables 并仅传 tables=${JSON.stringify(tables)}，再使用返回的新 hash 调用 describe_tables；不要复用旧 hash`);
    this.name = "DatabaseSchemaChangedError";
  }
}

function changedSchemaTables(
  schemas: InternalTableSchema[],
  expected: Array<{ table: string; schema_hash: string }>,
): string[] {
  const actual = new Map(schemas.map((schema) => [schema.table, schema.schema_hash]));
  return [...new Set(expected.filter((item) =>
    actual.get(item.table)?.slice(0, SCHEMA_VERSION_HEX_LENGTH) !==
      item.schema_hash.slice(0, SCHEMA_VERSION_HEX_LENGTH),
  ).map((item) => item.table))];
}

function assertSchemaHashes(
  schemas: InternalTableSchema[],
  expected: Array<{ table: string; schema_hash: string }>,
): void {
  const changed = changedSchemaTables(schemas, expected);
  if (changed.length) throw new DatabaseSchemaChangedError([...new Set(changed)]);
}

/** 轻量索引或按需完整结构；describe 发现漂移时直接返回当前结构，数据查询仍严格校验 hash。 */
export async function discoverDatabaseSchema(db: Db, rawInput: unknown): Promise<unknown> {
  const input = validateDatabaseSchemaInput(rawInput);
  if (input.operation === "list_tables") {
    const schemas = await loadSchemas(db, input.tables);
    const domains = input.domains?.map((domain) => domain.trim()).filter(Boolean);
    const filtered = domains?.length
      ? schemas.filter((schema) => domains.includes(schema.domain))
      : schemas;
    const index = filtered.map((schema) => ({
      table: schema.table,
      domain: schema.domain,
      description: schema.description,
      schema_hash: schema.schema_hash,
    }));
    return { tables: index, table_count: index.length, index_hash: sha256Json(index) };
  }
  if (input.tables.length > MAX_DESCRIBE_TABLES) {
    throw new Error(`database_schema.describe_tables 单次最多 ${MAX_DESCRIBE_TABLES} 张表`);
  }
  const names = input.tables.map((item) => item.table);
  if (new Set(names).size !== names.length) throw new Error("describe_tables.tables 存在重复表");
  const schemas = await loadSchemas(db, names);
  const refreshedTables = changedSchemaTables(schemas, input.tables);
  return {
    tables: schemas.map(({ all_columns: _all, indexes: _indexes, ...schema }) => schema),
    table_count: schemas.length,
    ...(refreshedTables.length ? {
      refreshed_tables: refreshedTables,
      refresh_note: "调用方 hash 已过期；以上为当前完整结构，后续 database_query 必须使用其中的新 schema_hash。",
    } : {}),
  };
}

export type FilterOperator =
  | "eq" | "ne" | "gt" | "gte" | "lt" | "lte"
  | "in" | "like" | "ilike" | "is_null" | "not_null";

export interface DatabaseFilter {
  column: string;
  op?: FilterOperator;
  value?: unknown;
}

export interface DatabaseSelectRequest {
  name?: string;
  table: string;
  schema_hash: string;
  columns?: string[];
  filters?: DatabaseFilter[];
  order_by?: { column: string; direction?: "asc" | "desc" }[];
  limit?: number;
  offset?: number;
  mode?: "rows" | "count";
}

export interface DatabaseQueryInput {
  queries: DatabaseSelectRequest[];
}

function assertJsonValue(value: unknown, path: string): void {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error();
  } catch {
    throw new Error(`${path} 必须是可序列化 JSON 值`);
  }
}

function columnOf(meta: InternalTableSchema, name: string): SchemaColumn {
  quoteIdent(name);
  const column = meta.all_columns.find((item) => item.name === name);
  if (!column) throw new Error(`表 ${meta.table} 不存在列：${name}`);
  if (column.sensitive) throw new Error(`列 ${meta.table}.${name} 属于敏感凭据，Agent 不可读取`);
  return column;
}

function selectColumn(meta: InternalTableSchema, name: string): string {
  const column = columnOf(meta, name);
  const quoted = quoteIdent(name);
  return column.data_type === "timestamp with time zone"
    ? `to_char(${quoted} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${quoted}`
    : quoted;
}

function buildFilters(meta: InternalTableSchema, filters: DatabaseFilter[] | undefined, params: unknown[]): string {
  if (!filters?.length) return "";
  const parts = filters.map((filter, index) => {
    columnOf(meta, filter.column);
    const column = quoteIdent(filter.column);
    const op = filter.op ?? "eq";
    const hasValue = Object.prototype.hasOwnProperty.call(filter, "value");
    if (op === "is_null" || op === "not_null") {
      if (hasValue) throw new Error(`filters[${index}] 的 ${op} 不允许提供 value`);
      return op === "is_null" ? `${column} IS NULL` : `${column} IS NOT NULL`;
    }
    if (!hasValue || filter.value === null || filter.value === undefined) {
      throw new Error(`filters[${index}] 的 ${op} 必须提供非空 value；NULL 请使用 is_null/not_null`);
    }
    if (op === "in") {
      if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 100) {
        throw new Error(`${meta.table}.${filter.column} 的 in 条件必须提供 1-100 项数组`);
      }
      filter.value.forEach((value, valueIndex) => assertJsonValue(value, `filters[${index}].value[${valueIndex}]`));
      const slots = filter.value.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `${column} IN (${slots.join(", ")})`;
    }
    if ((op === "like" || op === "ilike") && typeof filter.value !== "string") {
      throw new Error(`${meta.table}.${filter.column} 的 ${op} 条件必须是字符串`);
    }
    assertJsonValue(filter.value, `filters[${index}].value`);
    const operators: Record<string, string> = {
      eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE", ilike: "ILIKE",
    };
    const sqlOperator = operators[op];
    if (!sqlOperator) throw new Error(`不支持的过滤操作符：${op}`);
    params.push(filter.value);
    return `${column} ${sqlOperator} $${params.length}`;
  });
  return ` WHERE ${parts.join(" AND ")}`;
}

function boundedInt(value: unknown, fallback: number, max: number, label: string): number {
  const actual = value ?? fallback;
  if (!Number.isInteger(actual) || Number(actual) < 0 || Number(actual) > max) {
    throw new Error(`${label} 必须是 0-${max} 的整数`);
  }
  return Number(actual);
}

/** 每项查询执行前重算并校验对应表的 schema_hash，然后构建参数化只读 SQL。 */
export async function queryDatabase(db: Db, rawInput: unknown): Promise<unknown> {
  const input = validateDatabaseQueryInput(rawInput);
  if (!input.queries.length) throw new Error("database_query 至少需要一项查询");
  if (input.queries.length > MAX_BATCH_QUERIES) {
    throw new Error(`database_query 单次最多 ${MAX_BATCH_QUERIES} 项查询`);
  }
  const tableNames = [...new Set(input.queries.map((request) => request.table))];
  const schemas = await loadSchemas(db, tableNames);
  assertSchemaHashes(schemas, input.queries);

  const results: unknown[] = [];
  for (const request of input.queries) {
    const meta = schemas.find((schema) => schema.table === request.table)!;
    if (request.columns && new Set(request.columns).size !== request.columns.length) {
      throw new Error(`${request.table}.columns 存在重复列`);
    }
    const params: unknown[] = [];
    const where = buildFilters(meta, request.filters, params);
    if ((request.mode ?? "rows") === "count") {
      const result = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${quoteIdent(meta.table)}${where}`,
        params,
      );
      results.push({ name: request.name, table: meta.table, schema_hash: meta.schema_hash, count: Number(result.rows[0]!.count) });
      continue;
    }
    const columns = request.columns?.length
      ? request.columns
      : meta.all_columns.filter((column) => !column.sensitive).map((column) => column.name);
    columns.forEach((column) => columnOf(meta, column));
    const order = (request.order_by ?? []).map((item) => {
      columnOf(meta, item.column);
      return `${quoteIdent(item.column)} ${(item.direction ?? "asc").toUpperCase()}`;
    });
    const limit = boundedInt(request.limit, 100, MAX_QUERY_ROWS, "limit");
    const offset = boundedInt(request.offset, 0, 10_000, "offset");
    params.push(limit, offset);
    const result = await db.query(
      `SELECT ${columns.map((column) => selectColumn(meta, column)).join(", ")}
         FROM ${quoteIdent(meta.table)}${where}
        ${order.length ? `ORDER BY ${order.join(", ")}` : ""}
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    results.push({
      name: request.name,
      table: meta.table,
      schema_hash: meta.schema_hash,
      rows: result.rows,
      returned: result.rows.length,
      limit,
    });
  }
  return { queries: results, total_queries: results.length };
}

/** 系统提示词使用的轻量索引；失败由调用方降级。 */
export async function listDatabaseTableIndex(db: Db): Promise<Array<{
  table: string;
  domain: string;
  description: string;
  schema_hash: string;
}>> {
  return (await loadSchemas(db)).map((schema) => ({
    table: schema.table,
    domain: schema.domain,
    description: schema.description,
    schema_hash: schema.schema_hash,
  }));
}
