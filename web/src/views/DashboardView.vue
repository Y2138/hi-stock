<script setup lang="ts">
// 仪表盘（/）：先汇总数据可信度与待处理异常，再展示账户、持仓和常用入口。
// 口径：资金快照与持仓行情可能来自不同日期，页面分别标注，不混成同一时点资产。
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { apiClient } from "../api/client";
import type {
  AccountSnapshot,
  AccountSummary,
  JobDefinition,
  MarketCoverage,
  Position,
} from "../api/types";
import { FREQ_LABELS } from "../api/types";
import StateBlock from "../components/StateBlock.vue";
import { useResource } from "../composables/useResource";
import { useUiRefresh } from "../composables/useUiRefresh";
import { fmtDate, fmtNum } from "../utils/format";
import { askAi } from "../utils/askAi";

const router = useRouter();

function maintainFactsWithAgent(): void {
  askAi(
    "请先核对我要记录的成交、账户快照或标的池变化，再通过对应领域工具生成提案。不要根据页面猜测业务事实。",
    "维护业务事实",
    { confirmation: "打开 Agent 维护业务事实？\n\n页面只提供查询，写入会先由 Agent 核对。" },
  );
}

const coverage = useResource<MarketCoverage[]>(() =>
  apiClient.get<MarketCoverage[]>("/api/market/coverage"),
);
const jobs = useResource<JobDefinition[]>(() => apiClient.get<JobDefinition[]>("/api/jobs"));
const positions = useResource<Position[]>(() => apiClient.get<Position[]>("/api/positions"));
const snapshots = useResource<AccountSnapshot[]>(() =>
  apiClient.get<AccountSnapshot[]>("/api/account/snapshots"),
);
/** 实时资金摘要：台账（快照锚点+成交变动）现金 + 持仓×最新收盘派生总资金 */
const summary = useResource<AccountSummary>(() =>
  apiClient.get<AccountSummary>("/api/account/summary"),
);

const dayCoverage = computed(() => coverage.data.value?.find((c) => c.freq === "day") ?? null);

const latestSnapshot = computed(() => {
  const list = snapshots.data.value;
  return list && list.length > 0 ? list[list.length - 1]! : null;
});

const activePositions = computed(() =>
  (positions.data.value ?? []).filter((position) => position.quantity > 0),
);

const positionSummary = computed(() => {
  const list = activePositions.value;
  const valued = list.filter((position) => position.market_value !== null);
  return {
    count: list.length,
    marketValue: valued.reduce((sum, position) => sum + (position.market_value ?? 0), 0),
    pnl: list.reduce((sum, position) => sum + (position.pnl_amount ?? 0), 0),
    missingQuote: list.filter((position) => position.close === null).length,
  };
});

const largestPosition = computed(() => {
  const total = positionSummary.value.marketValue;
  const position = activePositions.value
    .filter((item) => item.market_value !== null)
    .sort((a, b) => (b.market_value ?? 0) - (a.market_value ?? 0))[0];
  if (!position || total <= 0) return null;
  return { position, ratio: (position.market_value ?? 0) / total };
});

const cashRatio = computed(() => {
  const s = summary.data.value;
  if (!s?.tracked || s.cash === null || !s.total_asset) return null;
  return s.cash / s.total_asset;
});

const coverageRows = computed(() => {
  const order = ["day", "30m", "futures_day"];
  return [...(coverage.data.value ?? [])].sort(
    (a, b) => order.indexOf(a.freq) - order.indexOf(b.freq),
  );
});

function coverageSummary(item: MarketCoverage): string {
  if (item.freq === "futures_day") return `${fmtNum(item.instrument_count)} 期货`;
  return `${fmtNum(item.stock_count)} 个股 · ${fmtNum(item.board_count)} 板块 · ${fmtNum(item.etf_count)} ETF · ${fmtNum(item.index_count)} 指数`;
}

