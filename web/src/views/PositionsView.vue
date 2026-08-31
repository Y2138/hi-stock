<script setup lang="ts">
// 持仓（/positions）：持仓概览、次日执行预案、持仓表（单日涨跌默认排序）与带归因的变化时间线。
// 业务事实只能由 Agent 通过领域工具写入；估值由当前持仓与最新行情派生。
import { computed, nextTick, onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { apiClient } from "../api/client";
import type {
  BarsResponse,
  DailyPlanBoard,
  DailyPlanPlaybookItem,
  Position,
  PositionChange,
  RealizedPnlSummary,
} from "../api/types";
import { CHANGE_KIND_LABELS, DECISION_ORIGIN_LABELS, EXECUTION_COMPLIANCE_LABELS } from "../api/types";
import StateBlock from "../components/StateBlock.vue";
import { useResource } from "../composables/useResource";
import { useUiRefresh } from "../composables/useUiRefresh";
import { fmtDate, fmtNum, fmtPrice, fmtTime } from "../utils/format";
import { askAi } from "../utils/askAi";


const positions = useResource<Position[]>(() => apiClient.get<Position[]>("/api/positions"));
const changes = useResource<PositionChange[]>(() =>
  apiClient.get<PositionChange[]>("/api/positions/changes?limit=100"),
);
const realizedPnl = useResource<RealizedPnlSummary>(() =>
  apiClient.get<RealizedPnlSummary>("/api/positions/realized-pnl"),
);
// 次日执行预案：来自最新每日计划的结构化盯防数据；404 = 尚无预案，不算错误。
const dailyPlan = useResource<DailyPlanBoard>(() => apiClient.get<DailyPlanBoard>("/api/plans/latest"));
const planMissing = computed(() => !dailyPlan.data.value && dailyPlan.error.value?.status === 404);
const planError = computed(() => (planMissing.value ? null : dailyPlan.error.value));
const positionActions = computed(() => dailyPlan.data.value?.position_actions ?? []);

const ACTION_LABELS: Record<DailyPlanPlaybookItem["action"], string> = {
  exit: "退出",
  reduce: "减仓",
  buy: "买入",
  hold: "持有",
  observe: "观察",
};
function triggerLabel(item: DailyPlanPlaybookItem): string {
  if (item.trigger_kind === "open") return "开盘直接执行（时间型）";
  const range = item.price_lower !== null && item.price_upper !== null
    ? `${fmtPrice(item.price_lower)} ~ ${fmtPrice(item.price_upper)}`
    : item.price_upper !== null
      ? `≤ ${fmtPrice(item.price_upper)}`
      : item.price_lower !== null
        ? `≥ ${fmtPrice(item.price_lower)}`
        : null;
  return range ? `盘中触及 ${range}` : "条件触发";
}
function triggerClass(item: DailyPlanPlaybookItem): string {
  if (item.action === "exit" || item.action === "reduce") return "down";
  if (item.action === "buy") return "up";
  return "";
}
const route = useRoute();
const focusedChangeId = computed(() => typeof route.query.change === "string" ? route.query.change : null);
const focusedChange = computed(() => (changes.data.value ?? []).find((change) => change.id === focusedChangeId.value) ?? null);
const visibleChanges = computed(() => {
  const rows = changes.data.value ?? [];
  if (!focusedChangeId.value) return rows;
  return [...rows].sort((left, right) => Number(right.id === focusedChangeId.value) - Number(left.id === focusedChangeId.value));
});

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
  { key: "pnl", label: "浮动盈亏" },
  { key: "pnlRatio", label: "收益率" },
];

const positionSummary = computed(() => {
  const list = positions.data.value ?? [];
  return {
    count: list.length,
    marketValue: list.reduce((sum, position) => sum + (position.market_value ?? 0), 0),
    pnl: list.reduce((sum, position) => sum + (position.pnl_amount ?? 0), 0),
    missingQuote: list.filter((position) => position.market_value === null).length,
  };
});

const totalMarketValue = computed(() => positionSummary.value.marketValue);

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

