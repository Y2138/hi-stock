<script setup lang="ts">
// 持仓（/positions）：持仓概览、次日执行预案、持仓表（单日涨跌默认排序）与带归因的变化时间线。
// 业务事实只能由 Agent 通过领域工具写入；估值由当前持仓与最新行情派生。
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { apiClient } from "../api/client";
import type {
  BarsResponse,
  AuctionScopeBoard,
  DailyPlanBoard,
  DailyPlanKeyLevel,
  DailyPlanPlaybookItem,
  DailyPlanScenarioKind,
  IntradayRiskRow,
  IntradayRiskSnapshot,
  Position,
  PositionChange,
  RealizedPnlSummary,
} from "../api/types";
import { CHANGE_KIND_LABELS, DECISION_ORIGIN_LABELS, EXECUTION_COMPLIANCE_LABELS } from "../api/types";
import StateBlock from "../components/StateBlock.vue";
import MarkdownView from "../components/MarkdownView.vue";
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
const auctionScope = useResource<AuctionScopeBoard>(() => apiClient.get<AuctionScopeBoard>("/api/auction/latest"));
const intradayRisk = useResource<IntradayRiskSnapshot>(() => apiClient.get<IntradayRiskSnapshot>("/api/intraday-risk"));
const intradayRiskByCode = computed(() => new Map((intradayRisk.data.value?.positions ?? []).map((item) => [item.code, item])));
const riskLabel: Record<IntradayRiskRow["risk"], string> = { normal: "正常", watch: "关注", high: "风险" };
const riskClass: Record<IntradayRiskRow["risk"], string> = { normal: "", watch: "warn", high: "down" };
let intradayRiskTimer: number | null = null;
const positionAuctionRows = computed(() => (auctionScope.data.value?.items ?? []).filter((item) => item.scope_kind === "position"));
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
const ENTRY_SIGNAL_LABELS: Record<string, string> = {
  one_word_continue: "一字延续",
  turnover_advance: "换手晋级",
  divergence: "分歧验证",
  legacy_observe: "历史观察",
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

const SCENARIO_LABELS: Record<DailyPlanScenarioKind, string> = {
  surge_reversal: "冲高回落",
  open_plunge: "开盘下砸",
  wide_swing: "全天宽幅波动",
  strong_continuation: "强势延续",
  weak_breakdown: "弱势破位",
};

function tPlanText(item: DailyPlanPlaybookItem): string {
  const plan = item.t_plan;
  if (!plan) return "—";
  if ("skip_reason" in plan) return "不设";
  return `${fmtPrice(plan.buy_lower)}~${fmtPrice(plan.buy_upper)} 低吸 / ${fmtPrice(plan.sell_lower)}~${fmtPrice(plan.sell_upper)} 兑现`;
}

function levelClass(level: DailyPlanKeyLevel): string {
  return level.kind;
}

// ---- 预案详情抽屉：列表保持紧凑，关键点位、情景矩阵与做T点位在抽屉内展开。 ----
const detailItem = ref<DailyPlanPlaybookItem | null>(null);

function openItemDetail(item: DailyPlanPlaybookItem): void {
  detailItem.value = item;
}

function closeItemDetail(): void {
  detailItem.value = null;
}

function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && detailItem.value) closeItemDetail();
}

window.addEventListener("keydown", onDialogKeydown);
onUnmounted(() => window.removeEventListener("keydown", onDialogKeydown));