const latestRuns = computed(() => {
  const definitions = jobs.data.value ?? [];
  return definitions
    .filter((definition) => definition.latest_run !== null)
    .map((definition) => ({ name: definition.name, code: definition.code, run: definition.latest_run! }))
    .sort((a, b) =>
      String(b.run.started_at ?? b.run.scheduled_for ?? "").localeCompare(
        String(a.run.started_at ?? a.run.scheduled_for ?? ""),
      ),
    )
    .slice(0, 4);
});

const jobsWithoutRuns = computed(
  () => (jobs.data.value ?? []).filter((definition) => definition.enabled && !definition.latest_run).length,
);

const RUN_STATUS: Record<string, { label: string; dot: string }> = {
  queued: { label: "排队中", dot: "idle breath" },
  running: { label: "运行中", dot: "ok breath" },
  success: { label: "成功", dot: "ok" },
  failed: { label: "失败", dot: "bad" },
  partial: { label: "部分成功", dot: "warn" },
  missed: { label: "已错过", dot: "warn" },
  cancelled: { label: "已中断", dot: "warn" },
};

type AttentionTone = "bad" | "warn";
interface AttentionItem {
  key: string;
  title: string;
  detail: string;
  tone: AttentionTone;
  to: string;
}

function daysBetween(from: string, to: string): number {
  const fromTime = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const toTime = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) return 0;
  return Math.max(0, Math.round((toTime - fromTime) / 86_400_000));
}

const snapshotLagDays = computed(() => {
  const snapshotDate = latestSnapshot.value?.snap_date;
  const marketDate = dayCoverage.value?.last_date;
  return snapshotDate && marketDate ? daysBetween(snapshotDate, marketDate) : 0;
});

const attentionItems = computed<AttentionItem[]>(() => {
  const items: AttentionItem[] = [];
  const loadErrors = [
    { key: "coverage", title: "行情覆盖读取失败", error: coverage.error.value, to: "/datasync" },
    { key: "jobs", title: "任务状态读取失败", error: jobs.error.value, to: "/jobs" },
    { key: "positions", title: "持仓读取失败", error: positions.error.value, to: "/positions" },
    { key: "snapshots", title: "资金快照读取失败", error: snapshots.error.value, to: "/positions" },
  ];
  for (const failure of loadErrors) {
    if (failure.error) {
      items.push({
        key: `load-${failure.key}`,
        title: failure.title,
        detail: `${failure.error.code} · 可进入对应页面重试`,
        tone: "bad",
        to: failure.to,
      });
    }
  }

  for (const definition of jobs.data.value ?? []) {
    const run = definition.latest_run;
    if (!run || !["failed", "partial", "missed", "cancelled"].includes(run.status)) continue;
    items.push({
      key: `job-${definition.code}`,
      title: `${definition.name}${RUN_STATUS[run.status]?.label ?? run.status}`,
      detail: `目标日 ${fmtDate(run.target_date) ?? "未记录"} · 查看日志和缺口后再处理`,
      tone: run.status === "failed" ? "bad" : "warn",
      to: "/jobs",
    });
  }

  if (!coverage.loading.value && !coverage.error.value && !dayCoverage.value) {
    items.push({
      key: "missing-day-coverage",
      title: "没有日线行情覆盖",
      detail: "金额与持仓涨跌暂时缺少可信的行情截止口径",
      tone: "bad",
      to: "/datasync",
    });
  }

  if (positionSummary.value.missingQuote > 0) {
    items.push({
      key: "missing-position-quotes",
      title: `${positionSummary.value.missingQuote} 只持仓缺少最新收盘`,
      detail: "相关市值与浮动盈亏不完整，先补齐行情再判断账户变化",
      tone: "bad",
      to: "/positions",
    });
  }

  if (!snapshots.loading.value && !snapshots.error.value && !latestSnapshot.value) {
    items.push({
      key: "missing-account-snapshot",
      title: "尚未记录账户资金快照",
      detail: "无法核对总资产、现金与证券市值的最新时点",
      tone: "warn",
      to: "/positions",
    });
  } else if (snapshotLagDays.value > 0) {
    items.push({
      key: "stale-account-snapshot",
      title: `账户快照落后行情 ${snapshotLagDays.value} 天`,
      detail: `资金记录 ${fmtDate(latestSnapshot.value?.snap_date) ?? "未记录"} · 日线已到 ${fmtDate(dayCoverage.value?.last_date) ?? "未记录"}`,
      tone: "warn",
      to: "/positions",
    });
  }

  return items;
});

