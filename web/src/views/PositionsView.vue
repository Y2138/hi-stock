<script setup lang="ts">
// 持仓（/positions）：资金摘要（实时口径：台账现金+持仓市值）、持仓表（单日涨跌默认排序）、
// 账户总资产离散快照与带归因的变化时间线。业务事实只能由 Agent 通过领域工具写入。
// 口径：pnl_amount = 数量×(收盘−成本)（服务端）；单日涨跌由最新两根日线在前端计算；
// 资金摘要现金由快照锚点 + 其后成交连续维护（0019）；账户历史只有离散记录点，散点不连线（D1b）。
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { apiClient } from "../api/client";
import type {
  AccountSnapshot,
  AccountSummary,
  BarsResponse,
  Position,
  PositionChange,
} from "../api/types";
import { CHANGE_KIND_LABELS, DECISION_ORIGIN_LABELS, EXECUTION_COMPLIANCE_LABELS } from "../api/types";
import SnapshotChart from "../components/SnapshotChart.vue";
import StateBlock from "../components/StateBlock.vue";
import { useResource } from "../composables/useResource";
import { useUiRefresh } from "../composables/useUiRefresh";
import { fmtDate, fmtNum, fmtTime } from "../utils/format";
import { askAi } from "../utils/askAi";


const positions = useResource<Position[]>(() => apiClient.get<Position[]>("/api/positions"));
const changes = useResource<PositionChange[]>(() =>
  apiClient.get<PositionChange[]>("/api/positions/changes?limit=100"),
);
const snapshots = useResource<AccountSnapshot[]>(() =>
  apiClient.get<AccountSnapshot[]>("/api/account/snapshots"),
);
/** 实时资金摘要：台账（快照锚点+成交变动）现金 + 持仓×最新收盘派生市值 */
const summary = useResource<AccountSummary>(() =>
  apiClient.get<AccountSummary>("/api/account/summary"),
);
const route = useRoute();
const focusedChangeId = computed(() => typeof route.query.change === "string" ? route.query.change : null);
const focusedChange = computed(() => (changes.data.value ?? []).find((change) => change.id === focusedChangeId.value) ?? null);
const visibleChanges = computed(() => {
  const rows = changes.data.value ?? [];
  if (!focusedChangeId.value) return rows;
  return [...rows].sort((left, right) => Number(right.id === focusedChangeId.value) - Number(left.id === focusedChangeId.value));
});

function money(v: number | null | undefined, precision?: string): string {
  if (v === null || v === undefined) return "无记录";
  return `${precision === "approx" ? "≈" : ""}${v.toLocaleString("zh-CN")}`;
}

// ---- 单日涨跌：对每个有行情的持仓拉取最近日线，前端算 (收−前收)/前收 ----
const dayChange = reactive<Record<string, number | null>>({});

async function loadDayChanges(list: Position[]): Promise<void> {
  const targets = list.filter((p) => p.quantity > 0 && p.close_date);
  await Promise.all(
    targets.map(async (p) => {
      const end = p.close_date!;
      const start = fmtDate(new Date(Date.parse(`${end}T00:00:00Z`) - 20 * 86400000).toISOString());
      const r = await apiClient.get<BarsResponse>(
        `/api/market/bars?code=${encodeURIComponent(p.code)}&freq=day&start=${start}&end=${end}`,
      );
      if (!r.ok) {
        dayChange[p.instrument_id] = null;
        return;
      }
      const bars = r.data.bars;
      if (bars.length >= 2) {
        const prev = bars[bars.length - 2]!.close;
        const last = bars[bars.length - 1]!.close;
        dayChange[p.instrument_id] = prev === 0 ? null : (last - prev) / prev;
      } else {
        dayChange[p.instrument_id] = null;
      }
    }),
  );
}

// ---- 持仓表排序：默认单日涨跌绝对值降序 ----
type SortKey = "dayAbs" | "marketValue" | "pnl" | "pnlRatio";
const sortKey = ref<SortKey>("dayAbs");
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "dayAbs", label: "单日涨跌绝对值" },
  { key: "marketValue", label: "市值" },
  { key: "pnl", label: "累计盈亏" },
  { key: "pnlRatio", label: "收益率" },
];

