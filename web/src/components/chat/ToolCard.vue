<script setup lang="ts">
// 工具卡片：名称/参数摘要/状态/结果摘要（可展开）；写类工具挂确认卡（确认/拒绝 → 已确认/已拒绝/已过期）
// 产品方案 §6.3：确认卡须把提案 payload 完整呈现给用户判断（AI 不出买卖建议，只登记用户要求）。
import { computed } from "vue";
import { CHANGE_KIND_LABELS, TOOL_LABELS } from "../../api/types";
import { prettyJson } from "../../utils/format";
import { resultRefsOfTool } from "../../utils/results";
import type { UiToolCall } from "../../utils/chat";
import ResultLink from "../ResultLink.vue";

const props = defineProps<{ tool: UiToolCall }>();
const emit = defineEmits<{ (e: "decide", action: "approve" | "reject"): void }>();

const label = computed(() => TOOL_LABELS[props.tool.name] ?? props.tool.name);
const resultRefs = computed(() => resultRefsOfTool(props.tool));

/** 参数摘要：一行 key: value（截断），完整 JSON 在展开区 */
const argsSummary = computed(() => {
  const args = props.tool.args;
  if (!args || Object.keys(args).length === 0) return null;
  if (args.operation === "list_tables") return "读取轻量数据库表索引";
  if (args.operation === "describe_tables" && Array.isArray(args.tables)) return `发现 ${args.tables.length} 张表的完整结构`;
  if (Array.isArray(args.requests) || Array.isArray(args.financial_requests)) {
    const market = Array.isArray(args.requests) ? args.requests.length : 0;
    const financial = Array.isArray(args.financial_requests) ? args.financial_requests.length : 0;
    return `批量 ${market + financial} 项数据请求${financial ? ` · 财务估值 ${financial}` : ""}`;
  }
  if (Array.isArray(args.queries)) return `批量 ${args.queries.length} 项数据库查询`;
  if (typeof args.action === "string") return `${args.action}${typeof args.code === "string" ? ` · ${args.code}` : ""}`;
  const text = Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
  return text.length > 96 ? `${text.slice(0, 96)}…` : text;
});

const RESULT_PREVIEW = 240;