const dashboardLoading = computed(
  () =>
    coverage.loading.value ||
    jobs.loading.value ||
    positions.loading.value ||
    snapshots.loading.value,
);

const accountLoading = computed(() => positions.loading.value || summary.loading.value);
const accountError = computed(() => positions.error.value ?? summary.error.value);
const accountEmpty = computed(
  () => !(summary.data.value?.tracked) && (positions.data.value?.length ?? 0) === 0,
);

const systemTone = computed<"loading" | "ok" | AttentionTone>(() => {
  if (dashboardLoading.value) return "loading";
  if (attentionItems.value.some((item) => item.tone === "bad")) return "bad";
  if (attentionItems.value.length > 0) return "warn";
  return "ok";
});

const systemHeadline = computed(() => {
  if (dashboardLoading.value) return "正在汇总今天的系统状态";
  if (attentionItems.value.length > 0) return `${attentionItems.value.length} 项需要关注`;
  return "今天的关键数据状态正常";
});

function money(value: number | null | undefined, precision?: "exact" | "approx"): string {
  if (value === null || value === undefined) return "—";
  return `${precision === "approx" ? "≈" : ""}${fmtNum(Math.round(value))}`;
}

function signedMoney(value: number): string {
  return `${value >= 0 ? "+" : ""}${fmtNum(Math.round(value))}`;
}

