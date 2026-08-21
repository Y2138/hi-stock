<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { apiClient } from "../api/client";
import type { AgentMemory } from "../api/types";
import MarkdownView from "../components/MarkdownView.vue";
import ResultLink from "../components/ResultLink.vue";
import StateBlock from "../components/StateBlock.vue";
import UiInput from "../components/ui/UiInput.vue";
import UiSelect from "../components/ui/UiSelect.vue";
import { useResource } from "../composables/useResource";
import { useUiRefresh } from "../composables/useUiRefresh";
import { askAi, openAgentSession } from "../utils/askAi";
import { fmtTime } from "../utils/format";

const CATEGORY_LABELS: Record<string, string> = { research_method: "研究方法", evaluation_template: "评估模板", data_source_knowledge: "数据源经验", task_playbook: "任务编排", incident_resolution: "故障恢复", user_preference: "长期偏好" };
const STATUS_LABELS: Record<string, string> = { active: "有效", review_required: "待复核", superseded: "已替代", deprecated: "已废弃" };
const CATEGORY_OPTIONS = [
  { value: "", label: "全部类型" },
  ...Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label })),
];
const STATUS_OPTIONS = Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }));
const keyword = ref("");
const category = ref("");
const status = ref("active");
const selectedId = ref<string | null>(null);
const route = useRoute();
const path = computed(() => {
  const query = new URLSearchParams({ limit: "100" });
  if (keyword.value.trim()) query.set("q", keyword.value.trim());
  if (category.value) query.set("category", category.value);
  if (status.value) query.set("status", status.value);
  return `/api/memories?${query}`;
});
const memories = useResource<AgentMemory[]>(() => apiClient.get<AgentMemory[]>(path.value));
const selected = computed(() => (memories.data.value ?? []).find((memory) => memory.id === selectedId.value) ?? null);

async function reload(): Promise<void> {
  await memories.reload();
  const requested = typeof route.query.memory === "string" ? route.query.memory : null;
  if (requested && memories.data.value?.some((memory) => memory.id === requested)) selectedId.value = requested;
  else if (!selected.value) selectedId.value = memories.data.value?.[0]?.id ?? null;
}
function createWithAgent(): void {
  askAi("请判断本轮是否产生了已经验证且长期可复用的产物。只有研究方法、评估模板、数据源经验、任务编排、故障恢复或我确认的长期偏好才使用 memory_write；不要保存业务事实、策略正文、密钥、临时代码或一次性对话。", "沉淀可复用记忆");
}
function maintainWithAgent(memory: AgentMemory): void {
  askAi(`请读取 Agent 记忆 #${memory.id} 的当前内容和 updated_at=${memory.updated_at}。根据我的后续要求选择 update、supersede 或 deprecate；先核对证据和最后验证时间，不得复制当前业务事实。`, `维护记忆 #${memory.id}`);
}
useUiRefresh("memories", reload);
onMounted(reload);
watch(() => route.query.memory, (id) => {
  if (typeof id === "string" && memories.data.value?.some((memory) => memory.id === id)) selectedId.value = id;
});
</script>

<template>
  <section>
    <div class="page-head memory-head"><div><h1>Agent 记忆</h1><div class="sub">只保存经验证的可复用产物 · 当前数据库事实和当前策略始终优先</div></div><button class="btn primary agent-entry" type="button" @click="createWithAgent">通过 Agent 沉淀</button></div>
    <div class="card filters">
      <UiInput v-model="keyword" placeholder="搜索标题、摘要或正文" @keyup.enter="reload" />
      <UiSelect v-model="category" :options="CATEGORY_OPTIONS" aria-label="记忆类型" />
      <UiSelect v-model="status" :options="STATUS_OPTIONS" aria-label="记忆状态" />
      <button class="btn" type="button" @click="reload">查询</button>
    </div>
    <StateBlock :loading="memories.loading.value" :error="memories.error.value" :empty="(memories.data.value?.length ?? 0) === 0" empty-text="当前筛选没有记忆" @retry="reload">
      <div class="memory-layout">
        <aside class="card memory-list">
          <button v-for="memory in memories.data.value" :key="memory.id" type="button" :class="{ active: selectedId === memory.id }" @click="selectedId = memory.id">
            <strong>{{ memory.title }}</strong><span>{{ CATEGORY_LABELS[memory.category] }} · {{ STATUS_LABELS[memory.status] }}</span><small>{{ memory.summary }}</small>
          </button>
        </aside>
        <main v-if="selected" class="card memory-detail">
          <div class="detail-head"><div><div class="card-title">{{ selected.title }}</div><p class="card-desc">{{ CATEGORY_LABELS[selected.category] }} · {{ STATUS_LABELS[selected.status] }} · 范围：{{ selected.scope }}</p></div><div class="detail-actions"><ResultLink :result="{ type: 'memory', id: selected.id }" label="专注阅读" /><button class="btn agent-entry" type="button" @click="maintainWithAgent(selected)">通过 Agent 维护</button></div></div>
          <div class="tags"><span v-for="tag in selected.tags" :key="tag" class="badge">{{ tag }}</span></div>
          <h3>摘要</h3><p>{{ selected.summary }}</p>
          <h3>可复用产物</h3><MarkdownView :source="selected.content" />
          <h3>证据</h3><p>{{ selected.evidence }}</p>
          <dl class="kv"><dt>最后验证</dt><dd>{{ fmtTime(selected.last_verified_at) }}</dd><dt>来源</dt><dd><button class="link-button agent-entry" type="button" @click="openAgentSession(selected.source_session_id)">Agent 会话 #{{ selected.source_session_id }}</button><template v-if="selected.source_run_id"> · {{ selected.source_run_type }} #{{ selected.source_run_id }}</template></dd><dt>更新时间</dt><dd>{{ fmtTime(selected.updated_at) }}</dd><dt>替代对象</dt><dd>{{ selected.supersedes_id ? `#${selected.supersedes_id}` : "—" }}</dd></dl>
        </main>
      </div>
    </StateBlock>
  </section>
</template>

<style scoped>
.memory-head,.detail-head,.filters,.detail-actions{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.filters{align-items:center;margin-bottom:12px}.detail-actions{align-items:center;justify-content:flex-end}.filters :deep(input){min-width:280px}.filters :deep(.ui-select){min-width:140px}.memory-layout{display:grid;grid-template-columns:minmax(260px,34%) minmax(0,1fr);gap:12px}.memory-list{padding:8px;display:grid;gap:4px;align-self:start}.memory-list button{display:grid;gap:3px;padding:10px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--ink);text-align:left;cursor:pointer}.memory-list button:hover,.memory-list button.active{border-color:var(--accent);background:var(--accent-soft)}.memory-list span,.memory-list small{color:var(--ink-faint)}.memory-list small{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.memory-detail h3{margin:18px 0 6px;font-size:13px;color:var(--ink-soft)}.tags{display:flex;gap:4px;flex-wrap:wrap}.link-button{border:0;background:transparent;color:var(--accent-ink);padding:0;cursor:pointer}@media(max-width:900px){.memory-layout{grid-template-columns:1fr}.filters,.detail-head{align-items:stretch;flex-direction:column}.filters :deep(input),.filters :deep(.ui-select){min-width:0;width:100%}}
</style>