const attributionTooltip = ref<{ change: PositionChange; left: number; top: number; maxWidth: number } | null>(null);
const attributionTooltipElement = ref<HTMLElement | null>(null);

async function showAttributionTooltip(change: PositionChange, event: MouseEvent | FocusEvent): Promise<void> {
  const trigger = event.currentTarget;
  if (!(trigger instanceof HTMLElement)) return;
  const rect = trigger.getBoundingClientRect();
  const mainRect = trigger.closest("main")?.getBoundingClientRect();
  const maxWidth = Math.min(360, (mainRect?.width ?? window.innerWidth) - 24);
  attributionTooltip.value = { change, left: rect.left, top: rect.bottom + 8, maxWidth };
  await nextTick();
  const tooltip = attributionTooltipElement.value;
  if (!tooltip || attributionTooltip.value?.change.id !== change.id) return;
  const { width, height } = tooltip.getBoundingClientRect();
  const minLeft = (mainRect?.left ?? 0) + 12;
  const maxLeft = Math.max(minLeft, (mainRect?.right ?? window.innerWidth) - width - 12);
  attributionTooltip.value = {
    change,
    left: Math.min(Math.max(minLeft, rect.left + rect.width / 2 - width / 2), maxLeft),
    top: rect.bottom + height + 12 <= window.innerHeight ? rect.bottom + 8 : Math.max(12, rect.top - height - 8),
    maxWidth,
  };
}

function hideAttributionTooltip(event: MouseEvent | FocusEvent): void {
  if (event.type === "mouseleave" && event.currentTarget === document.activeElement) return;
  attributionTooltip.value = null;
}

function recordWithAgent(): void {
  askAi(
    "请帮我记录一笔持仓变化。先询问并核对标的代码、方向、数量、价格、日期、决策来源、执行符合度和关联计划；缺少字段不得猜测。核对完成后使用 portfolio_write 生成结构化确认提案。",
    "记录持仓变化",
    { confirmation: "打开 Agent 记录持仓变化？\n\nAgent 会先核对事实和归因，页面不会直接写入持仓。" },
  );
}