function hasWatchMd(item: DailyPlanPlaybookItem): boolean {
  return Boolean(item.auction_md || item.intraday_md || item.invalidation_md || item.risk_md || item.evidence_md || item.missing_md);
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
const positionKeyword = ref("");
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
  const query = positionKeyword.value.trim().toLocaleLowerCase();
  const list = (positions.data.value ?? []).filter((position) =>
    [position.name, position.code].some((value) => value.toLocaleLowerCase().includes(query)));
  const keyFn = (p: Position): number => {
    switch (sortKey.value) {
      case "dayAbs":
        return dayChange[p.instrument_id] == null ? Number.NEGATIVE_INFINITY : Math.abs(dayChange[p.instrument_id]!);
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
    "请帮我记录一笔持仓变化。先询问并核对标的代码、方向、数量、价格、日期、决策来源、执行符合度和关联计划；买入必须确定管理策略（波段/两年结构反转/打板/自主决策等），已有持仓只能沿用同一策略加仓，缺少字段不得猜测。核对完成后使用 portfolio_write 生成结构化确认提案。",
    "记录持仓变化",
    { confirmation: "打开 Agent 记录持仓变化？\n\nAgent 会先核对事实和归因，页面不会直接写入持仓。" },
  );
}

async function reloadPositionsData(): Promise<void> {
  await Promise.all([positions.reload(), changes.reload(), realizedPnl.reload(), dailyPlan.reload(), auctionScope.reload(), intradayRisk.reload()]);
  await loadDayChanges(positions.data.value ?? []);
}

useUiRefresh("positions", reloadPositionsData);
onMounted(async () => {
  await reloadPositionsData();
  intradayRiskTimer = window.setInterval(() => void intradayRisk.reload(), 30_000);
});
onUnmounted(() => {
  if (intradayRiskTimer !== null) window.clearInterval(intradayRiskTimer);
});
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

    <div class="card intraday-risk-card" style="margin-top:16px">
      <div class="card-title">
        盘中风险观察
        <small v-if="intradayRisk.data.value?.sample_at" class="plan-source num">最近采样 {{ fmtTime(intradayRisk.data.value.sample_at) }}</small>
      </div>
      <StateBlock
        :loading="intradayRisk.loading.value"
        :error="intradayRisk.error.value"
        :empty="false"
        :skeleton-rows="2"
        @retry="intradayRisk.reload"
      >
        <div v-if="intradayRisk.data.value" class="intraday-risk-summary">
          <span class="badge" :class="{ warn: intradayRisk.data.value.positions.some((item) => item.risk === 'watch'), down: intradayRisk.data.value.positions.some((item) => item.risk === 'high') }">
            {{ intradayRisk.data.value.positions.filter((item) => item.risk === "high").length }} 个风险 ·
            {{ intradayRisk.data.value.positions.filter((item) => item.risk === "watch").length }} 个关注
          </span>
          <span class="code-sub">{{ intradayRisk.data.value.running ? "交易时段观察中" : "非交易时段" }} · 数据{{ intradayRisk.data.value.data_status === "ready" ? "正常" : "不完整" }}</span>
        </div>
        <div v-if="intradayRisk.data.value?.positions.some((item) => item.risk !== 'normal')" class="intraday-risk-list">
          <div v-for="item in intradayRisk.data.value.positions.filter((row) => row.risk !== 'normal')" :key="item.code" class="intraday-risk-line">
            <strong>{{ item.name }}</strong><span class="num code-sub">{{ item.code }}</span>
            <span class="badge" :class="riskClass[item.risk]">{{ riskLabel[item.risk] }}</span>
            <span>{{ item.reason }}</span><span v-if="item.key_level" class="num">关键位 {{ item.key_level }}</span>
          </div>
        </div>
        <p v-else class="card-desc">当前没有需要提醒的持仓风险。模型只在风险状态变化时提醒。</p>
      </StateBlock>
    </div>

    <!-- 次日执行预案：独立于持仓表，来自最新每日计划的结构化盯防数据（不动上方表格）。 -->
    <div class="card plan-playbook-card">
      <div class="card-title">
        🎯 执行预案
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
        <p v-if="planMissing" class="card-desc">每日计划尚未生成结构化预案；盘前生成后此处展示每笔持仓的开盘动作、触发价位、做 T 点位与情景预案。</p>
        <div v-else class="table-wrap">
          <table class="data-table clickable playbook-table">
            <thead>
              <tr>
                <th scope="col">标的</th>
                <th scope="col">策略 / 动作</th>
                <th scope="col">触发方式</th>
                <th scope="col">预案要点</th>
                <th scope="col">做 T 点位</th>
                <th scope="col">情景</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="item in positionActions"
                :key="item.id"
                class="playbook-row"
                tabindex="0"
                :aria-label="`查看 ${item.name} 预案详情`"
                @click="openItemDetail(item)"
                @keydown.enter="openItemDetail(item)"
              >
                <td><strong>{{ item.name }}</strong><br /><small class="num">{{ item.code }}</small></td>
                <td>
                  <RouterLink v-if="item.strategy_code" class="badge accent" :to="{ path: '/strategies', query: { strategy: item.strategy_code } }">{{ item.strategy_code }} ↗</RouterLink>
                  <span class="num" :class="triggerClass(item)">{{ ACTION_LABELS[item.effective_action ?? item.action] }}</span>
                  <div class="code-sub">主 {{ item.primary_action ? ACTION_LABELS[item.primary_action] : "—" }} · 兜底 {{ item.fallback_action ? ACTION_LABELS[item.fallback_action] : "—" }}</div>
                  <span v-if="item.evaluation_status" class="badge" :class="{ warn:item.evaluation_status !== 'success' }">{{ item.evaluation_status === 'success' ? '评估完整' : item.evaluation_status === 'waiting' ? '评估中' : '待补齐' }}</span>
                </td>
                <td><small>{{ triggerLabel(item) }}</small></td>
                <td>{{ item.headline }}</td>
                <td><small class="num">{{ tPlanText(item) }}</small></td>
                <td>
                  <span v-if="(item.scenarios ?? []).length" class="badge accent num">{{ item.scenarios!.length }} 情景</span>
                  <small v-else class="missing">未写入</small>
                </td>
              </tr>
            </tbody>
          </table>
          <p class="card-desc" style="margin-top: 8px">点击行查看该持仓的关键点位、情景预案与做 T 详情。</p>
        </div>
      </StateBlock>
    </div>

    <div v-if="positionAuctionRows.length" class="card" style="margin-top:16px">
      <div class="card-title">竞价持仓复核 · {{ fmtDate(auctionScope.data.value?.target_date) }}</div>
      <div v-for="item in positionAuctionRows" :key="item.id" class="auction-position-row">
        <strong>{{ item.name }} · {{ item.strategy_name ?? item.strategy_code ?? "待归因" }}</strong>
        <span class="badge" :class="{ warn:item.conclusion !== 'plan_aligned' }">{{ item.conclusion === 'plan_aligned' ? '原预案匹配' : item.conclusion === 'risk_alert' ? '竞价风险升级' : '数据不足' }}</span>
        <small>{{ item.assessment_summary }} · {{ item.metrics_summary }}</small>
      </div>
    </div>

    <!-- 持仓表 -->
    <div class="card" style="margin-top: 16px">
      <div class="card-title position-table-title">
        <span>持仓明细</span>
        <span class="sort-switch">
          排序：
          <button
            v-for="opt in SORT_OPTIONS"
            :key="opt.key"
            class="btn sort-btn"
            :class="{ primary: sortKey === opt.key }"
            :aria-pressed="sortKey === opt.key"
            type="button"
            @click="sortKey = opt.key"
          >{{ opt.label }}</button>
        </span>
      </div>
      <div class="list-filter">
        <input v-model="positionKeyword" type="search" aria-label="筛选持仓" placeholder="筛选持仓名称或代码" />
        <span class="list-filter-count" role="status">显示 {{ sortedPositions.length }} / {{ positions.data.value?.length ?? 0 }} 只</span>
        <button v-if="positionKeyword" class="btn compact" type="button" @click="positionKeyword = ''">清空筛选</button>
      </div>
      <StateBlock
        :loading="positions.loading.value"
        :error="positions.error.value"
        :empty="(positions.data.value?.length ?? 0) === 0"
        empty-text="当前无持仓"
        :skeleton-rows="5"
        @retry="positions.reload"
      >
        <p v-if="sortedPositions.length === 0" class="state-block empty">没有匹配的持仓，请更换关键词或清空筛选。</p>
        <div v-else class="table-wrap">
          <table class="data-table">
            <colgroup>
              <col class="position-name"><col span="10"><col class="position-attribution">
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
                <th>盘中风险</th>
                <th>管理策略</th>
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
                <td>
                  <template v-if="intradayRiskByCode.get(p.code)">
                    <span class="badge" :class="riskClass[intradayRiskByCode.get(p.code)!.risk]">{{ riskLabel[intradayRiskByCode.get(p.code)!.risk] }}</span>
                    <div class="code-sub risk-reason">{{ intradayRiskByCode.get(p.code)!.reason }}</div>
                  </template>
                  <span v-else class="missing">待观察</span>
                </td>
                <td>
                  <RouterLink v-if="p.strategy_code" class="badge accent" :to="{ path: '/strategies', query: { strategy: p.strategy_code } }">{{ p.strategy_name ?? p.strategy_code }} ↗</RouterLink>
                  <span v-else class="missing">待归因</span>
                  <div v-if="p.fallback_strategy_code" class="code-sub">兜底：<RouterLink :to="{ path: '/strategies', query: { strategy: p.fallback_strategy_code } }">{{ p.fallback_strategy_name ?? p.fallback_strategy_code }} ↗</RouterLink></div>
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
                <td>
                  <span class="badge" :class="{ accent: c.kind === 'buy', warn: c.kind === 'sell' }">{{ CHANGE_KIND_LABELS[c.kind] ?? c.kind }}</span>
                  <RouterLink v-if="c.kind === 'buy' && c.strategy_code" class="badge accent" :to="{ path: '/strategies', query: { strategy: c.strategy_code } }">{{ c.strategy_code }} ↗</RouterLink>
                  <span v-else-if="c.kind === 'buy'" class="missing">策略未记录</span>
                </td>
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
                  <div v-if="c.entry_auction_assessment_id">
                    打板信号 {{ fmtDate(c.entry_signal_date) }} · {{ ENTRY_SIGNAL_LABELS[c.entry_signal_review_type ?? ""] ?? c.entry_signal_review_type }}
                  </div>
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
    <!-- 预案详情抽屉：关键点位、情景矩阵、做T与盯防叙述完整展开，避免压进列表列。 -->
    <Teleport to="body">
      <Transition name="drawer-fade">
        <div v-if="detailItem" class="playbook-detail-mask" @click.self="closeItemDetail">
          <aside class="playbook-detail-panel drawer" role="dialog" aria-modal="true" :aria-label="`${detailItem.name}（${detailItem.code}）预案详情`">
            <header class="playbook-detail-head">
              <div class="playbook-detail-title">
                <strong>{{ detailItem.name }}</strong>
                <span class="num code-sub">{{ detailItem.code }}</span>
                <span class="num" :class="triggerClass(detailItem)">{{ ACTION_LABELS[detailItem.effective_action ?? detailItem.action] }}</span>
                <RouterLink v-if="detailItem.strategy_code" class="badge accent" :to="{ path: '/strategies', query: { strategy: detailItem.strategy_code } }">{{ detailItem.strategy_code }} ↗</RouterLink>
                <RouterLink class="btn compact detail-quote-link" :to="{ path: '/market', query: { code: detailItem.code, view: 'detail' } }">📈 查看行情</RouterLink>
              </div>
              <button class="detail-close" type="button" aria-label="关闭预案详情" @click="closeItemDetail">×</button>
            </header>
            <div class="playbook-detail-scroll">
              <dl class="detail-overview">
                <div><dt>触发方式</dt><dd>{{ triggerLabel(detailItem) }}</dd></div>
                <div><dt>主 / 兜底动作</dt><dd>主 {{ detailItem.primary_action ? ACTION_LABELS[detailItem.primary_action] : "—" }} · 兜底 {{ detailItem.fallback_action ? ACTION_LABELS[detailItem.fallback_action] : "—" }}</dd></div>
                <div><dt>评估状态</dt><dd>{{ detailItem.evaluation_status === "success" ? "评估完整" : detailItem.evaluation_status === "waiting" ? "评估中" : "待补齐" }}<template v-if="detailItem.evaluation_data_date"> · 数据日 {{ fmtDate(detailItem.evaluation_data_date) }}</template></dd></div>
                <div><dt>预案要点</dt><dd>{{ detailItem.headline }}</dd></div>
              </dl>
              <details v-if="detailItem.evaluation_missing.length" class="evaluation-gaps">
                <summary>计划生成时的缺口 · {{ detailItem.evaluation_missing.length }} 项</summary>
                <ul><li v-for="gap in detailItem.evaluation_missing" :key="gap">{{ gap }}</li></ul>
              </details>

              <section class="detail-section">
                <h4>关键点位</h4>
                <div v-if="detailItem.key_levels.length" class="level-chips">
                  <span v-for="level in detailItem.key_levels" :key="`${level.label}-${level.price}`" class="level-chip" :class="levelClass(level)">
                    <small>{{ level.label }}</small>
                    <b class="num">{{ fmtPrice(level.price) }}</b>
                  </span>
                </div>
                <p v-else class="card-desc">本计划未写入关键点位（旧版数据）。</p>
              </section>

              <section class="detail-section">
                <h4>做 T 预案</h4>
                <template v-if="detailItem.t_plan && 'buy_lower' in detailItem.t_plan">
                  <div class="t-zones">
                    <span class="t-zone down">低吸 {{ fmtPrice(detailItem.t_plan.buy_lower) }} ~ {{ fmtPrice(detailItem.t_plan.buy_upper) }}</span>
                    <span class="t-zone up">兑现 {{ fmtPrice(detailItem.t_plan.sell_lower) }} ~ {{ fmtPrice(detailItem.t_plan.sell_upper) }}</span>
                  </div>
                  <p class="t-note"><b>确认条件：</b>{{ detailItem.t_plan.confirm_md }}</p>
                  <p class="t-note"><b>取消条件：</b>{{ detailItem.t_plan.cancel_md }}</p>
                </template>
                <p v-else-if="detailItem.t_plan && 'skip_reason' in detailItem.t_plan" class="card-desc">不设做 T：{{ detailItem.t_plan.skip_reason }}</p>
                <p v-else class="card-desc">本计划未写入做 T 预案（旧版数据）。</p>
              </section>

              <section class="detail-section">
                <h4>情景预案</h4>
                <div v-if="(detailItem.scenarios ?? []).length" class="table-wrap scenario-wrap">
                  <table class="data-table scenario-table">
                    <thead>
                      <tr>
                        <th scope="col">情景</th>
                        <th scope="col">可观测触发</th>
                        <th scope="col">应对</th>
                        <th scope="col">失效条件</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="scenario in detailItem.scenarios" :key="scenario.id">
                        <td><span class="badge">{{ SCENARIO_LABELS[scenario.scenario_kind] ?? scenario.scenario_kind }}</span></td>
                        <td><small>{{ scenario.observable_md }}</small></td>
                        <td><small>{{ scenario.response_md }}</small></td>
                        <td><small>{{ scenario.invalidation_md }}</small></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p v-else class="card-desc">本计划未写入情景预案（旧版数据）。</p>
              </section>

              <section v-if="hasWatchMd(detailItem)" class="detail-section">
                <h4>盯防与风险</h4>
                <div v-if="detailItem.auction_md" class="md-field">
                  <h5>集合竞价预案</h5>
                  <MarkdownView :source="detailItem.auction_md" />
                </div>
                <div v-if="detailItem.intraday_md" class="md-field">
                  <h5>分时盯防</h5>
                  <MarkdownView :source="detailItem.intraday_md" />
                </div>
                <div v-if="detailItem.invalidation_md" class="md-field">
                  <h5>失效 / 改判条件</h5>
                  <MarkdownView :source="detailItem.invalidation_md" />
                </div>
                <div v-if="detailItem.risk_md" class="md-field">
                  <h5>主要风险</h5>
                  <MarkdownView :source="detailItem.risk_md" />
                </div>
                <div v-if="detailItem.evidence_md" class="md-field">
                  <h5>评估证据</h5>
                  <MarkdownView :source="detailItem.evidence_md" />
                </div>
                <div v-if="detailItem.missing_md" class="md-field">
                  <h5>数据缺口</h5>
                  <MarkdownView :source="detailItem.missing_md" />
                </div>
              </section>
            </div>
          </aside>
        </div>
      </Transition>
    </Teleport>
  </section>
</template>

<style scoped>
.evaluation-gaps{margin-top:6px;font-size:var(--fs-sm);color:var(--warn)}
.evaluation-gaps summary{cursor:pointer}
.evaluation-gaps ul{margin:6px 0;padding-left:16px;min-width:180px;white-space:normal;overflow-wrap:anywhere}
.evaluation-gaps li+li{margin-top:4px}
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
/* 覆盖上方 .table-wrap .data-table 的 1220px 通用宽度：紧凑预案表不需要横向滚动。 */
.table-wrap .playbook-table { min-width: 960px; }
.playbook-table td small { line-height: 1.5; }
.playbook-row { cursor: pointer; }

/* ---- 预案详情抽屉 ---- */
.playbook-detail-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  justify-content: flex-end;
  background: var(--overlay);
}
.playbook-detail-panel {
  display: grid;
  width: min(1040px, 96vw);
  height: 100%;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  background: var(--paper);
  border-left: 1px solid var(--line);
  box-shadow: var(--shadow-lift);
  overscroll-behavior: contain;
}
.playbook-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
}
.playbook-detail-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.detail-quote-link { margin-left: 4px; font-size: 12px; }
.detail-quote-link:hover, .detail-quote-link:focus-visible { border-color: var(--accent); color: var(--accent-ink); }
.detail-close {
  flex: none;
  width: 30px;
  height: 30px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--card);
  color: var(--ink-soft);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}