function percent(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function reloadAll(): void {
  void Promise.all([coverage.reload(), jobs.reload(), positions.reload(), snapshots.reload(), summary.reload()]);
}

useUiRefresh("dashboard", reloadAll);
onMounted(reloadAll);
</script>

<template>
  <section class="dashboard-view">
    <header class="dashboard-head">
      <div class="head-copy">
        <h1>仪表盘</h1>
        <p>先确认数据与异常，再看账户变化和下一步动作。</p>
      </div>
      <div class="head-actions" aria-label="常用操作">
        <button class="btn primary agent-entry" type="button" @click="maintainFactsWithAgent">通过 Agent 记录变化</button>
        <button class="btn" type="button" @click="router.push('/short-pool')">查看短线池</button>
        <button class="btn" type="button" @click="router.push('/jobs')">运行任务</button>
      </div>
    </header>

    <div class="status-banner" :class="systemTone" aria-live="polite">
      <span class="status-signal" aria-hidden="true">
        {{ systemTone === "ok" ? "✓" : systemTone === "loading" ? "·" : "!" }}
      </span>
      <div class="status-copy">
        <h2>{{ systemHeadline }}</h2>
        <p>
          日线 {{ fmtDate(dayCoverage?.last_date) ?? "未就绪" }}
          <span aria-hidden="true">·</span>
          资金快照 {{ fmtDate(latestSnapshot?.snap_date) ?? "未记录" }}
          <span aria-hidden="true">·</span>
          {{ positionSummary.count }} 只持仓
        </p>
      </div>
      <a v-if="attentionItems.length > 0" class="status-link" href="#dashboard-attention">
        查看待处理
      </a>
      <RouterLink v-else class="status-link" to="/datasync">查看数据明细</RouterLink>
    </div>

    <div class="primary-grid">
      <article class="card dashboard-card account-card">
        <div class="card-heading">
          <div>
            <span class="section-label">账户与持仓</span>
            <h2>关键资金状态</h2>
          </div>
          <RouterLink to="/positions">查看持仓明细</RouterLink>
        </div>
        <StateBlock
          :loading="accountLoading"
          :error="accountError"
          :empty="accountEmpty"
          empty-text="暂无账户或持仓记录"
          :skeleton-rows="3"
          @retry="reloadAll"
        >
          <div class="metric-grid">
            <div class="metric-item">
              <span class="metric-label">总资产</span>
              <strong class="num">{{ money(summary.data.value?.total_asset) }}</strong>
              <span class="metric-meta">
                {{ summary.data.value?.tracked ? `实时 · 锚定 ${fmtDate(summary.data.value.anchor_date)} 快照` : "未同步快照" }}
              </span>
            </div>
            <div class="metric-item">
              <span class="metric-label">可用现金</span>
              <strong class="num">{{ money(summary.data.value?.cash) }}</strong>
              <span class="metric-meta">
                {{ cashRatio === null ? "同步快照后启用" : `占总资产 ${percent(cashRatio)}` }}
              </span>
            </div>
            <div class="metric-item">
              <span class="metric-label">持仓市值</span>
              <strong class="num">{{ money(positionSummary.marketValue) }}</strong>
              <span class="metric-meta">{{ fmtDate(dayCoverage?.last_date) ?? "无行情" }} · {{ positionSummary.count }} 只</span>
            </div>
            <div class="metric-item">
              <span class="metric-label">浮动盈亏</span>
              <strong class="num" :class="positionSummary.pnl >= 0 ? 'up' : 'down'">
                {{ signedMoney(positionSummary.pnl) }}
              </strong>
              <span class="metric-meta">按最新持仓收盘价 · 元</span>
            </div>
          </div>
          <div v-if="largestPosition" class="account-foot">
            <span>第一大持仓</span>
            <RouterLink :to="{ path: '/market', query: { code: largestPosition.position.code, view: 'detail' } }"><strong>{{ largestPosition.position.name }}</strong></RouterLink>
            <span class="num">{{ money(largestPosition.position.market_value) }} 元</span>
            <span>占当前持仓市值 {{ percent(largestPosition.ratio) }}</span>
          </div>
        </StateBlock>
      </article>

      <article id="dashboard-attention" class="card dashboard-card attention-card">
        <div class="card-heading">
          <div>
            <span class="section-label">优先处理</span>
            <h2>需要关注</h2>
          </div>
          <span class="count-badge" :class="{ active: attentionItems.length > 0 }">
            {{ dashboardLoading ? "…" : attentionItems.length }}
          </span>
        </div>
        <StateBlock :loading="dashboardLoading" :error="null" :skeleton-rows="3">
          <div v-if="attentionItems.length === 0" class="empty-attention">
            <span class="empty-check" aria-hidden="true">✓</span>
            <div>
              <strong>暂未发现待处理异常</strong>
              <p>行情缺口、失败任务和资金快照滞后均会集中显示在这里。</p>
            </div>
          </div>
          <div v-else class="attention-list">
            <RouterLink
              v-for="item in attentionItems.slice(0, 4)"
              :key="item.key"
              :to="item.to"
              class="attention-item"
            >
              <span class="attention-marker" :class="item.tone" aria-hidden="true" />
              <span class="attention-content">
                <strong>{{ item.title }}</strong>
                <small>{{ item.detail }}</small>
              </span>
              <span class="row-arrow" aria-hidden="true">→</span>
            </RouterLink>
            <p v-if="attentionItems.length > 4" class="more-attention">
              另有 {{ attentionItems.length - 4 }} 项，可进入对应页面继续处理。
            </p>
          </div>
        </StateBlock>
      </article>
    </div>

    <article class="card dashboard-card health-card dashboard-health">
      <div class="card-heading">
        <div>
          <span class="section-label">运行健康</span>
          <h2>数据与任务</h2>
        </div>
      </div>

      <section class="health-section">
        <div class="subsection-head">
          <h3>行情覆盖</h3>
          <RouterLink to="/datasync">数据明细</RouterLink>
        </div>
        <StateBlock
          :loading="coverage.loading.value"
          :error="coverage.error.value"
          :empty="coverageRows.length === 0"
          empty-text="暂无行情数据"
          :skeleton-rows="3"
          @retry="coverage.reload"
        >
          <div class="health-list">
            <div v-for="item in coverageRows" :key="item.freq" class="coverage-row">
              <strong>{{ FREQ_LABELS[item.freq] ?? item.freq }}</strong>
              <span class="num">{{ fmtDate(item.last_date) ?? "未记录" }}</span>
              <small>{{ coverageSummary(item) }}</small>
            </div>
          </div>
        </StateBlock>
      </section>

      <section class="health-section task-section">
        <div class="subsection-head">
          <h3>最近任务</h3>
          <RouterLink to="/jobs">任务中心</RouterLink>
        </div>
        <StateBlock
          :loading="jobs.loading.value"
          :error="jobs.error.value"
          :empty="(jobs.data.value?.length ?? 0) === 0"
          empty-text="暂无系统作业"
          :skeleton-rows="3"
          @retry="jobs.reload"
        >
          <p v-if="latestRuns.length === 0" class="no-runs">尚无运行记录</p>
          <div v-else class="run-list">
            <div v-for="item in latestRuns" :key="item.code" class="run-row">
              <span class="dot" :class="RUN_STATUS[item.run.status]?.dot ?? 'idle'" />
              <span class="run-content">
                <strong>{{ item.name }}</strong>
                <small class="num">{{ fmtDate(item.run.target_date) ?? "未记录" }}</small>
              </span>
              <span class="run-status">{{ RUN_STATUS[item.run.status]?.label ?? item.run.status }}</span>
            </div>
          </div>
          <p v-if="jobsWithoutRuns > 0" class="no-runs">
            {{ jobsWithoutRuns }} 个已启用任务尚无运行记录
          </p>
        </StateBlock>
      </section>
    </article>
  </section>
</template>

<style scoped>
.dashboard-view {
  --dashboard-gap: var(--space-lg);
  min-width: 0;
}

.dashboard-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-lg);
  margin-bottom: var(--space-lg);
}

