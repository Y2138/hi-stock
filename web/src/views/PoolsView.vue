<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient } from "../api/client";
import type { PoolMember, PoolViewData } from "../api/types";
import StateBlock from "../components/StateBlock.vue";
import UiInput from "../components/ui/UiInput.vue";
import { useResource } from "../composables/useResource";
import { useUiRefresh } from "../composables/useUiRefresh";
import { askAi } from "../utils/askAi";
import { fmtDate, fmtNum } from "../utils/format";

const props = defineProps<{ pool: "short" | "long" }>();
const router = useRouter();
const route = useRoute();
const selected = ref("attention");
const boardQuery = ref("");
const searchFocused = ref(false);
const detailMember = ref<PoolMember | null>(null);
const data = useResource<PoolViewData>(() => apiClient.get<PoolViewData>(`/api/pools/${props.pool}`));
const focusedMemberCode = computed(() => typeof route.query.member === "string" ? route.query.member : null);
const focusedMember = computed(() => (data.data.value?.members ?? []).find((member) => member.code === focusedMemberCode.value) ?? null);

const title = computed(() => props.pool === "short" ? "短线池" : "长线池");
const showResearch = computed(() => props.pool === "long");
const today = () => new Date().toISOString().slice(0, 10);
const isAttention = (member: PoolMember) => Boolean(
  member.attention_reason &&
  (!member.attention_from || member.attention_from <= today()) &&
  (!member.attention_until || member.attention_until >= today()),
);
const etfCount = computed(() => (data.data.value?.members ?? []).filter((member) => member.kind === "etf").length);
const displayIndustries = (member: PoolMember) => {
  const secondary = member.boards.filter((board) => board.level === "secondary");
  return secondary.length ? secondary : member.boards.filter((board) => board.level === "primary");
};
const boardMatches = computed(() => {
  const keyword = boardQuery.value.trim().toLocaleLowerCase("zh-CN");
  const boards = data.data.value?.boards ?? [];
  if (!keyword) return [];
  return boards.filter((board) =>
    [board.name, board.code]
      .some((value) => value.toLocaleLowerCase("zh-CN").includes(keyword)),
  ).slice(0, 8);
});
const visibleMembers = computed(() => {
  const members = data.data.value?.members ?? [];
  if (selected.value === "all") {
    return focusedMemberCode.value
      ? [...members].sort((left, right) => Number(right.code === focusedMemberCode.value) - Number(left.code === focusedMemberCode.value))
      : members;
  }
  if (selected.value === "attention") return members.filter(isAttention);
  if (selected.value === "etf") return members.filter((member) => member.kind === "etf");
  if (selected.value === "unclassified") return members.filter((member) => member.kind === "stock" && member.boards.length === 0);
  return members.filter((member) => member.boards.some((board) => board.code === selected.value));
});
const selectedLabel = computed(() => {
  if (selected.value === "all") return "全部标的";
  if (selected.value === "attention") return "近期关注";
  if (selected.value === "etf") return "ETF";
  if (selected.value === "unclassified") return "行业待同步";
  return data.data.value?.boards.find((board) => board.code === selected.value)?.name ?? "行业";
});

function researchTags(member: PoolMember): string[] {
  return member.tags.filter((tag) => !["阶段：", "股性：", "角色：", "分级：", "评分："]
    .some((prefix) => tag.startsWith(prefix)));
}

function memberStage(member: PoolMember): string {
  return member.stage ?? member.tags.find((tag) => tag.startsWith("阶段："))?.slice(3) ?? "—";
}

function memberStockCharacter(member: PoolMember): string {
  return member.stock_character ?? member.tags.find((tag) => tag.startsWith("股性："))?.slice(3) ?? "—";
}

function selectFirstBoard(): void {
  const first = boardMatches.value[0];
  if (first) selectBoard(first.code);
}

function selectBoard(code: string): void {
  selected.value = code;
  boardQuery.value = "";
  searchFocused.value = false;
}

function goMarket(code: string): void {
  void router.push({ path: "/market", query: { code, view: "detail" } });
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
    `请维护标的池，当前页面是${title.value}。新增、迁池或改变策略角色时，先按“标的入池评估指引”同时评估短线、波段和长线；当前页面和我提出的池别只能作为待验证假设，不得预设结论。优先查询数据库并按需补拉行情、财务和估值；只有故事性、催化剂、公告或外部风险证据不足时才使用 web_search。形成唯一策略归属并完整展示适配矩阵、数据截止和缺口后，才能用 pool_write 提案；关键数据不足或无法可靠区分时不要写入。`,
    "维护标的池",
    { confirmation: `打开 Agent 维护${title.value}？\n\n页面本身只查询，业务事实由 Agent 核对后写入。` },
  );
}