const totalMarketValue = computed(() =>
  (positions.data.value ?? []).reduce((s, p) => s + (p.market_value ?? 0), 0),
);

const sortedPositions = computed(() => {
  const list = [...(positions.data.value ?? [])];
  const keyFn = (p: Position): number => {
    switch (sortKey.value) {
      case "dayAbs":
        return Math.abs(dayChange[p.instrument_id] ?? -1);
      case "marketValue":
        return p.market_value ?? -1;
      case "pnl":
        return p.pnl_amount ?? Number.NEGATIVE_INFINITY;
      case "pnlRatio":
        return p.pnl_ratio ?? Number.NEGATIVE_INFINITY;
    }
  };
  return list.sort((a, b) => keyFn(b) - keyFn(a));
});

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
}

function attributionText(value: Record<string, number>): string {
  const entries = Object.entries(value);
  return entries.length ? entries.map(([key, count]) => `${DECISION_ORIGIN_LABELS[key] ?? key} ${count}`).join(" · ") : "暂无已归因事件";
}

function recordWithAgent(): void {
  askAi(
    "请帮我记录一笔持仓或资金变化。先询问并核对标的代码、方向、数量、价格、日期、决策来源、执行符合度和关联计划；缺少字段不得猜测。核对完成后使用 portfolio_write 生成结构化确认提案。",
    "记录持仓变化",
    { confirmation: "打开 Agent 记录持仓或资金变化？\n\nAgent 会先核对事实和归因，页面不会直接写入持仓。" },
  );
}

async function reloadPositionsData(): Promise<void> {
  await Promise.all([positions.reload(), changes.reload(), snapshots.reload(), summary.reload()]);
  await loadDayChanges(positions.data.value ?? []);
}

useUiRefresh("positions", reloadPositionsData);
onMounted(reloadPositionsData);
</script>