.head-copy h1 {
  font-size: 26px;
  font-weight: 750;
  letter-spacing: 0.01em;
}

.head-copy p {
  margin: 3px 0 0;
  color: var(--ink-soft);
  font-size: var(--fs-sm);
}

.head-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-sm);
  flex-wrap: wrap;
}

.head-actions .btn {
  min-height: 34px;
  padding-inline: 14px;
  white-space: nowrap;
}

.status-banner {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-md);
  min-height: 72px;
  padding: 13px 16px;
  border: 1px solid var(--line);
  border-left-width: 3px;
  border-radius: var(--radius-lg);
  background: var(--card);
}

.status-banner.ok {
  border-left-color: var(--ok);
  background: color-mix(in srgb, var(--card) 88%, var(--down-bg));
}

.status-banner.warn {
  border-left-color: var(--warn);
  background: color-mix(in srgb, var(--card) 88%, var(--warn-bg));
}

.status-banner.bad {
  border-left-color: var(--bad);
  background: color-mix(in srgb, var(--card) 89%, var(--up-bg));
}

.status-banner.loading {
  border-left-color: var(--idle);
}

.status-signal {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid currentColor;
  border-radius: 50%;
  color: var(--idle);
  font-weight: 700;
}

.status-banner.ok .status-signal {
  color: var(--ok);
}

.status-banner.warn .status-signal {
  color: var(--warn);
}

.status-banner.bad .status-signal {
  color: var(--bad);
}

.status-copy h2 {
  font-size: 16px;
  font-weight: 700;
}

.status-copy p {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin: 2px 0 0;
  color: var(--ink-soft);
  font-size: var(--fs-sm);
}

.status-link {
  font-size: var(--fs-sm);
  font-weight: 600;
  white-space: nowrap;
}

.primary-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(310px, 0.95fr);
  gap: var(--dashboard-gap);
  margin-top: var(--dashboard-gap);
  align-items: stretch;
}

.dashboard-health {
  margin-top: var(--dashboard-gap);
}

.dashboard-card {
  min-width: 0;
  padding: 18px 20px;
  overflow: hidden;
  box-shadow: none;
}

.card-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-md);
  margin-bottom: var(--space-lg);
}

.card-heading h2 {
  margin-top: 1px;
  font-size: 17px;
  font-weight: 700;
}

.card-heading > a,
.subsection-head > a {
  font-size: var(--fs-sm);
  font-weight: 600;
  white-space: nowrap;
}

.section-label {
  display: block;
  color: var(--ink-faint);
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.08em;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-sm);
}