async function reloadPositionsData(): Promise<void> {
  await Promise.all([positions.reload(), changes.reload(), realizedPnl.reload(), dailyPlan.reload()]);
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

    <!-- 持仓概览：当前态指标由持仓与行情派生，已实现盈亏由卖出事件汇总。 -->
    <div class="card">
      <div class="card-title">📊 持仓概览</div>
      <StateBlock
        :loading="positions.loading.value"
        :error="positions.error.value"
        :empty="false"
        :skeleton-rows="3"
        @retry="positions.reload"
      >
        <dl class="summary-grid">
          <div><dt>持仓市值</dt><dd class="num">{{ fmtNum(positionSummary.marketValue) }} 元</dd></div>
          <div>
            <dt>浮动盈亏</dt>
            <dd
              class="num"
              :class="{ up: positionSummary.pnl > 0, down: positionSummary.pnl < 0 }"
            >{{ positionSummary.pnl >= 0 ? "+" : "" }}{{ fmtNum(positionSummary.pnl) }} 元</dd>
          </div>
          <div class="realized-summary">
            <dt>累计已实现盈亏</dt>
            <dd
              v-if="realizedPnl.data.value"
              class="num"
              :class="{ up: realizedPnl.data.value.realized_pnl > 0, down: realizedPnl.data.value.realized_pnl < 0 }"
            >{{ realizedPnl.data.value.realized_pnl >= 0 ? "+" : "" }}{{ fmtNum(realizedPnl.data.value.realized_pnl) }} 元</dd>
            <dd v-else class="num">—</dd>
            <small>成交事件口径，未计费用</small>
          </div>
          <div><dt>持仓数量</dt><dd class="num">{{ positionSummary.count }} 只</dd></div>
          <div><dt>行情缺口</dt><dd class="num" :class="{ down: positionSummary.missingQuote > 0 }">{{ positionSummary.missingQuote }} 只</dd></div>
        </dl>
        <p v-if="positionSummary.missingQuote > 0" class="card-desc">
          ⚠ {{ positionSummary.missingQuote }} 只持仓无最新收盘，持仓市值与浮动盈亏汇总不完整
        </p>
        <p v-if="realizedPnl.data.value?.missing_sell_count" class="card-desc down">
          {{ realizedPnl.data.value.missing_sell_count }} 笔基线后卖出缺少可靠成本，累计已实现盈亏不完整
        </p>
        <p v-else-if="realizedPnl.error.value" class="card-desc down">
          累计已实现盈亏读取失败：{{ realizedPnl.error.value.message }}
        </p>
      </StateBlock>
    </div>

    <!-- 次日执行预案：独立于持仓表，来自最新每日计划的结构化盯防数据（不动上方表格）。 -->
    <div class="card plan-playbook-card">
      <div class="card-title">
        🎯 次日执行预案
        <small v-if="dailyPlan.data.value" class="plan-source num">
          {{ fmtDate(dailyPlan.data.value.plan.target_date) }} 每日计划生成
        </small>
      </div>
      <StateBlock
        :loading="dailyPlan.loading.value"
        :error="planError"
        :empty="positionActions.length === 0 && !planMissing"
        empty-text="本计划没有输出持仓执行预案"
        :skeleton-rows="3"
        @retry="dailyPlan.reload"
      >
        <p v-if="planMissing" class="card-desc">每日计划尚未生成结构化预案；生成后此处展示每笔持仓的次日动作、触发价位与集合竞价/分时盯防要点。</p>
        <div v-else class="table-wrap">
          <table class="data-table playbook-table">
            <thead>
              <tr>
                <th scope="col">标的</th>
                <th scope="col">动作</th>
                <th scope="col">触发方式</th>
                <th scope="col">预案要点</th>
                <th scope="col">集合竞价预案</th>
                <th scope="col">分时盯防</th>
                <th scope="col">失效/改判条件</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in positionActions" :key="item.id">
                <td><strong>{{ item.name }}</strong><br /><small class="num">{{ item.code }}</small></td>
                <td><span class="num" :class="triggerClass(item)">{{ ACTION_LABELS[item.action] }}</span></td>
                <td><small>{{ triggerLabel(item) }}</small></td>
                <td>{{ item.headline }}</td>
                <td><small>{{ item.auction_md ?? "—" }}</small></td>
                <td><small>{{ item.intraday_md ?? "—" }}</small></td>
                <td><small>{{ item.invalidation_md ?? "—" }}</small></td>
              </tr>
            </tbody>
          </table>
        </div>
      </StateBlock>
    </div>

    <!-- 持仓表 -->
    <div class="card" style="margin-top: 16px">
      <div class="card-title position-table-title">
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
                <th>浮动盈亏</th>
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
                <td class="num">{{ fmtPrice(p.cost_price) }}</td>
                <td class="num">
                  <template v-if="p.close !== null">
                    {{ fmtPrice(p.close) }}
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
                <th>本笔已实现</th>
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
                <td class="num">{{ fmtPrice(c.price) ?? "—" }}</td>
                <td class="num">{{ c.amount === null ? "—" : fmtNum(c.amount) }}</td>
                <td class="num" :class="{ up: (c.realized_pnl ?? 0) > 0, down: (c.realized_pnl ?? 0) < 0 }">
                  <template v-if="c.kind === 'sell' && c.realized_pnl !== null">
                    {{ c.realized_pnl >= 0 ? "+" : "" }}{{ fmtNum(c.realized_pnl) }}
                    <div class="code-sub">成本 {{ fmtPrice(c.cost_price_before) }}</div>
                  </template>
                  <span v-else-if="c.kind === 'sell'" class="missing">无法计算</span>
                  <span v-else>—</span>
                </td>
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
                  <button
                    class="btn compact attribution-detail"
                    type="button"
                    :aria-label="`查看 ${c.name}的归因详情`"
                    :aria-describedby="attributionTooltip?.change.id === c.id ? 'position-attribution-tooltip' : undefined"
                    @mouseenter="showAttributionTooltip(c, $event)"
                    @mouseleave="hideAttributionTooltip"
                    @focus="showAttributionTooltip(c, $event)"
                    @blur="hideAttributionTooltip"
                    @keydown.esc="attributionTooltip = null"
                  >查看详情</button>
                </td>
                <td class="num">{{ fmtTime(c.created_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </StateBlock>
    </div>

    <Teleport to="body">
      <Transition name="attribution-tooltip">
        <div
          v-if="attributionTooltip"
          id="position-attribution-tooltip"
          ref="attributionTooltipElement"
          class="attribution-tooltip"
          role="tooltip"
          :style="{
            left: `${attributionTooltip.left}px`,
            top: `${attributionTooltip.top}px`,
            maxWidth: `${attributionTooltip.maxWidth}px`,
          }"
        >
          <strong>归因说明</strong>
          <p>{{ attributionTooltip.change.attribution_note ?? attributionTooltip.change.reason ?? "无归因说明" }}</p>
          <div v-if="attributionTooltip.change.deviation_reason" class="tooltip-deviation">
            <span>偏离原因</span>{{ attributionTooltip.change.deviation_reason }}
          </div>
          <div class="tooltip-source">
            来源：{{ attributionTooltip.change.source }}<template v-if="attributionTooltip.change.source_session_id">
              · 会话 #{{ attributionTooltip.change.source_session_id }}
            </template>
          </div>
        </div>
      </Transition>
    </Teleport>
  </section>
</template>

<style scoped>
.position-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }

.summary-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin: 0; }
.summary-grid > div { display: grid; gap: 5px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--paper-deep); }
.summary-grid dt { color: var(--ink-soft); font-size: 11.5px; }
.summary-grid dd { margin: 0; font-size: 15px; }
.realized-summary dd { font-size: 14px; white-space: nowrap; }
.realized-summary small { color: var(--ink-faint); font-size: 10.5px; }

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

