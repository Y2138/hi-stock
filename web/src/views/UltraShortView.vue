<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { apiClient } from "../api/client";
import type { UltraShortWatchlistPage, UltraShortWatchlistRow } from "../api/types";
import StateBlock from "../components/StateBlock.vue";
import { useResource } from "../composables/useResource";
import { useUiRefresh } from "../composables/useUiRefresh";
import { openMarket, useMarketDrawer } from "../composables/useMarketDrawer";
import { fmtDate, fmtNum } from "../utils/format";

const route = useRoute();
const requestedDate = computed(() => typeof route.query.date === "string" ? route.query.date : "");
const data = useResource<UltraShortWatchlistPage>(() => apiClient.get<UltraShortWatchlistPage>(
  `/api/ultra-short/watchlist${requestedDate.value ? `?date=${encodeURIComponent(requestedDate.value)}` : ""}`,
));
const selected = ref<UltraShortWatchlistRow | null>(null);
const market = useMarketDrawer();

const BRANCH_LABELS: Record<string, string> = {
  one_word: "一字延续", turnover_advance: "换手晋级", high_open: "高开过度",
  low_open: "低开分歧", weak: "走弱", insufficient: "数据不足",
};
const FILL_LABELS: Record<string, string> = { high: "成交概率高", medium: "成交概率中", low: "成交概率低", none: "不排队" };
const STATUS_LABELS: Record<string, string> = {
  waiting: "等待触发", triggered: "已触发", invalidated: "已失效", no_chase: "不追价", filled: "已成交",
};
const TRIGGER_LABELS: Record<string, string> = {
  turnover_advance: "换手晋级", long_huitou: "龙回头", dan_yang_bu_po: "单阳不破",
  n_structure: "N 字结构", online_yin: "线上阴线买",
};
const SOURCE_LABELS: Record<string, string> = {
  post_close: "收盘打板", intraday_ladder: "盘中梯队", low_buy: "低吸",
};
const REVIEW_LABELS: Record<string, string> = { pass: "复核通过", flag: "待核实", invalid: "复核不通过" };
const EXIT_LABELS: Record<string, string> = {
  holding: "持有中", exit_triggered: "已提示退出", closed: "已清仓",
};
const EXIT_REASON_LABELS: Record<string, string> = {
  hard_stop: "硬止损", board_open_weak: "开板弱回封", board_break: "炸板/断板",
  time_stop: "时间止损", target_1: "第一止盈", target_2: "第二止盈",
  take_profit_weak: "冲高回落", circuit_breaker: "熔断",
};

const rows = computed(() => data.data.value?.items ?? []);
const counts = computed(() => data.data.value?.counts);
const auctionCounts = computed(() => {
  const result = { P1: 0, P2: 0, P3: 0 };
  for (const row of rows.value) {
    if (row.auction_priority) result[row.auction_priority] += 1;
  }
  return result;
});
const auctionApplied = computed(() => rows.value.some((row) => row.auction_priority !== null));
const targetDate = computed(() => data.data.value?.target_date ?? null);
const isEmpty = computed(() => !data.loading.value && rows.value.length === 0);

const openDetail = (row: UltraShortWatchlistRow) => { selected.value = row; };
const closeDetail = () => { selected.value = null; };
function onDrawerKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && !market.open) closeDetail();
}