.metric-item {
  min-width: 0;
  padding: 11px 12px;
  border: 1px solid color-mix(in srgb, var(--line) 78%, transparent);
  border-radius: var(--radius-sm);
  background: var(--paper);
}

.metric-label,
.metric-meta {
  display: block;
  color: var(--ink-soft);
  font-size: var(--fs-xs);
}

.metric-item strong {
  display: block;
  margin: 3px 0 1px;
  font-size: clamp(16px, 1.55vw, 21px);
  line-height: 1.35;
  letter-spacing: -0.03em;
  white-space: nowrap;
}

.metric-meta {
  overflow: hidden;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-foot {
  display: flex;
  align-items: center;
  gap: 6px 12px;
  flex-wrap: wrap;
  margin-top: var(--space-md);
  padding-top: var(--space-md);
  border-top: 1px solid var(--line);
  color: var(--ink-soft);
  font-size: var(--fs-sm);
}

.account-foot strong {
  color: var(--ink);
}

.count-badge {
  display: grid;
  place-items: center;
  min-width: 28px;
  height: 28px;
  padding-inline: 7px;
  border-radius: 999px;
  background: var(--paper-deep);
  color: var(--ink-soft);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
}

.count-badge.active {
  background: var(--warn-bg);
  color: var(--warn);
}

.attention-list {
  display: grid;
  gap: var(--space-sm);
}

.attention-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--paper);
  color: var(--ink);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}

.attention-item:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.attention-marker {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warn);
}

.attention-marker.bad {
  background: var(--bad);
}

.attention-content {
  min-width: 0;
}

.attention-content strong,
.attention-content small {
  display: block;
}

.attention-content strong {
  overflow: hidden;
  font-size: var(--fs-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attention-content small {
  margin-top: 1px;
  color: var(--ink-faint);
  font-size: var(--fs-xs);
  line-height: 1.45;
}

.row-arrow {
  color: var(--ink-faint);
}

.empty-attention {
  display: flex;
  align-items: flex-start;
  gap: var(--space-md);
  padding: 12px;
  border-radius: var(--radius-sm);
  background: var(--paper);
}

.empty-check {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--down-bg);
  color: var(--ok);
  font-weight: 700;
}

.empty-attention strong {
  font-size: var(--fs-sm);
}

.empty-attention p,
.more-attention,
.no-runs {
  margin: 2px 0 0;
  color: var(--ink-faint);
  font-size: var(--fs-xs);
}

.health-section + .health-section {
  margin-top: var(--space-lg);
  padding-top: var(--space-lg);
  border-top: 1px solid var(--line);
}

.subsection-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  margin-bottom: var(--space-sm);
}

.subsection-head h3 {
  font-size: var(--fs-sm);
  font-weight: 700;
}

.health-list,
.run-list {
  display: grid;
  gap: 2px;
}

.coverage-row {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-sm);
  min-height: 29px;
  padding: 2px 0;
  font-size: var(--fs-sm);
}

.coverage-row strong {
  font-size: var(--fs-sm);
}

.coverage-row .num {
  overflow: hidden;
  color: var(--ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.coverage-row small {
  color: var(--ink-faint);
  white-space: nowrap;
}

.run-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  min-height: 34px;
}

.run-content {
  min-width: 0;
}

.run-content strong,
.run-content small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-content strong {
  font-size: var(--fs-sm);
  font-weight: 600;
}

.run-content small {
  color: var(--ink-faint);
  font-size: var(--fs-xs);
}

.run-status {
  color: var(--ink-soft);
  font-size: var(--fs-xs);
  white-space: nowrap;
}

@media (max-width: 1040px) {
  .primary-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 760px) {
  .dashboard-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .head-actions {
    justify-content: flex-start;
  }

  .metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .metric-item strong {
    font-size: 18px;
  }
}

@media (max-width: 620px) {
  .status-banner {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .status-link {
    grid-column: 2;
  }

  .dashboard-card {
    padding: 16px;
  }
}

@container business (max-width: 720px) {
  .primary-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .dashboard-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .head-actions {
    justify-content: flex-start;
  }

  .metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
