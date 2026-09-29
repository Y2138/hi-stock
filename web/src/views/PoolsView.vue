<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient } from "../api/client";
import type { AuctionScopeBoard, Instrument, PoolAttentionEntry, PoolMember, PoolViewData } from "../api/types";
import InstrumentPicker from "../components/InstrumentPicker.vue";
import StateBlock from "../components/StateBlock.vue";
import PoolResearch from "../components/PoolResearch.vue";
import { useResource } from "../composables/useResource";
import { useUiRefresh } from "../composables/useUiRefresh";
import { appMessage } from "../stores/message";
import { askAi } from "../utils/askAi";
import { fmtDate, fmtNum } from "../utils/format";
import { attentionSourceLabel, attentionStatusLabel, compareAttentionQuality } from "../utils/poolAttention";

const router = useRouter();
const route = useRoute();
const selected = ref("attention");
const keyword = ref("");
const detailMember = ref<PoolMember | null>(null);
const removingAttention = ref<string | null>(null);
const data = useResource<PoolViewData>(() => apiClient.get<PoolViewData>("/api/pools"));
const auctionScope = useResource<AuctionScopeBoard>(() => apiClient.get<AuctionScopeBoard>("/api/auction/latest"));
const auctionForEntry = (entry: PoolAttentionEntry) => (auctionScope.data.value?.items ?? []).find((item) =>
  item.scope_kind === "attention" && item.attention_entry_id === entry.id);
const AUCTION_CONCLUSION_LABELS: Record<string, string> = {
  confirmed: "条件已确认", wait: "继续等待", give_up: "放弃", unavailable: "数据不足",
};
const focusedMemberCode = computed(() => typeof route.query.member === "string" ? route.query.member : null);
const focusedMember = computed(() => (data.data.value?.members ?? []).find((member) => member.code === focusedMemberCode.value) ?? null);

const isAttention = (member: PoolMember) => member.attention_entries.length > 0;
const etfCount = computed(() => (data.data.value?.members ?? []).filter((member) => member.kind === "etf").length);
const displayIndustries = (member: PoolMember) => {
  const secondary = member.boards.filter((board) => board.level === "secondary");
  return secondary.length ? secondary : member.boards.filter((board) => board.level === "primary");
};
const categoryMembers = computed(() => {
  const members = data.data.value?.members ?? [];
  if (selected.value === "all") {
    return focusedMemberCode.value
      ? [...members].sort((left, right) => Number(right.code === focusedMemberCode.value) - Number(left.code === focusedMemberCode.value))
      : members;
  }
  if (selected.value === "attention") return members.filter(isAttention).sort(compareAttentionQuality);
  if (selected.value === "etf") return members.filter((member) => member.kind === "etf");
  if (selected.value === "unclassified") return members.filter((member) => member.kind === "stock" && member.boards.length === 0);
  return members.filter((member) => member.boards.some((board) => board.code === selected.value));
});
const visibleMembers = computed(() => {
  const query = keyword.value.trim().toLocaleLowerCase();
  return categoryMembers.value.filter((member) =>
    [member.name, member.code, member.role, ...member.tags, ...member.boards.map((board) => board.name)]
      .some((value) => value.toLocaleLowerCase().includes(query)));
});

const visibleRows = computed(() => visibleMembers.value.map((member) => {
  const entries = [...member.attention_entries].sort((left, right) => compareAttentionQuality(
    { code: member.code, attention_entries: [left] },
    { code: member.code, attention_entries: [right] },
  ));
  return {
    member,
    attention: entries[0],
    sources: [...new Set(entries.map(attentionSourceLabel))],
  };
}));

const selectedLabel = computed(() => {
  if (selected.value === "all") return "全部标的";
  if (selected.value === "attention") return "关注";
  if (selected.value === "etf") return "ETF";
  if (selected.value === "unclassified") return "行业待同步";
  return data.data.value?.boards.find((board) => board.code === selected.value)?.name ?? "行业";
});

function memberStage(member: PoolMember): string {
  return member.stage ?? member.tags.find((tag) => tag.startsWith("阶段："))?.slice(3) ?? "—";
}

function memberStockCharacter(member: PoolMember): string {
  return member.stock_character ?? member.tags.find((tag) => tag.startsWith("股性："))?.slice(3) ?? "—";
}

function goMarket(code: string): void {
  void router.push({ path: "/market", query: { code, view: "detail" } });
}