useUiRefresh("pools", async () => { await data.reload(); });
onMounted(() => { void data.reload(); window.addEventListener("keydown", onDrawerKeydown); });
onBeforeUnmount(() => window.removeEventListener("keydown", onDrawerKeydown));
watch(requestedDate, () => { selected.value = null; void data.reload(); });
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1>超短关注池</h1>
        <div class="sub">T 日收盘生成、T+1 竞价与开盘验证；所有条目都是关注信号，开仓由你决定 · 数据日与目标日分开标注</div>
      </div>
      <div class="head-actions">
        <span v-if="targetDate" class="quote-meta">目标日 {{ fmtDate(targetDate) }}</span>
        <button class="btn" type="button" @click="data.reload()">刷新</button>
      </div>
    </div>

    <div v-if="counts && counts.total" class="card ultra-summary">
      <span class="badge accent">共 {{ counts.total }} 只</span>
      <span class="badge">盘后 P1 {{ counts.p1 }}</span>
      <span class="badge">盘后 P2 {{ counts.p2 }}</span>
      <span class="badge">盘后 P3 {{ counts.p3 }}</span>
      <span v-if="auctionApplied" class="badge">竞价后 P1 {{ auctionCounts.P1 }} · P2 {{ auctionCounts.P2 }} · P3 {{ auctionCounts.P3 }}</span>
      <span v-if="counts.oneWord" class="badge">一字 {{ counts.oneWord }}</span>
      <span v-if="counts.triggered" class="badge warn">已触发 {{ counts.triggered }}</span>
      <span class="muted">环境结论与逐只复核见收盘打板任务结果；本页只展示结构化关注池。</span>
    </div>

    <StateBlock :loading="data.loading.value" :error="data.error.value" :skeleton-rows="6" @retry="data.reload">
      <div v-if="isEmpty" class="state-block empty">
        <strong>当前没有超短关注池</strong>
        <p>收盘打板任务完成后会生成 T+1 关注池；空池是有效结论，不为了凑数保留弱候选。</p>
      </div>
      <div v-else class="table-wrap" role="region" aria-label="超短关注池列表" tabindex="0">
        <table class="data-table ultra-table">
          <thead>
            <tr>
              <th>标的</th><th>优先级</th><th>阶段 / 高度</th><th>当前信号</th><th class="ultra-actions-col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.code" tabindex="0" @click="openDetail(row)" @keydown.enter="openDetail(row)" @keydown.space.prevent="openDetail(row)">
              <td>
                <strong>{{ row.name }}</strong>
                <div class="num code-sub">{{ row.code }}</div>
                <div v-if="row.resonance" class="muted">共振 · {{ row.data_date }}</div>
              </td>
              <td>
                <span class="badge" :class="row.priority === 'P1' ? 'accent' : row.priority === 'P2' ? '' : 'warn'">盘后 {{ row.priority }}</span>
                <span v-if="row.auction_priority && row.auction_priority !== row.priority" class="badge warn">竞价 {{ row.auction_priority }}</span>
              </td>
              <td>
                <div>{{ row.stage ?? "—" }}</div>
                <div class="muted">{{ row.streak_count ? `${row.streak_count} 板` : "—" }}</div>
              </td>
              <td>
                <span class="badge">{{ row.auction_branch ? BRANCH_LABELS[row.auction_branch] : "待判定" }}</span>
                <span class="badge" :class="row.intraday_status === 'triggered' ? 'accent' : row.intraday_status === 'invalidated' ? 'warn' : ''">{{ STATUS_LABELS[row.intraday_status] ?? row.intraday_status }}</span>
                <div v-if="row.trigger_price !== null" class="muted">触发 {{ fmtNum(row.trigger_price) }}</div>
              </td>
              <td class="ultra-actions-col">
                <button class="btn compact" type="button" @click.stop="openDetail(row)">详情</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Teleport to="body">
        <Transition name="ultra-drawer-fade">
          <div v-if="selected" class="ultra-drawer-mask" @click.self="closeDetail">
            <aside class="ultra-drawer" role="dialog" aria-modal="true" :aria-label="`${selected.name} 关注详情`">
              <header class="ultra-drawer-head">
                <div class="ultra-drawer-title">
                  <span class="eyebrow">超短关注标的</span>
                  <h2>{{ selected.name }} <span class="num">{{ selected.code }}</span></h2>
                  <p>数据日 {{ fmtDate(selected.data_date) }} · 目标日 {{ fmtDate(selected.target_date) }}<span v-if="selected.resonance"> · 三源共振</span></p>
                </div>
                <div class="ultra-drawer-head-actions">
                  <span class="badge" :class="selected.priority === 'P1' ? 'accent' : selected.priority === 'P2' ? '' : 'warn'">盘后 {{ selected.priority }}</span>
                  <span v-if="selected.auction_priority && selected.auction_priority !== selected.priority" class="badge warn">竞价 {{ selected.auction_priority }}</span>
                  <span class="badge" :class="selected.review_status === 'flag' || selected.review_status === 'invalid' ? 'warn' : ''">{{ REVIEW_LABELS[selected.review_status] }}</span>
                  <button class="ultra-drawer-close" type="button" aria-label="关闭详情" @click="closeDetail">×</button>
                </div>
              </header>

              <div class="ultra-drawer-body">
                <div class="ultra-drawer-actions">
                  <button class="btn compact primary" type="button" @click="openMarket(selected.code, selected.name)">📈 查看行情</button>
                  <span class="muted">所有结论都是关注信号，开仓由你决定</span>
                </div>

                <section class="ultra-drawer-section">
                  <h3>盘后优先级依据</h3>
                  <p>{{ selected.priority_reason }}</p>
                </section>

                <section class="ultra-drawer-section">
                  <h3>竞价与盘中</h3>
                  <dl class="ultra-kv">
                    <div><dt>竞价分支</dt><dd>{{ selected.auction_branch ? BRANCH_LABELS[selected.auction_branch] : "待判定" }}<span v-if="selected.auction_priority"> · {{ selected.auction_priority }}</span></dd></div>
                    <div><dt>成交概率</dt><dd>{{ selected.auction_fill_tier ? FILL_LABELS[selected.auction_fill_tier] : "—" }}</dd></div>
                    <div><dt>盘中状态</dt><dd>{{ STATUS_LABELS[selected.intraday_status] ?? selected.intraday_status }}</dd></div>
                    <div><dt>触发</dt><dd>{{ selected.trigger_type ? `${TRIGGER_LABELS[selected.trigger_type] ?? selected.trigger_type}${selected.trigger_price === null ? "" : ` @ ${fmtNum(selected.trigger_price)}`}` : "—" }}</dd></div>
                  </dl>
                  <p v-if="selected.auction_note" class="ultra-note"><span>竞价结论</span>{{ selected.auction_note }}</p>
                  <p v-if="selected.intraday_note" class="ultra-note"><span>盘中结论</span>{{ selected.intraday_note }}</p>
                </section>

                <section class="ultra-drawer-section">
                  <h3>关键价位</h3>
                  <dl class="ultra-kv ultra-levels">
                    <div><dt>前收</dt><dd class="num">{{ selected.key_levels.prev_close === null || selected.key_levels.prev_close === undefined ? "—" : fmtNum(selected.key_levels.prev_close) }}</dd></div>
                    <div><dt>涨停</dt><dd class="num">{{ selected.key_levels.limit_up_price === null || selected.key_levels.limit_up_price === undefined ? "—" : fmtNum(selected.key_levels.limit_up_price) }}</dd></div>
                    <div><dt>止损</dt><dd class="num">{{ selected.key_levels.stop_price === null || selected.key_levels.stop_price === undefined ? "按总风控" : fmtNum(selected.key_levels.stop_price) }}</dd></div>
                    <div><dt>MA5</dt><dd class="num">{{ selected.key_levels.ma5 === null || selected.key_levels.ma5 === undefined ? "—" : fmtNum(selected.key_levels.ma5) }}</dd></div>
                    <div><dt>MA10</dt><dd class="num">{{ selected.key_levels.ma10 === null || selected.key_levels.ma10 === undefined ? "—" : fmtNum(selected.key_levels.ma10) }}</dd></div>
                    <div><dt>MA20</dt><dd class="num">{{ selected.key_levels.ma20 === null || selected.key_levels.ma20 === undefined ? "—" : fmtNum(selected.key_levels.ma20) }}</dd></div>
                    <div><dt>失效位</dt><dd class="num">{{ selected.key_levels.invalidation_price === null || selected.key_levels.invalidation_price === undefined ? "—" : fmtNum(selected.key_levels.invalidation_price) }}</dd></div>
                    <div><dt>突破位</dt><dd class="num">{{ selected.key_levels.breakout_price === null || selected.key_levels.breakout_price === undefined ? "—" : fmtNum(selected.key_levels.breakout_price) }}</dd></div>
                  </dl>
                </section>

                <section class="ultra-drawer-section">
                  <h3>来源与标签</h3>
                  <div class="ultra-tags">
                    <span v-for="source in selected.sources" :key="source" class="badge accent">{{ SOURCE_LABELS[source] ?? source }}</span>
                    <span v-for="tag in selected.tags" :key="tag" class="badge">{{ tag }}</span>
                  </div>
                </section>

                <section class="ultra-drawer-section">
                  <h3>复核与风险</h3>
                  <p v-if="selected.review_note" class="ultra-note">{{ selected.review_note }}</p>
                  <div class="ultra-tags">
                    <span class="badge" :class="selected.risk_level === 'high' ? 'warn' : ''">风险 {{ selected.risk_level === "unknown" ? "待核" : selected.risk_level }}</span>
                    <span v-for="flag in selected.risk_flags" :key="flag" class="badge warn">{{ flag }}</span>
                  </div>
                  <p v-if="selected.gaps.length" class="ultra-note"><span>数据缺口</span>{{ selected.gaps.join("；") }}</p>
                </section>

                <section v-if="selected.exit_status !== 'none'" class="ultra-drawer-section">
                  <h3>持仓与退出</h3>
                  <dl class="ultra-kv">
                    <div><dt>状态</dt><dd>{{ EXIT_LABELS[selected.exit_status] ?? selected.exit_status }}</dd></div>
                    <div><dt>入场价</dt><dd class="num">{{ selected.entry_price === null ? "—" : fmtNum(selected.entry_price) }}</dd></div>
                    <div><dt>退出原因</dt><dd>{{ selected.exit_reason ? EXIT_REASON_LABELS[selected.exit_reason] ?? selected.exit_reason : "—" }}</dd></div>
                    <div><dt>已实现 R</dt><dd class="num">{{ selected.realized_r === null ? "—" : selected.realized_r.toFixed(2) }}</dd></div>
                  </dl>
                </section>
              </div>
            </aside>
          </div>
        </Transition>
      </Teleport>
    </StateBlock>
  </section>