<template>
  <section>
    <div class="page-head position-head">
      <h1>持仓</h1>
      <button class="btn primary agent-entry" type="button" @click="recordWithAgent">记录持仓变化</button>
    </div>

    <div v-if="focusedChange" class="card focus-notice">
      <span class="badge accent">已定位持仓变化 #{{ focusedChange.id }}</span>
      <strong>{{ focusedChange.name }}（{{ focusedChange.code }}）· {{ CHANGE_KIND_LABELS[focusedChange.kind] ?? focusedChange.kind }}</strong>
      <span>{{ fmtDate(focusedChange.change_date) }} · {{ focusedChange.attribution_note ?? focusedChange.reason ?? "无备注" }}</span>
    </div>

    <!-- 资金摘要（实时口径：台账现金 = 快照锚点 + 其后成交变动；市值按最新收盘派生） -->
    <div class="card">
      <div class="card-title">
        💰 资金摘要
        <span v-if="summary.data.value?.tracked" class="data-cutoff">
          实时 · 锚定 {{ fmtDate(summary.data.value.anchor_date) }} 快照
        </span>
      </div>
      <StateBlock
        :loading="summary.loading.value"
        :error="summary.error.value"
        :empty="false"
        :skeleton-rows="3"
        @retry="summary.reload"
      >
        <dl class="summary-grid">
          <div><dt>总资金</dt><dd class="num">{{ money(summary.data.value?.total_asset) }} 元</dd></div>
          <div><dt>证券市值</dt><dd class="num">{{ money(summary.data.value?.market_value) }} 元</dd></div>
          <div><dt>可用资金</dt><dd class="num">{{ money(summary.data.value?.cash) }} 元</dd></div>
          <div>
            <dt>清仓收益</dt>
            <dd
              class="num"
              :class="{ up: (summary.data.value?.closed_pnl ?? 0) > 0, down: (summary.data.value?.closed_pnl ?? 0) < 0 }"
            >{{ money(summary.data.value?.closed_pnl) }} 元</dd>
          </div>
        </dl>
        <p v-if="summary.data.value && !summary.data.value.tracked" class="card-desc">
          尚未同步资金快照：可用资金与总资金待同步券商口径后启用；记录成交会自动联动现金
        </p>
        <p v-else-if="(summary.data.value?.missing_quote ?? 0) > 0" class="card-desc">
          ⚠ {{ summary.data.value?.missing_quote }} 只持仓无最新收盘，市值与总资金偏小
        </p>
      </StateBlock>
    </div>

    <!-- 持仓表 -->
    <div class="card" style="margin-top: 16px">
      <div class="card-title">
        📋 持仓表
        <span class="sort-switch">
          排序：
          <button
            v-for="opt in SORT_OPTIONS"
            :key="opt.key"
            class="btn sort-btn"
            :class="{ primary: sortKey === opt.key }"
            type="button"
            @click="sortKey = opt.key"
          >{{ opt.label }}</button>
        </span>
      </div>
      <StateBlock
        :loading="positions.loading.value"
        :error="positions.error.value"
        :empty="(positions.data.value?.length ?? 0) === 0"
        empty-text="当前无持仓"
        :skeleton-rows="5"
        @retry="positions.reload"
      >
        <div class="table-wrap">
          <table class="data-table">
            <colgroup>
              <col class="position-name"><col span="8"><col class="position-attribution">
            </colgroup>
            <thead>
              <tr>
                <th>标的</th>
                <th>数量</th>
                <th>成本</th>
                <th>最新收盘</th>
                <th>单日涨跌</th>
                <th>市值</th>
                <th>累计盈亏</th>
                <th>收益率</th>
                <th>占比</th>
                <th>本轮持仓归因构成</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in sortedPositions" :key="p.instrument_id">
                <td>
                  <RouterLink :to="{ path: '/market', query: { code: p.code, view: 'detail' } }">{{ p.name }}</RouterLink>
                  <div class="num code-sub">{{ p.code }}</div>
                </td>
                <td class="num">{{ fmtNum(p.quantity) }}</td>
                <td class="num">{{ p.cost_price }}</td>
                <td class="num">
                  <template v-if="p.close !== null">
                    {{ p.close }}
                    <div class="code-sub num">{{ fmtDate(p.close_date) }}</div>
                  </template>
                  <span v-else class="missing">无行情</span>
                </td>
                <td class="num" :class="{ up: (dayChange[p.instrument_id] ?? 0) > 0, down: (dayChange[p.instrument_id] ?? 0) < 0 }">
                  <template v-if="dayChange[p.instrument_id] !== undefined && dayChange[p.instrument_id] !== null">
                    {{ (dayChange[p.instrument_id] ?? 0) >= 0 ? "▲" : "▼" }}
                    {{ pct(dayChange[p.instrument_id]) }}
                  </template>
                  <span v-else>—</span>
                </td>
                <td class="num">{{ p.market_value === null ? "—" : fmtNum(p.market_value) }}</td>
                <td class="num" :class="{ up: (p.pnl_amount ?? 0) > 0, down: (p.pnl_amount ?? 0) < 0 }">
                  {{ p.pnl_amount === null ? "—" : `${p.pnl_amount >= 0 ? "+" : ""}${fmtNum(p.pnl_amount)}` }}
                </td>
                <td class="num" :class="{ up: (p.pnl_ratio ?? 0) > 0, down: (p.pnl_ratio ?? 0) < 0 }">
                  {{ pct(p.pnl_ratio) }}
                </td>
                <td class="num">
                  {{ p.market_value === null || totalMarketValue === 0 ? "—"
                     : `${((p.market_value / totalMarketValue) * 100).toFixed(1)}%` }}
                </td>
                <td class="attribution-cell">{{ attributionText(p.attribution_breakdown) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="card-desc" style="margin-top: 8px">
          盈亏口径：数量 ×（最新收盘 − 成本）；单日涨跌由最近两根日线计算；完全清仓后从当前持仓表移除，历史成交仍保留在变化时间线。
        </p>
      </StateBlock>
    </div>

    <!-- 账户总资产离散快照 -->
    <div class="card" style="margin-top: 16px">
      <div class="card-title">📉 账户总资产离散快照</div>
      <StateBlock
        :loading="snapshots.loading.value"
        :error="snapshots.error.value"
        :empty="(snapshots.data.value?.length ?? 0) === 0"
        empty-text="暂无账户快照记录"
        :skeleton-rows="4"
        @retry="snapshots.reload"
      >
        <SnapshotChart :snapshots="snapshots.data.value ?? []" :height="280" />
      </StateBlock>
    </div>

    <!-- 变化时间线 -->
    <div class="card" style="margin-top: 16px">
      <div class="card-title">🕘 持仓变化时间线（{{ changes.data.value?.length ?? "…" }}）</div>
      <StateBlock
        :loading="changes.loading.value"
        :error="changes.error.value"
        :empty="(changes.data.value?.length ?? 0) === 0"
        empty-text="暂无变更记录"
        :skeleton-rows="5"
        @retry="changes.reload"
      >
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>标的</th>
                <th>类型</th>
                <th>数量</th>
                <th>价格</th>
                <th>金额</th>
                <th>决策来源 / 执行</th>
                <th>策略 / 计划</th>
                <th>归因说明</th>
                <th>记录时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in visibleChanges" :key="c.id" :class="{ 'focused-row': c.id === focusedChangeId }">
                <td class="num">{{ fmtDate(c.change_date) }}</td>
                <td><RouterLink :to="{ path: '/market', query: { code: c.code, view: 'detail' } }">{{ c.name }}</RouterLink> <span class="num code-sub">{{ c.code }}</span></td>
                <td><span class="badge" :class="{ accent: c.kind === 'buy', warn: c.kind === 'sell' }">{{ CHANGE_KIND_LABELS[c.kind] ?? c.kind }}</span></td>
                <td class="num">{{ c.quantity === null ? "—" : fmtNum(c.quantity) }}</td>
                <td class="num">{{ c.price ?? "—" }}</td>
                <td class="num">{{ c.amount === null ? "—" : fmtNum(c.amount) }}</td>
                <td>
                  <span class="badge" :class="{ warn: c.decision_origin === 'unplanned_exception' || c.execution_compliance === 'deviated' }">{{ DECISION_ORIGIN_LABELS[c.decision_origin] }}</span>
                  <span class="badge">{{ EXECUTION_COMPLIANCE_LABELS[c.execution_compliance] }}</span>
                </td>
                <td class="num">
                  <div>策略序号 {{ c.strategy_change_seq ?? "—" }}</div>
                  <div v-if="c.plan_output_id">计划 #{{ c.plan_output_id }} · {{ fmtDate(c.plan_target_date) }}</div>
                  <div v-else>未关联计划</div>
                </td>
                <td>
                  <div>{{ c.attribution_note ?? c.reason ?? "—" }}</div>
                  <div v-if="c.deviation_reason" class="deviation">偏离原因：{{ c.deviation_reason }}</div>
                  <div class="code-sub">{{ c.source }}<template v-if="c.source_session_id"> · 会话 #{{ c.source_session_id }}</template></div>
                </td>
                <td class="num">{{ fmtTime(c.created_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </StateBlock>
    </div>
  </section>
</template>

<style scoped>
.position-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }

.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0; }
.summary-grid > div { display: grid; gap: 5px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--paper-deep); }
.summary-grid dt { color: var(--ink-soft); font-size: 11.5px; }
.summary-grid dd { margin: 0; font-size: 15px; }

.sort-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  font-size: 12px;
  color: var(--ink-faint);
  font-weight: 400;
}

.sort-btn {
  padding: 2px 10px;
  font-size: 11.5px;
}

.table-wrap {
  overflow-x: auto;
}

.table-wrap .data-table { min-width: 1100px; table-layout: fixed; }
.position-name { width: 130px; }
.position-attribution { width: 190px; }

.code-sub {
  font-size: 11px;
  color: var(--ink-faint);
}

.missing {
  color: var(--warn);
  font-size: 12px;
}
.attribution-cell { min-width: 180px; color: var(--ink-soft); }
.deviation { margin-top: 4px; color: var(--warn); }
.focus-notice { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; border-color: var(--accent); background: var(--accent-soft); }
.focused-row { outline: 2px solid var(--accent); outline-offset: -2px; background: var(--accent-soft); }

@media (max-width: 700px) {
  .position-head { align-items: flex-start; flex-direction: column; }
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
