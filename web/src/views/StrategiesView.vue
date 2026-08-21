<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { apiClient, type ApiFail } from "../api/client";
import type {
  CurrentStrategy,
  StrategyDocument,
  StrategyEvolution,
  StrategyProposal,
} from "../api/types";
import MarkdownView from "../components/MarkdownView.vue";
import StateBlock from "../components/StateBlock.vue";
import { useUiRefresh } from "../composables/useUiRefresh";
import { appMessage } from "../stores/message";
import { askAi } from "../utils/askAi";
import { buildDiffRows, diffStat, type DiffRow } from "../utils/diff";
import { fmtTime, shortHash } from "../utils/format";

const strategy = ref<CurrentStrategy | null>(null);
const proposals = ref<StrategyProposal[]>([]);
const evolutions = ref<StrategyEvolution[]>([]);
const selectedDocumentId = ref<string | null>(null);
const selectedProposalId = ref<string | null>(null);
const loading = ref(false);
const actionKey = ref<string | null>(null);
const error = ref<ApiFail | null>(null);
const route = useRoute();

const selectedDocument = computed<StrategyDocument | null>(() =>
  strategy.value?.documents.find((document) => document.id === selectedDocumentId.value)
  ?? strategy.value?.documents[0]
  ?? null,
);
const pendingProposals = computed(() => proposals.value.filter((proposal) => proposal.status === "pending"));
const selectedProposal = computed(() =>
  pendingProposals.value.find((proposal) => proposal.id === selectedProposalId.value)
  ?? pendingProposals.value[0]
  ?? null,
);
const selectedProposalChange = computed(() =>
  selectedProposal.value?.proposed_changes?.find(
    (change) => change.document_id === selectedDocument.value?.id,
  ) ?? null,
);
const proposalDiff = computed<DiffRow[] | null>(() => {
  const document = selectedDocument.value;
  const change = selectedProposalChange.value;
  return document && change ? buildDiffRows(document.current_content, change.content) : null;
});
const proposalDiffText = computed(() => {
  if (!proposalDiff.value) return null;
  const stat = diffStat(proposalDiff.value);
  return `+${stat.added} / −${stat.removed} 行`;
});

const ROLE_LABELS: Record<StrategyDocument["role"], string> = {
  portfolio: "组合总策略",
  short: "短线策略",
  long: "长线策略",
  guidance: "核心指引",
};
const ADOPTION_LABELS: Record<StrategyEvolution["adoption_status"], string> = {
  pending: "待审核",
  adopted: "已采纳",
  rejected: "未采纳",
};

async function loadAll(keepDocument = selectedDocumentId.value): Promise<void> {
  loading.value = true;
  error.value = null;
  const [currentResult, proposalResult, evolutionResult] = await Promise.all([
    apiClient.get<CurrentStrategy>("/api/strategy/current"),
    apiClient.get<StrategyProposal[]>("/api/strategy/proposals?limit=50"),
    apiClient.get<StrategyEvolution[]>("/api/strategy/evolutions?limit=50"),
  ]);
  loading.value = false;
  const failed = [currentResult, proposalResult, evolutionResult].find((result) => !result.ok);
  if (failed && !failed.ok) {
    error.value = failed;
    return;
  }
  if (currentResult.ok) strategy.value = currentResult.data;
  if (proposalResult.ok) proposals.value = proposalResult.data;
  if (evolutionResult.ok) evolutions.value = evolutionResult.data;
  const kept = strategy.value?.documents.find((document) => document.id === keepDocument);
  selectedDocumentId.value = kept?.id ?? strategy.value?.documents[0]?.id ?? null;
  const requestedProposal = typeof route.query.proposal === "string" ? route.query.proposal : null;
  if (requestedProposal && pendingProposals.value.some((proposal) => proposal.id === requestedProposal)) {
    selectedProposalId.value = requestedProposal;
  } else if (!pendingProposals.value.some((proposal) => proposal.id === selectedProposalId.value)) {
    selectedProposalId.value = pendingProposals.value[0]?.id ?? null;
  }
}

