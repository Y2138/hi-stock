<script setup lang="ts">
// 账户总资产离散快照图（D1b 口径）：历史只有离散记录点，只画散点不连线，缺日保留缺口；
// approx（约数）点位用低透明度+空心区分并附说明，不伪装成精确值。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts/core";
import { ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { AccountSnapshot } from "../api/types";
import { THEME_CHANGED_EVENT } from "../stores/theme";

echarts.use([ScatterChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const props = withDefaults(
  defineProps<{
    snapshots: AccountSnapshot[];
    height?: number;
    /** 迷你模式：隐藏图例与提示说明（仪表盘卡片用） */
    mini?: boolean;
  }>(),
  { height: 300, mini: false },
);

const el = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;
let resizeObserver: ResizeObserver | null = null;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

interface SeriesSpec {
  name: string;
  precision: "exact" | "approx";
  points: [string, number][];
}

const series = computed<SeriesSpec[]>(() => {
  const metricDefs = [
    { name: "总资产", pick: (s: AccountSnapshot) => s.total_asset },
    { name: "证券市值", pick: (s: AccountSnapshot) => s.market_value },
    { name: "现金", pick: (s: AccountSnapshot) => s.cash },
  ];
  const out: SeriesSpec[] = [];
  for (const def of props.mini ? metricDefs.slice(0, 1) : metricDefs) {
    for (const precision of ["exact", "approx"] as const) {
      const points: [string, number][] = [];
      for (const s of props.snapshots) {
        const v = def.pick(s);
        if (v !== null && s.precision === precision) points.push([s.snap_date, v]);
      }
      if (points.length > 0) out.push({ name: def.name, precision, points });
    }
  }
  return out;
});

function render(): void {
  if (!chart) return;
  const faint = cssVar("--ink-faint");
  // 三个系列主题无关的清晰区分：总资产墨色（主口径）、证券市值主题主色、现金绿色
  const seriesColors: Record<string, string> = {
    总资产: cssVar("--ink"),
    证券市值: cssVar("--accent-strong"),
    现金: cssVar("--down"),
  };
  chart.setOption({
    animation: false,
    grid: { left: 76, right: 20, top: props.mini ? 12 : 32, bottom: 28 },
    legend: props.mini
      ? undefined
      : { top: 0, textStyle: { color: cssVar("--ink-soft"), fontSize: 12 } },
    tooltip: {
      trigger: "item",
      backgroundColor: cssVar("--card"),
      borderColor: cssVar("--line"),
      textStyle: { color: cssVar("--ink"), fontSize: 12 },
      formatter: (p: { seriesName: string; value: [string, number]; seriesIndex: number }) => {
        const spec = series.value[p.seriesIndex];
        const approx = spec?.precision === "approx" ? "（约数）" : "";
        return `${p.value[0]}<br/>${p.seriesName}${approx}：${p.value[1].toLocaleString("zh-CN")}`;
      },
    },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: cssVar("--line") } },
      axisLabel: { color: faint, fontSize: 11 },
    },
    yAxis: {
      scale: true,
      splitLine: { lineStyle: { color: cssVar("--line"), type: "dashed" } },
      axisLabel: { color: faint, fontSize: 11 },
    },
    series: series.value.map((s) => ({
      // 同名系列合并为一个图例项（exact/approx 用样式区分）
      name: s.name,
      id: `${s.name}-${s.precision}`,
      type: "scatter",
      data: s.points,
      symbolSize: s.precision === "approx" ? 7 : 9,
      itemStyle:
        s.precision === "approx"
          ? { color: "transparent", borderColor: seriesColors[s.name], borderWidth: 1.5, opacity: 0.75 }
          : { color: seriesColors[s.name] },
    })),
  });
}

onMounted(() => {
  if (!el.value) return;
  chart = echarts.init(el.value);
  render();
  resizeObserver = new ResizeObserver(() => chart?.resize());
  resizeObserver.observe(el.value);
  window.addEventListener(THEME_CHANGED_EVENT, render);
});

watch(series, render);

onBeforeUnmount(() => {
  window.removeEventListener(THEME_CHANGED_EVENT, render);
  resizeObserver?.disconnect();
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div>
    <div ref="el" :style="{ height: `${height}px` }"></div>
    <p v-if="!mini" class="chart-note">
      离散记录点快照，不连线、不补缺口；空心点为约数（~）记录，仅示意量级。
    </p>
  </div>
</template>

<style scoped>
.chart-note {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--ink-faint);
}
</style>
