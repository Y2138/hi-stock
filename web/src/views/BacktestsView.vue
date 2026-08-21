<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { apiClient } from "../api/client";
import type { BacktestDetail, BacktestListItem } from "../api/types";
import MarkdownView from "../components/MarkdownView.vue";
import ResultLink from "../components/ResultLink.vue";
import StateBlock from "../components/StateBlock.vue";
import { useResource } from "../composables/useResource";
import { useUiRefresh } from "../composables/useUiRefresh";
import { appMessage } from "../stores/message";
import { askAi, openAgentSession } from "../utils/askAi";
import { fmtTime, prettyJson } from "../utils/format";

const KIND_LABELS: Record<string, string> = { formal: "发布验证", research: "研究" };
const ORIGIN_LABELS: Record<string, string> = {
  agent_workspace: "Agent 临时工作区",
  service: "旧服务回测",
  legacy: "历史记录",
};
const EXECUTION_LABELS: Record<string, string> = {
  legacy: "历史记录",
  queued: "排队中",
  running: "计算中",
  success: "成功",
  partial: "部分成功",
  failed: "失败",
};

const list = useResource<BacktestListItem[]>(() => apiClient.get<BacktestListItem[]>("/api/backtests"));
const detailId = ref<string | null>(null);
const detail = useResource<BacktestDetail>(() => apiClient.get<BacktestDetail>(`/api/backtests/${detailId.value}`));
const compareIds = ref<string[]>([]);
const route = useRoute();
const compareRuns = computed(() =>
  (list.data.value ?? []).filter((run) => compareIds.value.includes(run.id)),
);

function statusClass(run: BacktestListItem): string {
  if (run.execution_status === "success") return "ok";
  if (run.execution_status === "failed") return "bad";
  if (run.execution_status === "partial" || run.execution_status === "queued") return "warn";
  return "";
}

function metric(value: unknown, suffix = ""): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}${suffix}` : "—";
}

function shortHash(value: string | null): string {
  return value ? `${value.slice(0, 10)}…` : "—";
}

function jsonOrEmpty(value: unknown): string {
  return prettyJson(value) ?? "未记录";
}

async function openDetail(run: Pick<BacktestListItem, "id">): Promise<void> {
  detailId.value = run.id;
  detail.data.value = null;
  await detail.reload();
}

function toggleCompare(id: string): void {
  compareIds.value = compareIds.value.includes(id)
    ? compareIds.value.filter((item) => item !== id)
    : [...compareIds.value, id].slice(-6);
}

function startAgentBacktest(): void {
  askAi(
    [
      "我想验证一个策略思路。请先询问我本次要验证的假设、标的范围和时间区间；不要替我猜交易规则。",
      "确认目标后，从 PostgreSQL 读取最新 strategy_state 与相关策略正文，并按需读取历史 backtest_run/backtest_run_comparison。",
      "请自行编写临时 TypeScript，通过 run_backtest 在隔离环境执行；源码只放工具参数，禁止复制到普通回复。",
      "可以在同一会话继续试验和反证；证据完整后使用 finalize_backtest 生成最终结论提案，明确摘要与适用边界。只有最终结论进入回测历史。",
      "若建议调整策略，只能引用已确认的最终回测并创建 strategy_publish_request 待审提案，策略发布必须由我在当前策略页人工确认。",
    ].join("\n"),
    "Agent 回测验证",
    { sessionType: "backtest", title: "Agent 回测验证" },
  );
}

function continueFrom(run: BacktestDetail): void {
  askAi(
    `请读取回测 #${run.id} 的研究大纲、假设、策略快照、输入摘要、指标、结论和缺口。先说明它还缺什么证据，再询问我要延续、修改还是反证这个思路；如需新验证，使用 run_backtest 并把 #${run.id} 放入 comparison_run_ids。源码只能进入工具参数，不能出现在普通回复。`,
    `延续回测 #${run.id}`,
    {
      sessionType: "backtest",
      parentSessionId: run.session_id,
      title: `延续回测 #${run.id}`,
      confirmation: `确认基于回测 #${run.id} 新建延续会话？\n\n系统会带入原回测上下文，但不会自动执行或发送。`,
    },
  );
}