async function reviewToken(proposalId: string): Promise<string | null> {
  const result = await apiClient.get<{
    proposal: StrategyProposal;
    review: { token: string; expires_at: string };
  }>(`/api/strategy/proposals/${proposalId}/review`);
  if (!result.ok) {
    appMessage.error(result.message, { title: "无法开始策略审核" });
    return null;
  }
  return result.data.review.token;
}

async function approveProposal(proposal: StrategyProposal): Promise<void> {
  if (!window.confirm("确认发布这次策略调整？发布后将立即成为页面与 Agent 使用的当前策略。")) return;
  actionKey.value = `approve:${proposal.id}`;
  const token = await reviewToken(proposal.id);
  if (!token) {
    actionKey.value = null;
    return;
  }
  const result = await apiClient.post(`/api/strategy/proposals/${proposal.id}/approve`, {
    actor_type: "user",
    interaction_source: "strategy_page",
    review_token: token,
    decision_note: "当前策略页面人工确认发布",
  });
  actionKey.value = null;
  if (!result.ok) {
    appMessage.error(result.message, { title: result.status === 409 ? "策略基线已变化" : "发布失败" });
    await loadAll();
    return;
  }
  appMessage.success("策略已由真人确认发布，Agent 下一轮将使用最新正文", { title: "发布成功" });
  await loadAll();
}

async function rejectProposal(proposal: StrategyProposal): Promise<void> {
  const note = window.prompt("请填写不采纳原因（会进入简要演进记录）：");
  if (!note?.trim()) return;
  actionKey.value = `reject:${proposal.id}`;
  const token = await reviewToken(proposal.id);
  if (!token) {
    actionKey.value = null;
    return;
  }
  const result = await apiClient.post(`/api/strategy/proposals/${proposal.id}/reject`, {
    actor_type: "user",
    interaction_source: "strategy_page",
    review_token: token,
    decision_note: note.trim(),
  });
  actionKey.value = null;
  if (!result.ok) {
    appMessage.error(result.message, { title: "拒绝失败" });
    return;
  }
  appMessage.info("提案已标记为未采纳，拟议全文已清除", { title: "审核完成" });
  await loadAll();
}

function startEvolution(): void {
  const state = strategy.value?.state;
  askAi(
    `请基于当前最终策略（strategy_state.change_seq=${state?.change_seq ?? "请查询"}，current_hash=${state?.current_hash ?? "请查询"}）协助演进策略。先澄清演进目标，按需驱动回测验证；形成结论后使用 strategy_publish_request 一次提交大纲、结论、调整点、拟议全文和关联回测。工具只能创建待审核提案，不能代替我发布。`,
    "策略演进",
    { sessionType: "strategy_evolution", title: "策略演进" },
  );
}

useUiRefresh("strategies", () => loadAll());
onMounted(() => void loadAll());
watch(() => route.query.proposal, (id) => {
  if (typeof id === "string" && pendingProposals.value.some((proposal) => proposal.id === id)) {
    selectedProposalId.value = id;
  }
});
</script>