.detail-close:hover, .detail-close:focus-visible { border-color: var(--accent); color: var(--accent-ink); }
.playbook-detail-scroll { overflow: auto; padding: 14px 18px 22px; }
.detail-overview {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
}
.detail-overview > div { display: grid; gap: 4px; padding: 9px 11px; border-radius: var(--radius-sm); background: var(--paper-deep); }
.detail-overview > div:last-child { grid-column: 1 / -1; }
.detail-overview dt { color: var(--ink-soft); font-size: 11.5px; }
.detail-overview dd { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.detail-section { margin-top: 16px; }
.detail-section h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--accent-ink);
  border-bottom: 1px solid var(--line);
  padding-bottom: 6px;
}
/* 关键点位强制单行：点位数量偶尔超出时横向滚动兜底，不折行。 */
.level-chips { display: flex; flex-wrap: nowrap; gap: 6px; overflow-x: auto; padding-bottom: 2px; }
.level-chip {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--paper-deep);
  white-space: nowrap;
  flex: none;
}
.level-chip small { color: var(--ink-faint); font-size: 10.5px; }
.level-chip b { font-size: 14px; }
.level-chip.resistance b { color: var(--up); }
.level-chip.support b { color: var(--down); }
.t-zones { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 8px; }
.t-zone {
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.t-zone.down { background: var(--down-bg); color: var(--down); }
.t-zone.up { background: var(--up-bg); color: var(--up); }
.t-note { margin: 6px 0 0; font-size: 12.5px; color: var(--ink-soft); line-height: 1.6; overflow-wrap: anywhere; }
.scenario-wrap { margin: 0; }
.scenario-table { min-width: 760px; }
.scenario-table td small { line-height: 1.55; overflow-wrap: anywhere; }
.md-field { margin-top: 10px; }
.md-field h5 { margin: 0 0 4px; font-size: 12px; color: var(--ink-faint); }
.md-field :deep(p) { margin: 0 0 4px; font-size: 12.5px; line-height: 1.6; }

@media (max-width: 700px) {
  .playbook-detail-panel { width: 100vw; }
  .detail-overview { grid-template-columns: 1fr; }
}

.auction-position-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 0;border-top:1px solid var(--line)}
.auction-position-row small{flex-basis:100%;color:var(--ink-soft)}
.intraday-risk-summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.intraday-risk-list{display:grid;gap:6px;margin-top:10px}
.intraday-risk-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 0;border-top:1px solid var(--line);font-size:13px}
.intraday-risk-line span:nth-last-child(2){color:var(--ink-soft)}
.risk-reason{max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style>