function compareSelected(): void {
  if (compareRuns.value.length < 2) {
    appMessage.warning("请先勾选至少两条回测记录", { title: "无法对比" });
    return;
  }
  const ids = compareRuns.value.map((run) => `#${run.id}`).join("、");
  askAi(
    `请从 PostgreSQL 对比回测 ${ids}。逐项比较研究大纲、待验证假设、策略快照哈希、输入覆盖、核心指标、结论和数据缺口；指出差异是否来自策略调整、样本变化或实现口径。只做证据比较，不生成新的买卖建议。如需补充验证，先征得我同意，再用 run_backtest 建立 comparison_run_ids 关系。`,
    `对比 ${compareRuns.value.length} 条回测`,
    { sessionType: "backtest", title: `对比 ${compareRuns.value.length} 条回测` },
  );
}

async function reloadAll(): Promise<void> {
  await list.reload();
  if (detailId.value) await detail.reload();
}

useUiRefresh("backtests", reloadAll);
onMounted(async () => {
  await list.reload();
  const requested = typeof route.query.run === "string" ? route.query.run : null;
  const first = list.data.value?.find((run) => run.id === requested) ?? list.data.value?.[0];
  if (first) await openDetail(first);
});
watch(() => route.query.run, (id) => {
  if (typeof id !== "string" || id === detailId.value) return;
  const run = list.data.value?.find((item) => item.id === id);
  if (run) void openDetail(run);
});
</script>