<template>
  <section>
    <div class="page-head strategy-head">
      <div>
        <h1>当前策略</h1>
        <div class="sub">页面与 Agent 始终使用最终策略 · 演进只保留摘要 · 每次发布必须真人确认</div>
      </div>
      <div class="head-actions">
        <span v-if="strategy" class="badge ok num">序号 {{ strategy.state.change_seq }} · {{ shortHash(strategy.state.current_hash) }}</span>
        <button class="btn primary agent-entry" type="button" @click="startEvolution">与 Agent 演进策略</button>
      </div>
    </div>

    <StateBlock :loading="loading" :error="error" :empty="!strategy" empty-text="当前策略尚未初始化" @retry="loadAll">
      <div v-if="pendingProposals.length" class="card review-card">
        <div class="section-head">
          <div>
            <div class="card-title">待真人审核（{{ pendingProposals.length }}）</div>
          </div>
        </div>
        <div class="proposal-tabs">
          <button
            v-for="proposal in pendingProposals"
            :key="proposal.id"
            class="proposal-tab"
            :class="{ active: selectedProposal?.id === proposal.id }"
            type="button"
            @click="selectedProposalId = proposal.id"
          >提案 #{{ proposal.id }} · {{ fmtTime(proposal.created_at) }}</button>
        </div>
        <template v-if="selectedProposal">
          <div class="proposal-summary">
            <div><span class="label">大纲</span><strong>{{ selectedProposal.outline }}</strong></div>
            <div><span class="label">结论</span><span>{{ selectedProposal.conclusion }}</span></div>
            <div><span class="label">调整点</span><ul><li v-for="item in selectedProposal.adjustments" :key="item">{{ item }}</li></ul></div>
            <div><span class="label">发布摘要</span><span>{{ selectedProposal.summary }}</span></div>
          </div>
          <div class="review-actions">
            <span class="muted">基线：序号 {{ selectedProposal.base_change_seq }} · {{ shortHash(selectedProposal.base_strategy_hash) }}</span>
            <button class="btn" type="button" :disabled="actionKey !== null" @click="rejectProposal(selectedProposal)">不采纳</button>
            <button class="btn primary" type="button" :disabled="actionKey !== null" @click="approveProposal(selectedProposal)">
              {{ actionKey === `approve:${selectedProposal.id}` ? "发布中…" : "真人确认并发布" }}
            </button>
          </div>
        </template>
      </div>

      <div class="strategy-layout">
        <aside class="card document-list">
          <div class="card-title">最终策略文档（{{ strategy?.documents.length ?? 0 }}）</div>
          <button
            v-for="document in strategy?.documents"
            :key="document.id"
            class="document-item"
            :class="{ active: selectedDocument?.id === document.id }"
            type="button"
            @click="selectedDocumentId = document.id"
          >
            <strong>{{ document.title }}</strong>
            <span>{{ ROLE_LABELS[document.role] }} · 技术修订 {{ document.current_revision_no }}</span>
          </button>
        </aside>

        <main class="card strategy-reader">
          <template v-if="selectedDocument">
            <div class="reader-head">
              <div>
                <div class="card-title">{{ selectedDocument.title }}</div>
                <p class="card-desc num">{{ selectedDocument.code }} · {{ shortHash(selectedDocument.current_sha256) }} · {{ fmtTime(selectedDocument.updated_at) }}</p>
              </div>
              <span v-if="selectedProposalChange" class="badge warn num">待审差异 {{ proposalDiffText }}</span>
            </div>
            <div v-if="proposalDiff" class="diff-view">
              <div class="diff-note">当前最终正文 → 待审拟议正文</div>
              <div v-for="(row, index) in proposalDiff" :key="index" class="diff-line" :class="row.type">
                <template v-if="row.type === 'gap'">· 相同内容省略 {{ row.count }} 行 ·</template>
                <template v-else><span class="sign">{{ row.type === "add" ? "+" : row.type === "del" ? "−" : " " }}</span>{{ row.text }}</template>
              </div>
            </div>
            <MarkdownView v-else :source="selectedDocument.current_content" />
          </template>
        </main>
      </div>

      <div class="card evolution-card">
        <div class="card-title">策略演进摘要</div>
        <div v-if="evolutions.length" class="evolution-list">
          <article v-for="evolution in evolutions" :key="evolution.id" class="evolution-item">
            <div class="evolution-meta">
              <span class="badge" :class="evolution.adoption_status === 'adopted' ? 'ok' : evolution.adoption_status === 'pending' ? 'warn' : ''">{{ ADOPTION_LABELS[evolution.adoption_status] }}</span>
              <span class="num">{{ fmtTime(evolution.decided_at ?? evolution.created_at) }}</span>
              <span v-if="evolution.backtest_run_ids.length" class="muted">关联回测 {{ evolution.backtest_run_ids.map((id) => `#${id}`).join("、") }}</span>
            </div>
            <strong>{{ evolution.outline }}</strong>
            <p>{{ evolution.conclusion }}</p>
            <ul><li v-for="item in evolution.adjustments" :key="item">{{ item }}</li></ul>
          </article>
        </div>
        <p v-else class="muted">暂无策略演进记录；迁移只建立当前最终策略，不伪造历史。</p>
      </div>
    </StateBlock>
  </section>