function markAttentionWithAgent(member: PoolMember): void {
  askAi(
    `请维护${title.value}标的 ${member.name}（${member.code}）的近期关注。先查询当前有效 pool_membership，` +
    "仅使用 pool_write update 修改 attention_reason、attention_from、attention_until，保留原角色和全部研究属性；请先让我确认关注原因与期限，写入成功后刷新 pools。",
    `近期关注 · ${member.name}`,
    { confirmation: `打开 Agent 处理 ${member.name} 的近期关注？\n\n页面不会直接改写标的池。` },
  );
}

function pct(value: number | null): string {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

watch(() => props.pool, () => {
  selected.value = "attention";
  boardQuery.value = "";
  detailMember.value = null;
  void data.reload();
});
watch(() => route.query.member, (code) => {
  if (typeof code === "string") selected.value = "all";
}, { immediate: true });
useUiRefresh("pools", data.reload);
onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  void data.reload();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <section>
    <div class="page-head pool-head">
      <div>
        <h1>{{ title }}</h1>
        <div class="sub">完整评估后才入池 · 所属行业以同花顺官方关系为准</div>
      </div>
      <button class="btn primary agent-entry" type="button" @click="maintainWithAgent">通过 Agent 维护</button>
    </div>

    <div v-if="focusedMember" class="card member-focus">
      <span class="badge accent">已定位标的池结果</span>
      <strong>{{ focusedMember.name }}（{{ focusedMember.code }}）</strong>
      <span>{{ focusedMember.role }} · {{ focusedMember.grade ?? "—" }} · {{ memberStage(focusedMember) }}</span>
    </div>

    <StateBlock :loading="data.loading.value" :error="data.error.value" :skeleton-rows="8" @retry="data.reload">
      <div class="pool-layout">
        <div class="card pool-explorer">
          <div class="pool-toolbar">
            <div>
              <div class="card-title">大行业导航</div>
              <p class="card-desc">按大行业聚合池内标的，细分行业保留在列表中</p>
            </div>
            <div class="board-search">
              <UiInput
                v-model="boardQuery"
                type="search"
                aria-label="快速查找大行业"
                placeholder="快速定位大行业"
                role="combobox"
                :aria-expanded="searchFocused && Boolean(boardQuery)"
                aria-controls="board-search-results"
                @focus="searchFocused = true"
                @blur="searchFocused = false"
                @keyup.enter="selectFirstBoard"
                @keyup.esc="boardQuery = ''"
              />
              <button class="btn compact board-locate" type="button" :disabled="!boardMatches.length" @click="selectFirstBoard">定位</button>
              <div v-if="searchFocused && boardQuery" id="board-search-results" class="board-results" role="listbox">
                <button
                  v-for="board in boardMatches"
                  :key="board.code"
                  type="button"
                  role="option"
                  @mousedown.prevent
                  @click="selectBoard(board.code)"
                >
                  {{ board.name }}
                </button>
                <span v-if="boardMatches.length === 0">没有匹配的大行业</span>
              </div>
            </div>
          </div>
          <nav class="pool-tabs" aria-label="标的池视图">
            <button type="button" :class="{ active: selected === 'attention' }" @click="selected = 'attention'">
              近期关注 <small>{{ data.data.value?.attention_count ?? 0 }}</small>
            </button>
            <button type="button" :class="{ active: selected === 'all' }" @click="selected = 'all'">
              全部 <small>{{ data.data.value?.members.length ?? 0 }}</small>
            </button>
            <button
              v-for="board in data.data.value?.boards ?? []"
              :key="board.code"
              type="button"
              :class="{ active: selected === board.code }"
              @click="selected = board.code"
            >
              {{ board.name }} <small>{{ board.member_count }}</small>
            </button>
            <button v-if="etfCount" type="button" :class="{ active: selected === 'etf' }" @click="selected = 'etf'">
              ETF <small>{{ etfCount }}</small>
            </button>
            <button v-if="data.data.value?.unclassified_count" type="button" :class="{ active: selected === 'unclassified' }" @click="selected = 'unclassified'">
              行业待同步 <small>{{ data.data.value.unclassified_count }}</small>
            </button>
          </nav>
        </div>

        <main class="card pool-content">
          <div class="content-head">
            <div>
              <div class="card-title">{{ selectedLabel }}（{{ visibleMembers.length }}）</div>
              <p class="card-desc">当前有效池成员及其研究、阶段与关注状态。</p>
            </div>
            <div v-if="selected !== 'all' && selected !== 'attention' && selected !== 'etf' && selected !== 'unclassified'" class="content-actions">
              <a class="btn compact" :href="`https://q.10jqka.com.cn/thshy/detail/code/${selected.split('.')[0]}/`" target="_blank" rel="noopener noreferrer">查看板块成分</a>
              <button class="btn compact" type="button" @click="goMarket(selected)">查看行业行情</button>
            </div>
          </div>
          <p v-if="visibleMembers.length === 0" class="state-block empty">当前视图没有标的</p>
          <div v-else class="table-wrap">
            <table class="data-table clickable" :class="{ 'research-visible': showResearch }">
              <colgroup>
                <col class="col-instrument"><col class="col-role"><col v-if="showResearch" class="col-summary"><col v-if="showResearch" class="col-tags">
                <col class="col-stage"><col class="col-industry"><col class="col-attention"><col class="col-action">
              </colgroup>
              <thead><tr><th>标的 / 行情</th><th>角色 / 分级</th><th v-if="showResearch">研究摘要</th><th v-if="showResearch">研究标签</th><th>阶段 / 股性</th><th>行业细分（官方）</th><th>近期关注</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="member in visibleMembers" :key="member.id" :class="{ 'focused-row': member.code === focusedMemberCode }" tabindex="0" @click="openMemberDetail(member)" @keydown.enter="openMemberDetail(member)" @keydown.space.prevent="openMemberDetail(member)">
                  <td>
                    <strong>{{ member.name }}</strong><div class="num code-sub">{{ member.code }}</div>
                    <div class="quote"><span class="num">{{ member.last === null ? "—" : fmtNum(member.last) }}</span><span :class="{ up: (member.change_pct ?? 0) > 0, down: (member.change_pct ?? 0) < 0 }">{{ pct(member.change_pct) }}</span></div>
                  </td>
                  <td><span class="badge accent">{{ member.role }}</span><div>{{ member.grade ?? "—" }} · {{ member.score ?? "—" }}</div></td>
                  <td v-if="showResearch"><div class="cell-clamp clamp-3 summary">{{ member.evaluation_summary ?? "—" }}</div></td>
                  <td v-if="showResearch"><div v-if="researchTags(member).length" class="tag-preview"><div v-for="(tag, index) in researchTags(member).slice(0, 2)" :key="tag" class="tag-preview-row"><span class="badge compact-tag">{{ tag }}</span><span v-if="index === 1 && researchTags(member).length > 2" class="tag-more">余 {{ researchTags(member).length - 2 }} 条</span></div></div><span v-else>—</span></td>
                  <td><strong class="cell-clamp clamp-1">{{ memberStage(member) }}</strong><div class="muted cell-clamp clamp-2">{{ memberStockCharacter(member) }}</div></td>
                  <td>
                    <button v-for="board in displayIndustries(member)" :key="board.code" class="market-link industry-text" type="button" @click.stop="goMarket(board.code)">{{ board.name }}</button>
                    <span v-if="member.boards.length === 0" class="muted">{{ member.kind === "etf" ? "不适用" : "待同步" }}</span>
                  </td>
                  <td class="attention-cell">
                    <strong v-if="isAttention(member)" class="cell-clamp clamp-2">{{ member.attention_reason }}</strong>
                    <span v-else class="muted">未关注</span>
                    <div class="attention-footer"><span class="muted">{{ isAttention(member) ? `${fmtDate(member.attention_from) ?? "现在"}–${fmtDate(member.attention_until) ?? "持续"}` : "—" }}</span><button class="detail-trigger agent-entry" type="button" @click.stop="markAttentionWithAgent(member)">{{ isAttention(member) ? "调整" : "关注" }}</button></div>
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
          <div><span class="badge accent">{{ title }}</span><strong>{{ detailMember.name }}</strong><span class="num code-sub">{{ detailMember.code }}</span></div>
          <div class="member-detail-actions"><button class="btn compact" type="button" @click="goMarket(detailMember.code)">查看行情</button><button class="detail-close" type="button" aria-label="关闭池内详情" @click="closeMemberDetail">×</button></div>
        </header>
        <div class="member-detail-scroll">
          <dl class="detail-overview">
            <div><dt>角色 / 分级</dt><dd>{{ detailMember.role }} · {{ detailMember.grade ?? "—" }} · {{ detailMember.score ?? "—" }}</dd></div>
            <div><dt>阶段</dt><dd>{{ memberStage(detailMember) }}</dd></div>
            <div><dt>股性</dt><dd>{{ memberStockCharacter(detailMember) }}</dd></div>
            <div><dt>行业细分</dt><dd>{{ displayIndustries(detailMember).map((board) => board.name).join(" · ") || (detailMember.kind === "etf" ? "不适用" : "待同步") }}</dd></div>
          </dl>
          <section v-if="showResearch" class="detail-section"><h3>研究摘要</h3><p>{{ detailMember.evaluation_summary ?? "暂无研究摘要" }}</p></section>
          <section v-if="showResearch" class="detail-section"><h3>研究标签</h3><div v-if="researchTags(detailMember).length" class="detail-tags"><span v-for="tag in researchTags(detailMember)" :key="tag" class="badge">{{ tag }}</span></div><p v-else class="muted">暂无研究标签</p></section>
          <section class="detail-section"><h3>近期关注</h3><template v-if="isAttention(detailMember)"><p>{{ detailMember.attention_reason }}</p><div class="muted">{{ fmtDate(detailMember.attention_from) ?? "现在" }}–{{ fmtDate(detailMember.attention_until) ?? "持续" }}</div></template><p v-else class="muted">当前未关注</p><button class="btn compact agent-entry" type="button" @click="markAttentionWithAgent(detailMember)">{{ isAttention(detailMember) ? "调整关注" : "标记关注" }}</button></section>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.pool-head,.content-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.content-actions{display:flex;gap:7px;flex:none}
.pool-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;min-width:0}
.pool-explorer{position:relative;z-index:4;min-width:0;padding:0}
.pool-toolbar{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:12px 14px;border-bottom:1px solid var(--line)}
.pool-toolbar .card-title{margin:0 0 2px}
.board-search{position:relative;display:grid;grid-template-columns:minmax(180px,280px) auto;gap:6px;width:min(350px,100%)}
.board-locate:disabled{opacity:.45;cursor:not-allowed}
.board-results{position:absolute;top:calc(100% + 6px);left:0;right:58px;z-index:8;display:grid;max-height:240px;overflow:auto;padding:4px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--card);box-shadow:var(--shadow-lift)}
.board-results button{border:0;border-radius:6px;background:transparent;color:var(--ink);padding:8px 10px;text-align:left;cursor:pointer}
.board-results button:hover{background:var(--accent-soft);color:var(--accent-ink)}
.board-results span{padding:10px;color:var(--ink-faint);font-size:var(--fs-sm)}
.pool-tabs{display:flex;gap:2px;overflow-x:auto;padding:0 10px}
.pool-tabs button{display:inline-flex;align-items:center;gap:5px;flex:none;min-height:40px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--ink-soft);padding:0 11px;white-space:nowrap;cursor:pointer;font:500 var(--fs-sm)/1 var(--font-body);transition:background var(--dur) var(--ease),border-color var(--dur) var(--ease),color var(--dur) var(--ease)}
.pool-tabs button:hover{background:var(--paper-deep);color:var(--ink)}
.pool-tabs button.active{border-bottom-color:var(--accent);background:var(--accent-soft);color:var(--accent-ink);font-weight:700}
.pool-tabs small,.muted,.code-sub{font-size:11px;color:var(--ink-faint)}
.pool-content{min-width:0;padding:0;overflow:hidden}
.content-head{align-items:center;padding:13px 16px;border-bottom:1px solid var(--line)}
.content-head .card-title{margin:0 0 2px}
.table-wrap{overflow:auto}
.data-table{min-width:850px;table-layout:fixed}.data-table.research-visible{min-width:1080px}
.data-table thead th{position:sticky;top:0;z-index:2;padding:9px 12px;background:var(--paper-deep);box-shadow:0 1px 0 var(--line);font-size:11px;letter-spacing:.02em}
.data-table td{padding:12px;line-height:1.45}
.data-table th:first-child,.data-table td:first-child{position:sticky;left:0;z-index:1;background:var(--card)}
.data-table th:first-child{z-index:3;background:var(--paper-deep)}
.data-table th:last-child,.data-table td:last-child{position:sticky;right:0;z-index:1;background:var(--card);box-shadow:-1px 0 var(--line)}
.data-table th:last-child{z-index:3;background:var(--paper-deep)}
.data-table tbody tr:hover td:first-child,.data-table tbody tr:hover td:last-child{background:var(--accent-soft)}
.col-instrument{width:130px}.col-role{width:90px}.col-summary{width:190px}.col-tags{width:130px}.col-stage{width:125px}.col-industry{width:155px}.col-attention{width:210px}.col-action{width:86px}
.attention-footer,.member-detail-head,.member-detail-actions{display:flex;align-items:center;justify-content:space-between;gap:8px}.detail-trigger{flex:none;border:0;background:transparent;padding:0;color:var(--accent-ink);font:600 11px var(--font-body);cursor:pointer}.detail-trigger:hover{text-decoration:underline}.quote{display:flex;gap:8px;margin-top:5px}.cell-clamp{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.clamp-1{-webkit-line-clamp:1}.clamp-2{-webkit-line-clamp:2}.clamp-3{-webkit-line-clamp:3}.summary{color:var(--ink-soft)}.tag-preview{display:grid;gap:4px}.tag-preview-row{display:flex;align-items:center;min-width:0;gap:4px}.compact-tag{display:block;min-width:0;max-width:100%;overflow:hidden;padding-inline:7px;text-overflow:ellipsis}.tag-preview-row:last-child .compact-tag{flex:1}.tag-more{flex:none;color:var(--ink-faint);font:600 10px var(--font-mono);white-space:nowrap}.attention-cell{min-width:0}.attention-footer{margin-top:6px}.attention-footer>.muted{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row-action-cell{vertical-align:middle!important}.row-action-cell .btn{white-space:nowrap}.data-table tbody tr:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.market-link{display:block;border:0;background:transparent;padding:0;color:var(--accent-ink);text-align:left;cursor:pointer;font:inherit}.market-link:hover{text-decoration:underline}.industry-text{font-weight:600}.up{color:var(--up)}.down{color:var(--down)}
.member-detail-mask{position:fixed;inset:0;z-index:80;display:flex;justify-content:flex-end;background:var(--overlay)}.member-detail-panel{display:grid;width:min(620px,94vw);height:100%;grid-template-rows:auto minmax(0,1fr);overflow:hidden;background:var(--paper);border-left:1px solid var(--line);box-shadow:var(--shadow-lift);overscroll-behavior:contain}.member-detail-head{padding:14px 18px;border-bottom:1px solid var(--line);background:var(--card)}.member-detail-head>div:first-child{display:flex;align-items:center;min-width:0;gap:8px}.member-detail-head strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.detail-close{display:grid;width:30px;height:30px;place-items:center;border:1px solid var(--line);border-radius:var(--radius-sm);background:transparent;color:var(--ink-soft);font-size:19px;line-height:1;cursor:pointer}.detail-close:hover{border-color:var(--accent);color:var(--accent-ink)}.member-detail-scroll{min-height:0;overflow:auto;padding:18px 20px 48px}.detail-overview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0;margin:0;border-block:1px solid var(--line)}.detail-overview>div{padding:12px 10px}.detail-overview>div:nth-child(odd){border-right:1px solid var(--line)}.detail-overview dt{margin-bottom:4px;color:var(--ink-faint);font-size:11px}.detail-overview dd{margin:0;overflow-wrap:anywhere;line-height:1.55}.detail-section{padding:18px 2px;border-bottom:1px solid var(--line)}.detail-section h3{margin:0 0 8px;font-size:var(--fs-md)}.detail-section p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink-soft);line-height:1.65}.detail-section .btn{margin-top:12px}.detail-tags{display:flex;align-items:flex-start;flex-wrap:wrap;gap:6px}.detail-tags .badge{max-width:100%;white-space:normal;overflow-wrap:anywhere}
.member-focus{display:flex;align-items:center;gap:10px;margin-bottom:12px;border-color:var(--accent);background:var(--accent-soft)}.focused-row{outline:2px solid var(--accent);outline-offset:-2px;background:var(--accent-soft)}
@container business (max-width:720px){.pool-toolbar,.content-head{align-items:stretch;flex-direction:column}.board-search{width:100%;grid-template-columns:minmax(0,1fr) auto}.content-actions{align-self:flex-start}}
@media(max-width:720px){.pool-head{align-items:stretch;flex-direction:column}.member-detail-panel{width:100vw}.member-detail-head{align-items:flex-start}.member-detail-head>div:first-child{align-items:flex-start;flex-direction:column;gap:2px}.detail-overview{grid-template-columns:1fr}.detail-overview>div:nth-child(odd){border-right:0}.detail-overview>div+div{border-top:1px solid var(--line)}}
</style>