<template>
  <section>
    <div class="page-head backtest-head">
      <div>
        <h1>回测验证</h1>
        <div class="sub">默认只展示每次研究过程确认后的最终结论 · 中间运行不污染历史</div>
      </div>
      <button class="btn primary agent-entry" type="button" @click="startAgentBacktest">让 Agent 验证策略思路</button>
    </div>

    <div class="compare-bar">
      <span>已选 {{ compareIds.length }} 条（最多 6 条）</span>
      <button class="btn compact ai-btn agent-entry" type="button" :disabled="compareIds.length < 2" @click="compareSelected">让 Agent 对比</button>
      <button v-if="compareIds.length" class="btn compact" type="button" @click="compareIds = []">清空</button>
      <span class="spacer"></span>
      <button class="btn compact" type="button" @click="reloadAll">刷新</button>
    </div>

    <StateBlock
      :loading="list.loading.value"
      :error="list.error.value"
      :empty="(list.data.value?.length ?? 0) === 0"
      empty-text="暂无回测结论；点击“让 Agent 验证策略思路”开始"
      @retry="reloadAll"
    >
      <div class="backtest-layout">
        <aside class="card run-list" aria-label="回测历史">
          <div class="card-title">历史结论（{{ list.data.value?.length ?? 0 }}）</div>
          <button
            v-for="run in list.data.value"
            :key="run.id"
            class="run-item"
            :class="{ active: detailId === run.id }"
            type="button"
            @click="openDetail(run)"
          >
            <span class="compare-check" @click.stop="toggleCompare(run.id)">
              <input type="checkbox" :checked="compareIds.includes(run.id)" tabindex="-1" />
            </span>
            <span class="run-main">
              <strong>{{ run.name }}</strong>
              <small>#{{ run.id }} · {{ KIND_LABELS[run.kind] ?? run.kind }} · {{ fmtTime(run.created_at) }}</small>
            </span>
            <span class="badge ok">最终</span>
          </button>
        </aside>

        <main class="card result-preview">
          <StateBlock :loading="detail.loading.value" :error="detail.error.value" :empty="!detail.data.value" empty-text="选择一条回测查看结论" @retry="detail.reload">
            <template v-if="detail.data.value">
              <div class="detail-head">
                <div>
                  <div class="card-title">{{ detail.data.value.name }}</div>
                  <p class="card-desc">
                    #{{ detail.data.value.id }} · {{ ORIGIN_LABELS[detail.data.value.execution_origin] ?? detail.data.value.execution_origin }}
                    <span v-if="detail.data.value.is_active_anchor"> · 历史正式锚点</span>
                  </p>
                </div>
                <div class="detail-actions">
                  <ResultLink :result="{ type: 'backtest-result', id: detail.data.value.id }" label="专注阅读" />
                  <button v-if="detail.data.value.session_id" class="btn compact agent-entry" type="button" @click="openAgentSession(detail.data.value.session_id)">打开来源会话</button>
                  <button class="btn compact ai-btn agent-entry" type="button" @click="continueFrom(detail.data.value)">延续这个思路</button>
                </div>
              </div>

              <div class="metric-grid">
                <div><span>总收益</span><strong>{{ metric(detail.data.value.metrics_json?.total_return_pct, "%") }}</strong></div>
                <div><span>年化收益</span><strong>{{ metric(detail.data.value.metrics_json?.annualized_return_pct, "%") }}</strong></div>
                <div><span>最大回撤</span><strong>{{ metric(detail.data.value.metrics_json?.max_drawdown_pct, "%") }}</strong></div>
                <div><span>年化波动</span><strong>{{ metric(detail.data.value.metrics_json?.annualized_volatility_pct, "%") }}</strong></div>
              </div>

              <dl class="kv detail-kv">
                <dt>执行状态</dt><dd><span class="badge" :class="statusClass(detail.data.value)">{{ EXECUTION_LABELS[detail.data.value.execution_status] }}</span> · {{ detail.data.value.progress }}%</dd>
                <dt>最终结论摘要</dt><dd>{{ detail.data.value.conclusion_summary ?? "—" }}</dd>
                <dt>适用边界</dt><dd>{{ detail.data.value.applicability_boundary ?? "—" }}</dd>
                <dt>确认时间</dt><dd class="num">{{ fmtTime(detail.data.value.finalized_at) ?? "—" }}</dd>
                <dt>研究大纲</dt><dd>{{ detail.data.value.research_outline ?? "历史记录未保存" }}</dd>
                <dt>待验证假设</dt><dd>{{ detail.data.value.hypothesis ?? "历史记录未保存" }}</dd>
                <dt>策略快照</dt><dd class="num">序号 {{ detail.data.value.strategy_change_seq ?? "—" }} · {{ shortHash(detail.data.value.strategy_snapshot_hash) }}</dd>
                <dt>工作器 / SDK</dt><dd class="num">{{ detail.data.value.worker_version ?? detail.data.value.service_version ?? "历史记录" }} / {{ detail.data.value.sdk_version ?? "—" }}</dd>
                <dt>临时代码</dt><dd class="num">
                  {{ detail.data.value.code_cleanup_status === "deleted" ? "已删除" : detail.data.value.code_cleanup_status === "cleanup_failed" ? "清理失败，结果未采纳" : "不适用" }}
                  <template v-if="detail.data.value.source_sha256"> · SHA {{ shortHash(detail.data.value.source_sha256) }} · {{ detail.data.value.source_size_bytes }} B</template>
                </dd>
                <dt>开始 / 完成</dt><dd class="num">{{ fmtTime(detail.data.value.started_at) ?? "—" }} → {{ fmtTime(detail.data.value.finished_at) ?? "—" }}</dd>
              </dl>

              <template v-if="detail.data.value.conclusion_md">
                <h3 class="detail-sub">回测结论</h3>
                <MarkdownView :source="detail.data.value.conclusion_md" />
              </template>
              <p v-if="detail.data.value.error_message" class="bad-text">{{ detail.data.value.error_message }}</p>

              <template v-if="detail.data.value.comparisons.length">
                <h3 class="detail-sub">本次关联的历史对比</h3>
                <div class="comparison-list">
                  <button v-for="prior in detail.data.value.comparisons" :key="prior.id" type="button" @click="openDetail(prior)">
                    <strong>#{{ prior.id }} {{ prior.name }}</strong>
                    <span>{{ prior.research_outline ?? "历史记录未保存研究大纲" }}</span>
                  </button>
                </div>
              </template>

              <details>
                <summary>输入摘要与数据缺口</summary>
                <h3 class="detail-sub">请求配置（不含源码）</h3>
                <pre class="json-view num">{{ jsonOrEmpty(detail.data.value.request_json ?? detail.data.value.config_snapshot) }}</pre>
                <h3 class="detail-sub">输入摘要</h3>
                <pre class="json-view num">{{ jsonOrEmpty(detail.data.value.input_summary) }}</pre>
                <h3 class="detail-sub">数据缺口</h3>
                <pre class="json-view num">{{ jsonOrEmpty(detail.data.value.data_gaps) }}</pre>
              </details>
            </template>
          </StateBlock>
        </main>
      </div>
    </StateBlock>
  </section>