function openMarketInstrument(instrument: Instrument): void {
  goMarket(instrument.code);
}

function openMemberDetail(member: PoolMember): void {
  detailMember.value = member;
}

function closeMemberDetail(): void {
  detailMember.value = null;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && detailMember.value) closeMemberDetail();
}

function maintainWithAgent(): void {
  askAi(
    "请维护关注池，当前页面是关注池。新增或更新标的时只加载并调用一次 pool_onboard；服务端会统一完成数据同步、正式指标重算、版本化五维股性画像和入池确认卡，不要再组合行情、分析或 pool_write。当前买入信号和止损都不属于入池判断。",
    "维护关注池",
    { confirmation: "打开 Agent 维护关注池？\n\n新增和更新由 Agent 核对后写入。" },
  );
}

function markAttentionWithAgent(member: PoolMember): void {
  const instruction = isAttention(member)
    ? "请先让我选择新的关注原因或期限。"
    : "请先让我确认关注原因与期限。";
  askAi(
    `请维护关注池标的 ${member.name}（${member.code}）的近期关注。先查询当前有效 pool_membership，` +
    `仅使用 pool_write update 修改人工关注原因与期限，保留原角色和全部研究属性；${instruction}写入成功后刷新 pools。`,
    `近期关注 · ${member.name}`,
    { confirmation: `打开 Agent 处理 ${member.name} 的近期关注？\n\n新增和调整由 Agent 核对后写入；已有关注也可在页面直接移除。` },
  );
}

async function removeAttention(member: PoolMember, entry: PoolAttentionEntry): Promise<void> {
  const key = `${member.code}:${entry.strategy_code ?? 'manual'}`;
  if (removingAttention.value) return;
  if (!window.confirm(
    `确认移除 ${member.name}（${member.code}）的${attentionSourceLabel(entry)}关注？\n\n标的仍保留在关注池，角色和研究属性不会改变。`,
  )) return;

  removingAttention.value = key;
  try {
    const query = entry.strategy_code ? `?strategy=${encodeURIComponent(entry.strategy_code)}` : "";
    const result = await apiClient.delete<PoolMember>(
      `/api/pools/${encodeURIComponent(member.code)}/attention${query}`,
    );
    if (!result.ok) return;

    const current = data.data.value;
    if (current) {
      data.data.value = {
        ...current,
        members: current.members.map((item) => item.code === member.code ? result.data : item),
        attention_count: Math.max(0, current.attention_count - 1),
      };
    }
    if (detailMember.value?.code === member.code) detailMember.value = result.data;
    appMessage.success(`${member.name} 的${attentionSourceLabel(entry)}关注已移除`);
    await data.reload();
    if (detailMember.value?.code === member.code) {
      detailMember.value = data.data.value?.members.find((item) => item.code === member.code) ?? result.data;
    }
  } finally {
    removingAttention.value = null;
  }
}

