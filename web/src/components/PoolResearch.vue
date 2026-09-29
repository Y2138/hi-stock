<script setup lang="ts">
import { onMounted } from "vue";
import { apiClient } from "../api/client";
import type { PoolResearch } from "../api/types";
import { useResource } from "../composables/useResource";
import { fmtNum, fmtPrice } from "../utils/format";
import StateBlock from "./StateBlock.vue";

const props = defineProps<{ code: string }>();
const research = useResource(() => apiClient.get<PoolResearch[]>(`/api/pools/${encodeURIComponent(props.code)}/research`));
onMounted(research.reload);

const conditionLabels: Record<string, string> = {
  volume_contracted: "成交量收缩", reversal_candle: "反转形态", rsi_oversold: "RSI 超卖",
  reward_risk_acceptable: "收益风险比", confirmation_window_available: "确认价格窗口", low_within_30_days: "低点时间窗口",
  rebound_8_to_15: "低点反弹幅度", drawdown_15_to_40: "高点回撤幅度", macro_two_of_three: "宏观条件",
};
const metricLabels: Record<string, [string, string]> = {
  volume_ratio_5: ["5 日量比", "倍"], rsi14: ["RSI14", ""],
  target_price: ["评估目标价", "元"], initial_stop: ["初始止损价", "元"],
  expected_reward_risk: ["预期收益风险比", "倍"],
  stock_return_5: ["个股 5 日收益", "%"], relative_return_5: ["相对行业 5 日收益", "%"],
  board_return_5: ["行业 5 日收益", "%"], board_return_500: ["行业 500 日收益", "%"],
  board_drawdown_20: ["行业 20 日回撤", "%"], ma250_deviation: ["相对 MA250 偏离", "%"],
  drawdown_20: ["20 日回撤", "%"], return_5: ["5 日收益", "%"],
  rebound_60: ["较 60 日低点反弹", "%"], drawdown_252: ["较 252 日高点回撤", "%"],
  low_age: ["低点距今", "个交易日"],
};
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function conditions(evidence: Record<string, unknown>) {
  return Object.entries({ ...record(evidence.conditions),
    ...(typeof record(evidence.evidence).confirmation_window_available === "boolean"
      ? { confirmation_window_available: record(evidence.evidence).confirmation_window_available } : {}),
  }).filter(([, value]) => typeof value === "boolean")
    .map(([key, passed]) => ({ label: conditionLabels[key] ?? key, passed }));
}
function metrics(evidence: Record<string, unknown>) {
  const values = { ...evidence, ...record(evidence.evidence) };
  return Object.entries(metricLabels).flatMap(([key, [label, unit]]) => {
    const value = values[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return [];
    return [{ label, value: `${fmtNum(Number((unit === "%" ? value * 100 : value).toFixed(2)))}${unit}` }];
  });
}
</script>

<template>
  <section class="research-section">
    <div class="research-heading"><h3>策略分析依据</h3><span class="research-note">当前关注关联评估 · 非实时</span></div>
    <StateBlock :loading="research.loading.value" :error="research.error.value" :empty="!research.data.value?.length" empty-text="暂无关联的关注评估，已有研究记录见下方。" :skeleton-rows="3" @retry="research.reload">
      <article v-for="item in research.data.value" :key="item.attention_id" class="research-entry">
        <div class="research-heading">
          <strong>{{ item.strategy_name ?? '人工关注' }}</strong>
          <span v-if="item.run_id" class="badge" :class="item.status === 'qualified' ? 'ok' : 'warn'">{{ item.status === 'qualified' ? '信号已成立' : item.status === 'approaching' ? '待补信号' : '人工关注' }}</span>
        </div>
        <template v-if="item.run_id && item.evidence">
          <p class="research-note" :title="`策略版本 ${item.strategy_runtime_version} · 评估 #${item.run_id}`">评估 {{ item.target_date }}<template v-if="item.data_date !== item.target_date"> · 数据 {{ item.data_date ?? '未记录' }}</template><span v-if="item.run_status !== 'success'" class="research-warning"> · 本轮评估未完整成功</span></p>
          <p v-if="item.stale_reason" class="research-warning">待复核：{{ item.stale_reason }}</p>
          <div v-if="conditions(item.evidence).length" class="condition-list">
            <span v-for="condition in conditions(item.evidence)" :key="condition.label" class="badge" :class="condition.passed ? 'ok' : 'warn'">{{ condition.label }} · {{ condition.passed ? '满足' : '未满足' }}</span>
          </div>
          <dl v-if="metrics(item.evidence).length" class="research-metrics">
            <div v-for="metric in metrics(item.evidence)" :key="metric.label"><dt>{{ metric.label }}</dt><dd>{{ metric.value }}</dd></div>
          </dl>
          <p v-if="item.trigger_price_lower !== null || item.trigger_price_upper !== null" class="research-note">触发区间：{{ item.trigger_price_lower === null ? '未设下限' : fmtPrice(item.trigger_price_lower) }} ～ {{ item.trigger_price_upper === null ? '未设上限' : fmtPrice(item.trigger_price_upper) }}</p>
          <p v-if="item.invalidation" class="research-warning">失效条件：{{ item.invalidation }}</p>
        </template>
        <p v-else class="research-note">未关联结构化评估，已保存的原因与条件见下方。</p>
      </article>
    </StateBlock>
  </section>
</template>

<style scoped>
.research-section{padding:10px 0;border-bottom:1px solid var(--line)}
h3{margin:0;font-size:var(--fs-md)}
.research-heading{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px}
.research-note{margin:4px 0;color:var(--ink-soft);font-size:var(--fs-sm);line-height:1.5}
.research-heading .research-note{margin:0;font-size:var(--fs-xs)}
.research-entry{padding:8px 0;border-bottom:1px dashed var(--line)}.research-entry:last-child{border-bottom:0;padding-bottom:0}
.research-warning{margin:4px 0;color:var(--warn);line-height:1.5}
.condition-list{display:flex;flex-wrap:wrap;gap:4px 6px;margin:6px 0}
.research-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 16px;margin:8px 0}
.research-metrics>div{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}
.research-metrics dt{color:var(--ink-soft);font-size:var(--fs-sm)}.research-metrics dd{margin:0;font-family:var(--font-mono);overflow-wrap:anywhere}
@media(max-width:440px){.research-metrics{grid-template-columns:1fr}}
</style>