</template>

<style scoped>
.detail-actions{display:flex;align-items:center;gap:8px}
.backtest-head,.detail-head,.compare-bar{display:flex;align-items:center;justify-content:space-between;gap:12px}.compare-bar{justify-content:flex-start;margin:0 0 10px;color:var(--ink-soft);font-size:12px}.compare-bar .spacer{flex:1}.backtest-layout{display:grid;grid-template-columns:minmax(260px,32%) minmax(0,1fr);gap:12px;align-items:start}.run-list{padding:12px;max-height:calc(100vh - 245px);overflow:auto}.run-list>.card-title{padding:2px 4px 10px}.run-item{display:grid;width:100%;grid-template-columns:24px minmax(0,1fr) auto;gap:8px;align-items:center;padding:10px 8px;border:1px solid transparent;border-radius:var(--radius-sm);background:transparent;color:var(--ink);text-align:left;cursor:pointer}.run-item:hover{background:var(--paper-deep)}.run-item.active{border-color:var(--accent);background:var(--accent-soft)}.compare-check{display:grid;place-items:center}.compare-check input{pointer-events:none}.run-main{display:grid;gap:3px;min-width:0}.run-main strong{overflow:hidden;font-size:12.5px;text-overflow:ellipsis;white-space:nowrap}.run-main small{overflow:hidden;color:var(--ink-faint);font-size:10.5px;text-overflow:ellipsis;white-space:nowrap}.result-preview{min-width:0;padding:18px 20px}.detail-head{margin-bottom:12px}.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:14px 0}.metric-grid div{display:grid;gap:4px;padding:10px;border-radius:9px;background:var(--paper-deep)}.metric-grid span{color:var(--ink-soft);font-size:11px}.metric-grid strong{font-family:var(--font-mono)}.detail-kv{grid-template-columns:100px minmax(0,1fr)}.detail-kv dd{overflow-wrap:anywhere}.detail-sub{margin:18px 0 7px;color:var(--ink-soft);font-size:12.5px;font-weight:600}.comparison-list{display:grid;gap:7px}.comparison-list button{display:grid;gap:3px;padding:9px 11px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--paper-deep);color:var(--ink);text-align:left;cursor:pointer}.comparison-list button:hover{border-color:var(--accent)}.comparison-list span{color:var(--ink-soft);font-size:11.5px}details{margin-top:18px;border-top:1px solid var(--line);padding-top:12px}summary{color:var(--ink-soft);font-size:12px;cursor:pointer}.json-view{max-height:220px;overflow:auto;margin:0;padding:10px 12px;border-radius:var(--radius-sm);background:var(--paper-deep);font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-all}
@container business (max-width:760px){.backtest-layout{grid-template-columns:1fr}.run-list{max-height:320px}.metric-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:900px){.backtest-head{align-items:flex-start;flex-direction:column}.backtest-layout{grid-template-columns:1fr}.run-list{max-height:300px}.metric-grid{grid-template-columns:repeat(2,1fr)}}
</style>
