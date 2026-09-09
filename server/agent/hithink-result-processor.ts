// 扶摇临时结果的确定性处理层：完整扫描后再过滤、排序、投影并限制模型输出体积。
import { HITHINK_RESULT_FIELD_PATTERN, type HithinkCapabilityDefinition } from "../datasource/hithink-capabilities.js";

const FIELD_RE = new RegExp(HITHINK_RESULT_FIELD_PATTERN);
const MAX_RESULT_BYTES = 60 * 1024;
const MAX_AVAILABLE_FIELDS = 100;

export type HithinkFilterOperator =
  | "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "contains" | "is_null" | "not_null";

export interface HithinkResultOptions {
  collection?: string;
  select?: string[];
  where?: Array<{ field: string; op: HithinkFilterOperator; value?: unknown }>;
  order_by?: Array<{ field: string; direction?: "asc" | "desc" }>;
  offset?: number;
  limit?: number;
}

function pathValue(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function compare(left: unknown, right: unknown): number {
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), "zh-CN", { numeric: true });
}

function matches(row: Record<string, unknown>, filter: NonNullable<HithinkResultOptions["where"]>[number]): boolean {
  const actual = pathValue(row, filter.field);
  switch (filter.op) {
    case "is_null": return actual == null;
    case "not_null": return actual != null;
    case "eq": return actual === filter.value;
    case "ne": return actual !== filter.value;
    case "gt": return actual != null && compare(actual, filter.value) > 0;
    case "gte": return actual != null && compare(actual, filter.value) >= 0;
    case "lt": return actual != null && compare(actual, filter.value) < 0;
    case "lte": return actual != null && compare(actual, filter.value) <= 0;
    case "in": return Array.isArray(filter.value) && filter.value.some((value) => actual === value);
    case "contains": return typeof actual === "string" && typeof filter.value === "string"
      && actual.toLowerCase().includes(filter.value.toLowerCase());
  }
}

function selectFields(row: Record<string, unknown>, fields: string[] | undefined): Record<string, unknown> {
  if (!fields?.length) return row;
  return Object.fromEntries(fields.map((field) => [field, pathValue(row, field)]));
}

function availableFields(rows: Record<string, unknown>[]): string[] {
  const fields = new Set<string>();
  for (const row of rows.slice(0, 100)) {
    for (const key of Object.keys(row)) fields.add(key);
    if (fields.size >= MAX_AVAILABLE_FIELDS) break;
  }
  return [...fields].sort().slice(0, MAX_AVAILABLE_FIELDS);
}

function compactMeta(payload: Record<string, unknown>, collections: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key, value]) =>
    !collections.includes(key) && key !== "presigned_url" && !Array.isArray(value),
  ));
}

function resultBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function processHithinkResult(
  definition: HithinkCapabilityDefinition,
  payload: Record<string, unknown>,
  options: HithinkResultOptions = {},
): Record<string, unknown> {
  const collection = options.collection ?? definition.defaultCollection;
  if (!collection || !definition.collections.includes(collection)) {
    throw new Error(`${definition.name} 的 collection 必须是：${definition.collections.join("、") || "无可查询集合"}`);
  }
  const rawRows = payload[collection];
  if (!Array.isArray(rawRows)) throw new Error(`${definition.name} 响应缺少数组 ${collection}`);
  const rows = rawRows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${definition.name}.${collection}[${index}] 不是对象`);
    }
    return row as Record<string, unknown>;
  });
  const knownFields = new Set(availableFields(rows));
  const requestedFields = [
    ...(options.select ?? []),
    ...(options.where ?? []).map((item) => item.field),
    ...(options.order_by ?? []).map((item) => item.field),
  ];
  for (const field of requestedFields) {
    if (!FIELD_RE.test(field)) throw new Error(`结果字段路径非法：${field}`);
    if (rows.length > 0 && !rows.some((row) => pathValue(row, field) !== undefined)) {
      throw new Error(`结果中不存在字段：${field}`);
    }
  }
  for (const filter of options.where ?? []) {
    if (["is_null", "not_null"].includes(filter.op)) {
      if (filter.value !== undefined && filter.value !== null) throw new Error(`${filter.op} 不接受 value`);
    } else if (filter.value === undefined || filter.value === null) {
      throw new Error(`${filter.op} 必须提供非空 value`);
    }
    if (filter.op === "in" && (!Array.isArray(filter.value) || filter.value.length < 1 || filter.value.length > 100)) {
      throw new Error("in 的 value 必须是1-100项数组");
    }
  }

  let matched = rows.filter((row) => (options.where ?? []).every((filter) => matches(row, filter)));
  const orderBy = options.order_by ?? [];
  if (orderBy.length) {
    matched = [...matched].sort((left, right) => {
      for (const order of orderBy) {
        const leftValue = pathValue(left, order.field);
        const rightValue = pathValue(right, order.field);
        // 缺失值无论升降序均排最后，不能让未披露估值成为“最低估”候选。
        if (leftValue == null && rightValue != null) return 1;
        if (rightValue == null && leftValue != null) return -1;
        const compared = compare(leftValue, rightValue);
        if (compared !== 0) return order.direction === "desc" ? -compared : compared;
      }
      return 0;
    });
  }
  const offset = options.offset ?? 0;
  const requestedLimit = options.limit ?? 100;
  const selected = matched.slice(offset, offset + requestedLimit).map((row) => selectFields(row, options.select));
  const base = {
    capability: definition.name,
    collection,
    meta: compactMeta(payload, definition.collections),
    scanned_count: rows.length,
    matched_count: matched.length,
    offset,
    complete_scope: "current_response",
    pagination_note: "complete/next_offset 仅表示本次上游响应的结果分页，不证明全市场、板块或时间窗已完整覆盖；上游分页需修改 parameters，不能仅修改 result.offset。",
    available_fields: [...knownFields],
  };
  while (selected.length > 0 && resultBytes({ ...base, items: selected }) > MAX_RESULT_BYTES) selected.pop();
  if (selected.length === 0 && matched.length > offset) {
    throw new Error(`单行结果超过 ${MAX_RESULT_BYTES} 字节，请使用 select 只保留必要字段`);
  }
  const nextOffset = offset + selected.length;
  const complete = nextOffset >= matched.length;
  return {
    ...base,
    returned_count: selected.length,
    complete,
    ...(complete ? {} : {
      next_offset: nextOffset,
      remaining_count: matched.length - nextOffset,
      truncation_reason: selected.length < Math.min(requestedLimit, Math.max(matched.length - offset, 0))
        ? `结果超过 ${MAX_RESULT_BYTES} 字节，已在对象边界缩减本页`
        : "还有后续结果；使用 next_offset 继续读取",
    }),
    items: selected,
  };
}
