<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { apiClient, type ApiFail } from "../api/client";
import type { CurrentStrategy, StrategyDocument } from "../api/types";
import MarkdownView from "../components/MarkdownView.vue";
import StateBlock from "../components/StateBlock.vue";
import { useUiRefresh } from "../composables/useUiRefresh";
import { shortHash, fmtTime } from "../utils/format";

const strategy = ref<CurrentStrategy | null>(null);
const selectedDocumentId = ref<string | null>(null);
const loading = ref(false);
const error = ref<ApiFail | null>(null);

const selectedDocument = computed<StrategyDocument | null>(() =>
  strategy.value?.documents.find((document) => document.id === selectedDocumentId.value)
  ?? strategy.value?.documents[0]
  ?? null,
);

const ROLE_LABELS: Record<StrategyDocument["role"], string> = {
  portfolio: "组合总策略",
  task: "任务策略",
  guidance: "核心指引",
};

async function loadAll(keepDocument = selectedDocumentId.value): Promise<void> {
  loading.value = true;
  error.value = null;
  const result = await apiClient.get<CurrentStrategy>("/api/strategy/current");
  loading.value = false;
  if (!result.ok) {
    error.value = result;
    return;
  }
  strategy.value = result.data;
  const kept = strategy.value?.documents.find((document) => document.id === keepDocument);
  selectedDocumentId.value = kept?.id ?? strategy.value?.documents[0]?.id ?? null;
}

useUiRefresh("strategies", () => loadAll());
onMounted(() => void loadAll());
</script>

<template>
  <section>
    <div class="page-head strategy-head">
      <div>
        <h1>当前策略</h1>
        <div class="sub">组合总策略统筹 · 每个定时任务对应一份任务策略 · 正文随本地回测结论经迁移维护</div>
      </div>
      <div class="head-actions">
        <span v-if="strategy" class="badge ok num">序号 {{ strategy.state.change_seq }} · {{ shortHash(strategy.state.current_hash) }}</span>
      </div>
    </div>

    <StateBlock :loading="loading" :error="error" :empty="!strategy" empty-text="当前策略尚未初始化" @retry="loadAll">
      <div class="strategy-layout">
        <aside class="card document-list">
          <div class="card-title">策略文档（{{ strategy?.documents.length ?? 0 }}）</div>
          <button
            v-for="document in strategy?.documents"
            :key="document.id"
            class="document-item"
            :class="{ active: selectedDocument?.id === document.id }"
            type="button"
            @click="selectedDocumentId = document.id"
          >
            <strong>{{ document.title }}</strong>
            <span>{{ ROLE_LABELS[document.role] }}</span>
          </button>
        </aside>

        <main class="card strategy-reader">
          <template v-if="selectedDocument">
            <div class="reader-head">
              <div>
                <div class="card-title">{{ selectedDocument.title }}</div>
                <p class="card-desc num">{{ selectedDocument.code }}<template v-if="selectedDocument.job_code"> · 任务 {{ selectedDocument.job_code }}</template> · {{ shortHash(selectedDocument.sha256) }} · {{ fmtTime(selectedDocument.updated_at) }}</p>
              </div>
              <span class="badge">{{ ROLE_LABELS[selectedDocument.role] }}</span>
            </div>
            <MarkdownView :source="selectedDocument.content" />
          </template>
        </main>
      </div>
    </StateBlock>
  </section>
</template>

<style scoped>
.strategy-head,.head-actions,.reader-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.head-actions{justify-content:flex-end}.reader-head{align-items:flex-start;padding-bottom:12px;border-bottom:1px solid var(--line)}.card-desc{margin:5px 0 0}
.strategy-layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:14px}.document-list{align-self:start;padding:10px}.document-list>.card-title{padding:6px 8px 10px}.document-item{display:grid;gap:4px;width:100%;padding:9px;border:0;border-radius:var(--radius-sm);background:transparent;color:inherit;text-align:left;cursor:pointer}.document-item:hover,.document-item.active{background:var(--accent-soft)}.document-item span{color:var(--ink-faint);font-size:11px}.strategy-reader{min-width:0}.muted{color:var(--ink-faint);font-size:12px}@container business (max-width:760px){.strategy-head,.head-actions{align-items:flex-start;flex-direction:column}.strategy-layout{grid-template-columns:1fr}.document-list{display:flex;gap:6px;overflow:auto}.document-list>.card-title{display:none}.document-item{min-width:170px}}
</style>