const resultData = computed<Record<string, unknown> | null>(() => {
  if (!props.tool.resultText) return null;
  try {
    const parsed = JSON.parse(props.tool.resultText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
});

/** 批量结果先显示人可读摘要，完整 JSON 默认折叠。 */
const resultSummary = computed(() => {
  const data = resultData.value;
  if (!data) return null;
  if (data.mode === "yolo") {
    const preview = data.preview as Record<string, unknown> | undefined;
    return `YOLO 已通过${preview?.domain ?? "领域"} service 执行 · ${preview?.action ?? "写入"}`;
  }
  const summary = data.summary as Record<string, unknown> | undefined;
  if (summary && typeof summary.total === "number") {
    return `共 ${summary.total} 项 · 已完成 ${summary.completed ?? summary.total} · 成功 ${summary.succeeded ?? 0} · 失败 ${summary.failed ?? 0} · 写入 ${summary.rows_written ?? 0} 行`;
  }
  if (typeof data.total_queries === "number") {
    const queries = Array.isArray(data.queries) ? data.queries : [];
    const rows = queries.reduce((sum, item) => {
      if (!item || typeof item !== "object") return sum;
      const row = item as Record<string, unknown>;
      return sum + (typeof row.returned === "number" ? row.returned : 0);
    }, 0);
    return `已完成 ${data.total_queries} 项数据库查询 · 返回 ${rows} 行`;
  }
  if (typeof data.total === "number" && Array.isArray(data.items)) {
    const gaps = data.items.reduce((sum, item) => {
      if (!item || typeof item !== "object") return sum;
      const row = item as Record<string, unknown>;
      return sum + (Array.isArray(row.data_gaps) ? row.data_gaps.length : 0);
    }, 0);
    return `已完成 ${data.total} 项复合分析 · 数据缺口 ${gaps} 项`;
  }
  if (typeof data.total === "number" && Array.isArray(data.runs)) {
    return `已提交 ${data.total} 项服务回测 · 当前 ${data.status === "queued" ? "排队中" : String(data.status ?? "待查询")}`;
  }
  if (Array.isArray(data.tables)) {
    const described = data.tables.some((table) => table && typeof table === "object" && Array.isArray((table as Record<string, unknown>).columns));
    return `${described ? "数据库表结构" : "数据库轻量索引"} · ${data.tables.length} 张表`;
  }
  const preview = data.preview as Record<string, unknown> | undefined;
  if (preview && typeof preview.domain === "string") {
    return `${preview.domain}写入提案 · ${preview.action ?? "变更"}`;
  }
  return null;
});

const resultLong = computed(
  () => (props.tool.resultText?.length ?? 0) > RESULT_PREVIEW,
);
const resultShown = computed(() => {
  const text = props.tool.resultText;
  if (!text) return null;
  if (resultSummary.value && !props.tool.expanded) return null;
  if (props.tool.expanded || !resultLong.value) return text;
  return `${text.slice(0, RESULT_PREVIEW)}…`;
});

/** 提案 payload 键中文名（未收录的键原样展示） */
const PAYLOAD_KEY_LABELS: Record<string, string> = {
  code: "标的代码",
  kind: "方向",
  quantity: "数量（股）",
  price: "价格（元）",
  change_date: "成交日期",
  reason: "变更原因/备注",
  action: "动作",
  pool: "标的池",
  role: "角色",
  grade: "分级",
  score: "评分",
  tags: "标签",
  effective_from: "生效日",
  note: "说明",
  name: "名称",
  target_date: "目标日",
  trigger_kind: "触发方式",
  summary: "摘要",
  engine_path: "引擎路径",
  config_snapshot: "配置快照",
  input_manifest: "输入清单",
  output_dir: "产物目录",
  report_path: "报告路径",
  metrics: "指标",
  notes: "备注",
  group_name: "分组",
  run_id: "运行 ID",
  status: "状态",
};

/** 提案 payload → 完整键值行（确认卡必须呈现全部变更内容） */
const payloadRows = computed(() => {
  const payload = props.tool.confirmation?.payload;
  if (!payload || typeof payload !== "object") return [];
  return Object.entries(payload as Record<string, unknown>).map(([key, value]) => ({
    key,
    label: PAYLOAD_KEY_LABELS[key] ?? key,
    display:
      key === "kind" && typeof value === "string"
        ? (CHANGE_KIND_LABELS[value] ?? value)
        : typeof value === "object"
          ? (prettyJson(value) ?? "—")
          : String(value),
  }));
});

const CONF_STATUS_LABEL: Record<string, string> = {
  approved: "已确认",
  rejected: "已拒绝",
  expired: "已过期",
};
</script>

<template>
  <div class="tool-card" :class="{ failed: tool.status === 'error' }">
    <div class="tool-head">
      <span class="dot" :class="tool.status === 'running' ? 'warn breath' : tool.status === 'error' ? 'bad' : 'ok'"></span>
      <span class="tool-name">{{ label }}</span>
      <span class="tool-raw num">{{ tool.name }}</span>
      <span class="badge" :class="tool.status === 'running' ? 'warn' : tool.status === 'error' ? 'bad' : 'ok'">
        {{ tool.status === "running" ? "运行中" : tool.status === "error" ? "失败" : "完成" }}
      </span>
    </div>
    <div v-if="argsSummary" class="tool-args num" :title="prettyJson(tool.args) ?? ''">{{ argsSummary }}</div>

    <div v-if="resultSummary" class="tool-summary">{{ resultSummary }}</div>

    <div v-if="resultRefs.length" class="result-links">
      <ResultLink v-for="result in resultRefs" :key="`${result.type}:${result.id}`" :result="result" />
    </div>

    <pre v-if="resultShown" class="tool-result">{{ resultShown }}</pre>
    <button
      v-if="tool.resultText && (resultLong || resultSummary)"
      class="expand-btn"
      type="button"
      @click="tool.expanded = !tool.expanded"
    >{{ tool.expanded ? "收起结果" : "展开完整结果" }}</button>

    <!-- 确认卡：pending 可决策，其余呈现终态 -->
    <div v-if="tool.confirmation" class="confirm-zone" :class="tool.confirmation.status">
      <template v-if="tool.confirmation.status === 'pending'">
        <div class="confirm-title">⚠ 该写操作等待你确认后才生效</div>
        <dl v-if="payloadRows.length" class="kv payload-kv">
          <template v-for="row in payloadRows" :key="row.key">
            <dt>{{ row.label }}</dt>
            <dd>{{ row.display }}</dd>
          </template>
        </dl>
        <pre v-else class="tool-result">{{ prettyJson(tool.confirmation.payload) }}</pre>
        <div class="confirm-actions">
          <button
            class="btn primary"
            type="button"
            :disabled="tool.confirmation.acting"
            @click="emit('decide', 'approve')"
          >{{ tool.confirmation.acting ? "处理中…" : "确认执行" }}</button>
          <button
            class="btn"
            type="button"
            :disabled="tool.confirmation.acting"
            @click="emit('decide', 'reject')"
          >拒绝</button>
        </div>
      </template>
      <div v-else class="confirm-final">
        <span class="badge" :class="tool.confirmation.status === 'approved' ? 'ok' : tool.confirmation.status === 'rejected' ? 'bad' : 'warn'">
          {{ CONF_STATUS_LABEL[tool.confirmation.status] }}
        </span>
        <span class="confirm-final-text">
          {{ tool.confirmation.status === "approved" ? "变更已写入台账" : tool.confirmation.status === "rejected" ? "未执行任何写入" : "超过 24 小时未处理，已失效" }}
        </span>
      </div>
      <p v-if="tool.confirmation.error" class="confirm-error">{{ tool.confirmation.error }}</p>
    </div>
  </div>
</template>

<style scoped>
/* 气泡内的内联工具条：不再是独立卡片，用左侧竖线与次级字号区分行为 */
.tool-card {
  border: none;
  border-left: 2px solid var(--line);
  border-radius: 0;
  background: transparent;
  padding: 2px 0 2px 10px;
  margin: 6px 0;
  font-size: var(--fs-sm);
}

.tool-card.failed {
  border-left-color: var(--up);
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-name {
  font-weight: 600;
}

.tool-raw {
  color: var(--ink-faint);
  font-size: 11px;
}

.tool-head .badge {
  margin-left: auto;
}

.tool-args {
  color: var(--ink-soft);
  font-size: 11.5px;
  margin-top: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-result {
  background: var(--paper-deep);
  border-radius: 8px;
  padding: 8px 10px;
  margin: 8px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 320px;
  overflow-y: auto;
}

.tool-summary {
  margin-top: 8px;
  border-radius: 8px;
  background: var(--paper-deep);
  padding: 8px 10px;
  color: var(--ink-soft);
  line-height: 1.5;
}

.result-links { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }

.expand-btn {
  border: none;
  background: none;
  color: var(--accent-strong);
  font-size: 11.5px;
  cursor: pointer;
  padding: 4px 0 0;
  font-family: var(--font-body);
}

.confirm-zone {
  margin-top: 10px;
  border-top: 1px dashed var(--line);
  padding-top: 10px;
}

/* 待确认写操作是气泡内唯一需要决策的区域，保留醒目的暖色底块 */
.confirm-zone.pending {
  border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--warn) 7%, transparent);
  padding: 8px 10px;
}

.confirm-title {
  color: var(--warn);
  font-weight: 600;
  font-size: 12.5px;
  margin-bottom: 8px;
}

.payload-kv {
  grid-template-columns: 88px 1fr;
  font-size: 12.5px;
}

.confirm-actions {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.confirm-final {
  display: flex;
  align-items: center;
  gap: 8px;
}

.confirm-final-text {
  color: var(--ink-soft);
  font-size: 12px;
}

.confirm-error {
  color: var(--bad);
  font-size: 12px;
  margin: 8px 0 0;
}
</style>