.table-wrap .data-table { min-width: 1220px; table-layout: fixed; }
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
.attribution-detail { color: var(--ink-soft); cursor: help; }
.attribution-detail:hover, .attribution-detail:focus-visible { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-ink); }
.attribution-tooltip {
  position: fixed;
  z-index: 200;
  width: max-content;
  max-width: min(360px, calc(100vw - 24px));
  padding: 11px 13px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--card);
  box-shadow: var(--shadow-lift);
  color: var(--ink);
  font-size: 12px;
  line-height: 1.55;
  pointer-events: none;
}
.attribution-tooltip strong { display: block; margin-bottom: 4px; color: var(--accent-ink); }
.attribution-tooltip p { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.tooltip-deviation { display: grid; gap: 2px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); color: var(--warn); overflow-wrap: anywhere; }
.tooltip-deviation span { color: var(--ink-faint); font-size: 11px; }
.tooltip-source { margin-top: 7px; color: var(--ink-faint); font-size: 11px; }
.attribution-tooltip-enter-active, .attribution-tooltip-leave-active { transition: opacity 100ms ease, transform 100ms ease; }
.attribution-tooltip-enter-from, .attribution-tooltip-leave-to { opacity: 0; transform: translateY(3px); }
.focus-notice { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; border-color: var(--accent); background: var(--accent-soft); }
.focused-row { outline: 2px solid var(--accent); outline-offset: -2px; background: var(--accent-soft); }

@media (max-width: 700px) {
  .position-head { align-items: flex-start; flex-direction: column; }
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .position-table-title { align-items: flex-start; flex-direction: column; }
  .sort-switch { width: 100%; margin-left: 0; flex-wrap: wrap; }
}

.plan-playbook-card { margin-top: 16px; }
.plan-source { margin-left: var(--space-sm); color: var(--ink-faint); font-weight: 400; }
.playbook-table td:nth-child(n + 4) small,
.playbook-table td:nth-child(3) small { line-height: 1.5; }
</style>