</template>

<style scoped>
.strategy-head,.head-actions,.section-head,.reader-head,.review-actions,.evolution-meta{display:flex;align-items:center;justify-content:space-between;gap:12px}.head-actions{justify-content:flex-end}.review-card{margin-bottom:16px;border-color:color-mix(in srgb,var(--accent) 38%,var(--line))}.section-head{align-items:flex-start}.card-desc{margin:5px 0 0}.proposal-tabs{display:flex;gap:7px;overflow:auto;margin:14px 0 10px}.proposal-tab{border:1px solid var(--line);border-radius:999px;padding:6px 11px;background:var(--paper);color:var(--ink-soft);white-space:nowrap;cursor:pointer}.proposal-tab.active{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-ink)}.proposal-summary{display:grid;gap:8px;padding:12px;border-radius:var(--radius-sm);background:var(--paper-deep)}.proposal-summary>div{display:grid;grid-template-columns:76px minmax(0,1fr);gap:10px}.proposal-summary .label{color:var(--ink-faint);font-size:12px}.proposal-summary ul,.evolution-item ul{margin:0;padding-left:18px}.review-actions{justify-content:flex-end;margin-top:12px}.strategy-layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:14px}.document-list{align-self:start;padding:10px}.document-list>.card-title{padding:6px 8px 10px}.document-item{display:grid;gap:4px;width:100%;padding:9px;border:0;border-radius:var(--radius-sm);background:transparent;color:inherit;text-align:left;cursor:pointer}.document-item:hover,.document-item.active{background:var(--accent-soft)}.document-item span{color:var(--ink-faint);font-size:11px}.strategy-reader{min-width:0}.reader-head{align-items:flex-start;padding-bottom:12px;border-bottom:1px solid var(--line)}.diff-view{margin-top:14px;overflow:auto;border:1px solid var(--line);border-radius:var(--radius-sm);font:12px/1.65 var(--font-mono)}.diff-note{padding:8px 12px;background:var(--paper-deep);color:var(--ink-soft)}.diff-line{padding:1px 10px;white-space:pre-wrap;word-break:break-word}.diff-line.add{background:var(--down-bg)}.diff-line.del{background:var(--up-bg)}.diff-line.gap{text-align:center;color:var(--ink-faint);background:var(--paper-deep)}.sign{display:inline-block;width:18px}.evolution-card{margin-top:16px}.evolution-list{display:grid;gap:10px;margin-top:13px}.evolution-item{padding:12px 0;border-top:1px solid var(--line)}.evolution-item:first-child{border-top:0}.evolution-meta{justify-content:flex-start;margin-bottom:7px}.evolution-item p{margin:6px 0;color:var(--ink-soft);white-space:pre-wrap}.muted{color:var(--ink-faint);font-size:12px}@container business (max-width:760px){.strategy-head,.head-actions,.review-actions{align-items:flex-start;flex-direction:column}.strategy-layout{grid-template-columns:1fr}.document-list{display:flex;gap:6px;overflow:auto}.document-list>.card-title{display:none}.document-item{min-width:170px}.proposal-summary>div{grid-template-columns:1fr}}
</style>
