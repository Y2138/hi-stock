<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { BarsResponse } from "../api/types";
import { THEME_CHANGED_EVENT } from "../stores/theme";

echarts.use([
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  DataZoomComponent,
  MarkLineComponent,
  CanvasRenderer,
]);

const props = withDefaults(defineProps<{ data: BarsResponse[]; height?: number }>(), { height: 400 });
const el = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;
let resizeObserver: ResizeObserver | null = null;
const hasPoints = computed(() => props.data.some((item) => item.bars.length > 0));

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function render(): void {
  if (!chart) return;
  const dates = [...new Set(props.data.flatMap((item) => item.bars.map((bar) => bar.bar_date)))].sort();
  chart.setOption({
    animationDuration: 280,
    color: [cssVar("--accent-strong"), cssVar("--down"), "#66739a", cssVar("--warn")],
    grid: { left: 62, right: 22, top: 50, bottom: 54 },
    legend: {
      top: 4,
      type: "scroll",
      textStyle: { color: cssVar("--ink-soft"), fontSize: 12 },
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: cssVar("--card"),
      borderColor: cssVar("--line"),
      textStyle: { color: cssVar("--ink"), fontSize: 12 },
      valueFormatter: (value: unknown) => typeof value === "number" ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "—",
    },
    xAxis: {
      type: "category",
      data: dates,
      boundaryGap: false,
      axisLine: { lineStyle: { color: cssVar("--line") } },
      axisLabel: { color: cssVar("--ink-faint"), fontSize: 11 },
    },
    yAxis: {
      type: "value",
      scale: true,
      axisLabel: { color: cssVar("--ink-faint"), formatter: "{value}%" },
      splitLine: { lineStyle: { color: cssVar("--line"), type: "dashed" } },
    },
    dataZoom: [
      { type: "inside" },
      { type: "slider", height: 18, bottom: 9, borderColor: cssVar("--line") },
    ],
    series: props.data.map((item, index) => {
      const baseline = item.bars[0]?.close ?? null;
      const values = new Map(item.bars.map((bar) => [
        bar.bar_date,
        baseline && baseline > 0 ? (bar.close / baseline - 1) * 100 : null,
      ]));
      return {
        name: `${item.instrument.name} ${item.instrument.code}`,
        type: "line" as const,
        showSymbol: false,
        connectNulls: false,
        smooth: 0.12,
        lineStyle: { width: index === 0 ? 2.3 : 1.7 },
        emphasis: { focus: "series" as const },
        data: dates.map((date) => values.get(date) ?? null),
        ...(index === 0 ? {
          markLine: {
            silent: true,
            symbol: "none",
            label: { show: false },
            lineStyle: { color: cssVar("--ink-faint"), opacity: 0.55, type: "dashed" as const },
            data: [{ yAxis: 0 }],
          },
        } : {}),
      };
    }),
  }, { notMerge: true });
}

onMounted(() => {
  if (!el.value) return;
  chart = echarts.init(el.value);
  render();
  resizeObserver = new ResizeObserver(() => chart?.resize());
  resizeObserver.observe(el.value);
  window.addEventListener(THEME_CHANGED_EVENT, render);
});
watch(() => props.data, render, { deep: true });
onBeforeUnmount(() => {
  window.removeEventListener(THEME_CHANGED_EVENT, render);
  resizeObserver?.disconnect();
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div class="chart-wrap">
    <div ref="el" :style="{ height: `${height}px` }"></div>
    <div v-if="!hasPoints" class="chart-empty">所选区间暂无日线数据</div>
  </div>
</template>

<style scoped>
.chart-wrap { position: relative; min-width: 0; }
.chart-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--ink-faint); pointer-events: none; }
</style>