</template>

<style scoped>
.ultra-summary { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.ultra-actions-col { width: 72px; text-align: right; }
.ultra-drawer-mask { position:fixed; inset:0; z-index:1100; display:flex; justify-content:flex-end; background:color-mix(in srgb, var(--ink) 22%, transparent); backdrop-filter:blur(2px); }
.ultra-drawer { width:min(520px, 94vw); height:100%; overflow-y:auto; background:var(--paper); border-left:1px solid var(--line); box-shadow:var(--shadow-lift); }
.ultra-drawer-head { position:sticky; top:0; z-index:2; display:flex; align-items:flex-start; justify-content:space-between; gap:14px; padding:18px 20px 14px; background:color-mix(in srgb, var(--paper) 92%, transparent); backdrop-filter:blur(12px); border-bottom:1px solid var(--line); }
.ultra-drawer-title { min-width:0; }
.ultra-drawer-title h2 { margin:5px 0 3px; font-size:22px; line-height:1.2; letter-spacing:-.02em; }
.ultra-drawer-title h2 span { margin-left:6px; color:var(--ink-faint); font-size:11px; font-weight:400; letter-spacing:0; }
.ultra-drawer-title p { margin:0; color:var(--ink-faint); font-size:11px; }
.ultra-drawer-head-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
.ultra-drawer-close { width:30px; height:30px; border:1px solid var(--line); border-radius:50%; background:var(--card); color:var(--ink-soft); font-size:19px; line-height:1; cursor:pointer; }
.ultra-drawer-close:hover { border-color:var(--accent); color:var(--accent-ink); }
.ultra-drawer-body { padding:14px 20px 30px; display:grid; gap:14px; }
.ultra-drawer-actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.ultra-drawer-section { border-top:1px solid color-mix(in srgb, var(--line) 75%, transparent); padding-top:12px; }
.ultra-drawer-section:first-of-type { border-top:0; padding-top:0; }
.ultra-drawer-section h3 { margin:0 0 8px; color:var(--ink-faint); font-size:10.5px; letter-spacing:.1em; font-weight:600; }
.ultra-drawer-section p { margin:0; line-height:1.7; font-size:12.5px; color:var(--ink-soft); }
.ultra-kv { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:7px 14px; margin:0; }
.ultra-kv > div { min-width:0; }
.ultra-kv dt { color:var(--ink-faint); font-size:10.5px; }
.ultra-kv dd { margin:2px 0 0; font-size:12.5px; color:var(--ink); overflow-wrap:anywhere; }
.ultra-levels { grid-template-columns:repeat(4, minmax(0,1fr)); }
.ultra-note { margin-top:8px !important; }
.ultra-note span { display:block; color:var(--ink-faint); font-size:10.5px; margin-bottom:2px; }
.ultra-tags { display:flex; gap:5px; flex-wrap:wrap; }
.ultra-drawer-fade-enter-active, .ultra-drawer-fade-leave-active { transition:opacity .18s var(--ease); }
.ultra-drawer-fade-enter-active .ultra-drawer, .ultra-drawer-fade-leave-active .ultra-drawer { transition:transform .22s var(--ease); }
.ultra-drawer-fade-enter-from, .ultra-drawer-fade-leave-to { opacity:0; }
.ultra-drawer-fade-enter-from .ultra-drawer, .ultra-drawer-fade-leave-to .ultra-drawer { transform:translateX(28px); }
@media (max-width:640px) { .ultra-drawer { width:100%; } .ultra-drawer-head, .ultra-drawer-body { padding-inline:14px; } .ultra-levels { grid-template-columns:repeat(2, minmax(0,1fr)); } }
</style>