function pct(value: number | null): string {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

const NEWS_DIRECTION_LABEL: Record<string, string> = { positive: "利好", neutral: "中性", negative: "利空", mixed: "多空并存", unknown: "—" };
const NEWS_STATUS_LABEL: Record<string, string> = { pending: "尚未探查", stale: "已过期", uncovered: "未覆盖", empty: "无相关消息", unverified: "待核验", ready: "已更新" };
function newsLabel(member: PoolMember): string { return NEWS_DIRECTION_LABEL[member.news.direction] ?? "—"; }
function newsClass(member: PoolMember): string { return member.news.direction === "positive" ? "news-positive" : member.news.direction === "negative" ? "news-negative" : member.news.direction === "mixed" ? "news-mixed" : "news-neutral"; }
function newsStatus(member: PoolMember): string { return NEWS_STATUS_LABEL[member.news.status] ?? "—"; }

watch(() => route.query.member, (code) => {
  if (typeof code === "string") selected.value = "all";
}, { immediate: true });
useUiRefresh("pools", async () => { await Promise.all([data.reload(), auctionScope.reload()]); });
onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  void Promise.all([data.reload(), auctionScope.reload()]);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <section>
    <div class="page-head pool-head">
      <div>
        <h1>关注池</h1>
        <div class="sub">完整评估后才入池 · 系统信号与自选观察统一维护 · 所属行业以同花顺官方关系为准</div>
      </div>
      <button class="btn primary agent-entry" type="button" @click="maintainWithAgent">通过 Agent 维护</button>
    </div>

    <div v-if="focusedMember" class="card member-focus">
      <span class="badge accent">已定位标的池结果</span>
      <strong>{{ focusedMember.name }}（{{ focusedMember.code }}）</strong>
      <span>{{ focusedMember.role }} · {{ memberStage(focusedMember) }}</span>
    </div>

    <StateBlock :loading="data.loading.value" :error="data.error.value" :skeleton-rows="8" @retry="data.reload">
      <div class="pool-layout">
        <div class="card pool-explorer">
          <div class="pool-toolbar">
            <div>
              <div class="card-title">全市场标的搜索</div>
              <p class="card-desc">搜索全市场代码或名称，点击候选直接查看行情详情；下方标签仅用于浏览池内标的</p>
            </div>
            <InstrumentPicker class="market-search" placeholder="搜索全市场标的…" @select="openMarketInstrument" />
          </div>
          <nav class="pool-tabs" aria-label="标的池视图">
            <button type="button" :aria-pressed="selected === 'attention'" :class="{ active: selected === 'attention' }" @click="selected = 'attention'">
              关注 <small>{{ data.data.value?.attention_count ?? 0 }}</small>
            </button>
            <button type="button" :aria-pressed="selected === 'all'" :class="{ active: selected === 'all' }" @click="selected = 'all'">
              全部 <small>{{ data.data.value?.members.length ?? 0 }}</small>
            </button>
            <button
              v-for="board in data.data.value?.boards ?? []"
              :key="board.code"
              type="button"
              :aria-pressed="selected === board.code" :class="{ active: selected === board.code }"
              @click="selected = board.code"
            >
              {{ board.name }} <small>{{ board.member_count }}</small>
            </button>
            <button v-if="etfCount" type="button" :aria-pressed="selected === 'etf'" :class="{ active: selected === 'etf' }" @click="selected = 'etf'">
              ETF <small>{{ etfCount }}</small>
            </button>
            <button v-if="data.data.value?.unclassified_count" type="button" :aria-pressed="selected === 'unclassified'" :class="{ active: selected === 'unclassified' }" @click="selected = 'unclassified'">
              行业待同步 <small>{{ data.data.value.unclassified_count }}</small>
            </button>
          </nav>
        </div>

        <main class="card pool-content">
          <div class="content-head">
            <div>
              <div class="card-title">{{ selectedLabel }}（{{ visibleMembers.length }}）</div>
              <p class="card-desc">{{ selected === "attention" ? "按信号完整度排序：已成立 → 待补信号 → 人工关注；同档按代码排序。列表展示最完整信号摘要；点击标的查看各来源的完整条件与有效期。" : "当前有效池成员及其研究、阶段与关注状态。" }}</p>
            </div>
            <div v-if="selected !== 'all' && selected !== 'attention' && selected !== 'etf' && selected !== 'unclassified'" class="content-actions">
              <a class="btn compact" :href="`https://q.10jqka.com.cn/thshy/detail/code/${selected.split('.')[0]}/`" target="_blank" rel="noopener noreferrer">查看板块成分</a>
              <button class="btn compact" type="button" @click="goMarket(selected)">查看行业行情</button>
            </div>
          </div>
          <div class="list-filter">
            <input v-model="keyword" type="search" aria-label="筛选池内标的" placeholder="筛选池内名称、代码、行业或标签" />
            <span class="list-filter-count" role="status">显示 {{ visibleMembers.length }} / {{ categoryMembers.length }} 只</span>
            <span class="table-scroll-hint">左右滚动查看完整列</span>
            <button v-if="keyword" class="btn compact" type="button" @click="keyword = ''">清空筛选</button>
          </div>
          <div v-if="visibleMembers.length === 0" class="state-block empty">
            <strong>{{ keyword.trim() ? "没有匹配的池内标的" : "当前分类暂无标的" }}</strong>
            <p>{{ keyword.trim() ? "可清空筛选，或切换「全部」扩大查找范围。" : "可切换其他分类查看，或通过 Agent 维护关注。" }}</p>
            <button v-if="selected !== 'all'" class="btn" type="button" @click="selected = 'all'">查看全部分类</button>
          </div>
          <div v-else class="table-wrap" role="region" aria-label="池内标的，可左右滚动查看完整列" tabindex="0">
            <table class="data-table clickable" :class="{ 'attention-view': selected === 'attention' }">
              <colgroup>
                <col class="col-instrument"><col class="col-role"><col class="col-stage"><col class="col-industry"><col class="col-news"><col class="col-attention"><col class="col-action">
              </colgroup>
              <thead><tr><th>标的 / 行情</th><th>角色</th><th>阶段 / 股性</th><th>行业细分（官方）</th><th>消息面</th><th>近期关注</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="{ member, attention, sources } in visibleRows" :key="member.id" :class="{ 'focused-row': member.code === focusedMemberCode }" tabindex="0" @click="openMemberDetail(member)" @keydown.enter="openMemberDetail(member)" @keydown.space.prevent="openMemberDetail(member)">
                  <td>
                    <strong>{{ member.name }}</strong><div class="num code-sub">{{ member.code }}</div>
                    <div class="quote"><span class="num">{{ member.last === null ? "—" : fmtNum(member.last) }}</span><span :class="{ up: (member.change_pct ?? 0) > 0, down: (member.change_pct ?? 0) < 0 }">{{ pct(member.change_pct) }}</span></div>
                  </td>
                  <td><span class="badge accent">{{ member.role }}</span></td>
                  <td><strong class="cell-clamp clamp-1">{{ memberStage(member) }}</strong><div class="muted cell-clamp clamp-2">{{ memberStockCharacter(member) }}</div></td>
                  <td>
                    <button v-for="board in displayIndustries(member)" :key="board.code" class="market-link industry-text" type="button" @click.stop="goMarket(board.code)">{{ board.name }}</button>
                    <span v-if="member.boards.length === 0" class="muted">{{ member.kind === "etf" ? "不适用" : "待同步" }}</span>
                  </td>
                  <td class="news-cell"><span class="badge news-badge" :class="newsClass(member)">{{ newsLabel(member) }}</span><span class="news-status">{{ newsStatus(member) }}</span></td>
                  <td class="attention-cell">
                    <div v-if="attention" class="attention-summary">
                      <div class="attention-summary-head">
                        <span class="badge signal-status" :class="attention.status">{{ attentionStatusLabel(attention) }}</span>
                        <span v-if="attention.stale_reason" class="badge warn">待复核</span>
                      </div>
                      <div class="attention-sources" :title="sources.join('、')">
                        <span v-for="source in sources.slice(0, 2)" :key="source" class="source-chip">{{ source }}</span>
                        <span v-if="sources.length > 2" class="source-more">+{{ sources.length - 2 }}</span>
                      </div>
                      <span class="cell-clamp clamp-2 attention-reason">{{ attention.reason }}</span>
                    </div>
                    <span v-else class="muted">未关注</span>
                    <div v-if="!isAttention(member)" class="attention-footer">
                      <span class="muted">—</span>
                      <div class="attention-actions">
                        <button class="detail-trigger agent-entry" type="button" @click.stop="markAttentionWithAgent(member)">关注</button>
                      </div>
                    </div>
                  </td>
                  <td class="row-action-cell"><button class="btn compact" type="button" @click.stop="goMarket(member.code)">查看行情</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </main>
      </div>
    </StateBlock>

    <div v-if="detailMember" class="member-detail-mask" @click.self="closeMemberDetail">
      <aside class="member-detail-panel" role="dialog" aria-modal="true" :aria-label="`${detailMember.name} 池内详情`">
        <header class="member-detail-head">
          <div><span class="badge accent">关注池</span><strong>{{ detailMember.name }}</strong><span class="num code-sub">{{ detailMember.code }}</span></div>
          <div class="member-detail-actions"><button class="btn compact" type="button" @click="goMarket(detailMember.code)">查看行情</button><button class="detail-close" type="button" aria-label="关闭池内详情" @click="closeMemberDetail">×</button></div>
        </header>
        <div class="member-detail-scroll">
          <dl class="detail-overview">
            <div><dt>角色</dt><dd>{{ detailMember.role }}</dd></div>
            <div><dt>阶段</dt><dd>{{ memberStage(detailMember) }}</dd></div>
            <div><dt>行业</dt><dd>{{ displayIndustries(detailMember).map((board) => board.name).join(" · ") || (detailMember.kind === "etf" ? "不适用" : "待同步") }}</dd></div>
            <div class="overview-character"><dt>股性</dt><dd>{{ memberStockCharacter(detailMember) }}</dd></div>
          </dl>
          <PoolResearch :key="[detailMember.code, ...detailMember.attention_entries.map(entry => `${entry.id}:${entry.source_evaluation_run_id}`)].join('|')" :code="detailMember.code" />
          <details v-if="detailMember.evaluation_summary" class="detail-section entry-note"><summary>入池记录</summary><p>{{ detailMember.evaluation_summary }}</p></details>
          <section class="detail-section news-section">
            <div class="news-section-head"><h3>相关消息</h3><span class="badge news-badge" :class="newsClass(detailMember)">{{ newsLabel(detailMember) }}</span></div>
            <p class="news-meta">{{ newsStatus(detailMember) }}<template v-if="detailMember.news.captured_at"> · 探查 {{ fmtDate(detailMember.news.captured_at) }}</template></p>
            <template v-if="detailMember.news.items.length">
              <article v-for="item in detailMember.news.items" :key="item.id" class="news-item">
                <div class="news-item-head"><span class="badge news-badge" :class="item.direction === 'positive' ? 'news-positive' : item.direction === 'negative' ? 'news-negative' : item.direction === 'mixed' ? 'news-mixed' : 'news-neutral'">{{ NEWS_DIRECTION_LABEL[item.direction] }}</span><span class="muted">{{ item.impact_level === 'high' ? '高影响' : item.impact_level === 'medium' ? '中影响' : '低影响' }} · {{ item.relation_type === 'direct' ? '直接相关' : item.relation_type === 'supply_chain' ? '产业链关联' : item.relation_type === 'sector' ? '板块关联' : '市场关联' }}</span></div>
                <a :href="item.source_url" target="_blank" rel="noopener noreferrer" class="news-title">{{ item.title }}</a>
                <p>{{ item.facts }}</p><p class="news-impact">{{ item.impact_note }}</p>
                <div class="muted">{{ item.source_name }} · {{ item.published_at ? fmtDate(item.published_at) : '发布时间待核验' }} · {{ item.source_level === 'primary' ? '原始披露' : '专业财经' }}</div>
              </article>
            </template>
          </section>
          <section class="detail-section">
            <h3>近期关注</h3>
            <template v-if="isAttention(detailMember)">
              <div v-for="entry in detailMember.attention_entries" :key="entry.id" class="attention-entry">
                <div class="attention-entry-head">
                  <span class="badge signal-status" :class="entry.status">{{ attentionStatusLabel(entry) }}</span>
                  <RouterLink v-if="entry.strategy_code" class="source-tag" :to="{ path: '/strategies', query: { strategy: entry.strategy_code } }" @click.stop>{{ attentionSourceLabel(entry) }} ↗</RouterLink><span v-else class="muted source-tag">人工关注</span>
                  <button class="detail-trigger remove-attention" type="button" :disabled="removingAttention === `${detailMember.code}:${entry.strategy_code ?? 'manual'}`" @click="removeAttention(detailMember, entry)">{{ removingAttention === `${detailMember.code}:${entry.strategy_code ?? 'manual'}` ? "移除中" : "移除关注" }}</button>
                </div>
                <ul v-if="entry.status === 'approaching'" class="signal-gaps">
                  <li v-for="gap in entry.missing_signals" :key="gap">待确认：{{ gap }}</li>
                  <li v-if="!entry.missing_signals.length">缺口待补充，请结合关注原因核实</li>
                </ul>
                <p>{{ entry.reason }}</p>
                <div class="muted">{{ fmtDate(entry.valid_from) ?? "现在" }}–{{ fmtDate(entry.valid_until) ?? "持续" }}<template v-if="entry.data_date"> · 数据 {{ fmtDate(entry.data_date) }}</template><template v-if="entry.source_evaluation_run_id"> · 结构化评估已记录</template></div>
                <p v-if="entry.stale_reason" class="missing">{{ entry.stale_reason }}</p>
                <div v-if="auctionForEntry(entry)" class="muted">竞价 {{ fmtDate(auctionScope.data.value?.target_date) }} · {{ AUCTION_CONCLUSION_LABELS[auctionForEntry(entry)?.conclusion ?? ''] ?? auctionForEntry(entry)?.conclusion }}：{{ auctionForEntry(entry)?.assessment_summary }}</div>

              </div>
            </template>
            <p v-else class="muted">当前未关注</p>
            <div class="detail-attention-actions">
              <button class="btn compact agent-entry" type="button" @click="markAttentionWithAgent(detailMember)">{{ isAttention(detailMember) ? "调整人工关注" : "标记人工关注" }}</button>
            </div>
          </section>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.signal-status{white-space:normal}.signal-status.qualified{color:var(--accent);border:1px solid currentColor}.signal-status.approaching{color:var(--warning, #9a6400);border:1px solid currentColor}.signal-status.manual{color:var(--ink-faint);border:1px solid currentColor}
.attention-summary{display:grid;gap:5px}
.attention-summary-head,.attention-sources{display:flex;align-items:center;gap:6px;min-width:0}
.attention-summary-head .signal-status{white-space:nowrap}
.attention-sources{overflow:hidden}
.source-chip{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 5px;border-radius:4px;background:var(--paper-deep);color:var(--ink-soft);font-size:11px}
.source-more{flex:none;color:var(--ink-soft);font-size:11px}
.attention-reason{color:var(--ink-soft);line-height:1.5}
.signal-gaps{margin:2px 0 8px;padding-left:16px;font-size:12px;line-height:1.6;overflow-wrap:anywhere}.signal-gaps li+li{margin-top:4px}
.attention-entry{padding:8px 0;border-bottom:1px dashed var(--line)}.attention-entry:last-child{border-bottom:0}
.attention-entry-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px}
.source-tag{flex:none;font-size:11px}

.pool-head,.content-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.content-actions{display:flex;gap:7px;flex:none}
.pool-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;min-width:0}
.pool-explorer{position:relative;z-index:4;min-width:0;padding:0}
.pool-toolbar{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:12px 14px;border-bottom:1px solid var(--line)}
.pool-toolbar .card-title{margin:0 0 2px}
.market-search{width:min(430px,100%);flex:none}
.pool-tabs{display:flex;gap:2px;overflow-x:auto;padding:0 10px}
.pool-tabs button{display:inline-flex;align-items:center;gap:5px;flex:none;min-height:40px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--ink-soft);padding:0 11px;white-space:nowrap;cursor:pointer;font:500 var(--fs-sm)/1 var(--font-body);transition:background var(--dur) var(--ease),border-color var(--dur) var(--ease),color var(--dur) var(--ease)}
.pool-tabs button:hover{background:var(--paper-deep);color:var(--ink)}
.pool-tabs button.active{border-bottom-color:var(--accent);background:var(--accent-soft);color:var(--accent-ink);font-weight:700}
.pool-tabs small,.muted,.code-sub{font-size:11px;color:var(--ink-faint)}
.pool-content{min-width:0;padding:0;overflow:hidden}
.content-head{align-items:center;padding:13px 16px;border-bottom:1px solid var(--line)}
.content-head .card-title{margin:0 0 2px}
.table-wrap{overflow:auto}
.data-table{min-width:850px;table-layout:fixed}
.data-table thead th{position:sticky;top:0;z-index:2;padding:9px 12px;background:var(--paper-deep);box-shadow:0 1px 0 var(--line);font-size:11px;letter-spacing:.02em}
.data-table td{padding:12px;line-height:1.45}
.data-table.attention-view{min-width:920px}.attention-view .col-attention{width:350px}
.data-table th:first-child,.data-table td:first-child{position:sticky;left:0;z-index:1;background:var(--card)}
.data-table th:first-child{z-index:3;background:var(--paper-deep)}
.data-table th:last-child,.data-table td:last-child{position:sticky;right:0;z-index:1;background:var(--card);box-shadow:-1px 0 var(--line)}
.data-table th:last-child{z-index:3;background:var(--paper-deep)}
.data-table tbody tr:hover td:first-child,.data-table tbody tr:hover td:last-child{background:var(--accent-soft)}
.col-instrument{width:130px}.col-role{width:70px}.col-stage{width:130px}.col-industry{width:150px}.col-news{width:98px}.col-attention{width:280px}.col-action{width:86px}
.news-cell{vertical-align:top}.news-badge{display:inline-block;width:max-content;border:1px solid currentColor}.news-positive{color:var(--up)}.news-negative{color:var(--down)}.news-mixed{color:var(--warning,#9a6400)}.news-neutral{color:var(--ink-faint)}.news-status{display:block;margin-top:5px;font-size:11px;color:var(--ink-faint)}.news-section-head,.news-item-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.news-section-head h3{margin:0}.news-meta{margin:5px 0 10px!important;font-size:12px}.news-item{padding:10px 0;border-top:1px dashed var(--line)}.news-title{display:block;margin:6px 0;color:var(--accent-ink);font-weight:700;line-height:1.45}.news-title:hover{text-decoration:underline}.news-item p{margin:5px 0!important}.news-impact{color:var(--ink)!important}
.attention-footer,.member-detail-head,.member-detail-actions{display:flex;align-items:center;justify-content:space-between;gap:8px}.attention-actions,.detail-attention-actions{display:flex;align-items:center;gap:8px}.detail-trigger{flex:none;border:0;background:transparent;padding:0;color:var(--accent-ink);font:600 11px var(--font-body);cursor:pointer}.detail-trigger:hover{text-decoration:underline}.remove-attention{color:var(--bad)}.remove-attention:disabled{cursor:wait;opacity:.55}.quote{display:flex;gap:8px;margin-top:5px}.cell-clamp{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.clamp-1{-webkit-line-clamp:1}.clamp-2{-webkit-line-clamp:2}.clamp-3{-webkit-line-clamp:3}.tag-preview{display:grid;gap:4px}.attention-cell{min-width:0}.attention-footer{margin-top:6px}.attention-footer>.muted{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row-action-cell{vertical-align:middle!important}.row-action-cell .btn{white-space:nowrap}.data-table tbody tr:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.market-link{display:block;border:0;background:transparent;padding:0;color:var(--accent-ink);text-align:left;cursor:pointer;font:inherit}.market-link:hover{text-decoration:underline}.industry-text{font-weight:600}.up{color:var(--up)}.down{color:var(--down)}
.member-detail-mask{position:fixed;inset:0;z-index:80;display:flex;justify-content:flex-end;background:var(--overlay)}.member-detail-panel{display:grid;width:min(620px,94vw);height:100%;grid-template-rows:auto minmax(0,1fr);overflow:hidden;background:var(--paper);border-left:1px solid var(--line);box-shadow:var(--shadow-lift);overscroll-behavior:contain}.member-detail-head{padding:10px 14px;border-bottom:1px solid var(--line);background:var(--card)}.member-detail-head>div:first-child{display:flex;align-items:center;min-width:0;gap:8px}.member-detail-head strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.detail-close{display:grid;width:30px;height:30px;place-items:center;border:1px solid var(--line);border-radius:var(--radius-sm);background:transparent;color:var(--ink-soft);font-size:19px;line-height:1;cursor:pointer}.detail-close:hover{border-color:var(--accent);color:var(--accent-ink)}.member-detail-scroll{min-height:0;overflow:auto;padding:10px 14px 20px}.detail-overview{display:flex;flex-wrap:wrap;gap:6px 18px;margin:0;padding:0 0 10px;border-bottom:1px solid var(--line)}.detail-overview>div{display:flex;align-items:baseline;gap:8px;min-width:0}.detail-overview .overview-character{flex-basis:100%}.detail-overview dt{flex:none;color:var(--ink-soft);font-size:var(--fs-sm)}.detail-overview dd{margin:0;overflow-wrap:anywhere;line-height:1.5}.detail-section{padding:10px 0;border-bottom:1px solid var(--line)}.detail-section h3{margin:0 0 6px;font-size:var(--fs-md)}.detail-section p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink-soft);line-height:1.65}.detail-section .btn{margin-top:6px}.entry-note summary{cursor:pointer;color:var(--ink-soft);font-size:var(--fs-sm)}.entry-note p{margin-top:6px}.detail-section .attention-entry-head{justify-content:flex-start;flex-wrap:wrap}.detail-section .remove-attention{margin-left:auto}.detail-section .attention-entry-head .source-tag{flex:1;min-width:0;overflow-wrap:anywhere}.detail-section .attention-entry{padding:6px 0}.detail-tags{display:flex;align-items:flex-start;flex-wrap:wrap;gap:6px}.detail-tags .badge{max-width:100%;white-space:normal;overflow-wrap:anywhere}
.member-focus{display:flex;align-items:center;gap:10px;margin-bottom:12px;border-color:var(--accent);background:var(--accent-soft)}.focused-row{outline:2px solid var(--accent);outline-offset:-2px;background:var(--accent-soft)}
@container business (max-width:720px){.pool-toolbar,.content-head{align-items:stretch;flex-direction:column}.market-search{width:100%}.content-actions{align-self:flex-start}}
@media(max-width:720px){.pool-head{align-items:stretch;flex-direction:column}.member-detail-panel{width:100vw}.member-detail-head{align-items:flex-start}.member-detail-head>div:first-child{flex-wrap:wrap;gap:4px 6px}}
</style>
