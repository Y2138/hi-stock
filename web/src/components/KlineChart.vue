<script setup lang="ts">
// 日线 K 线：价格统一用元，成交量统一用手，Tooltip 使用中文业务口径。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts/core";
import { CandlestickChart, BarChart, LineChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { KlineBar } from "../types/market";
import { THEME_CHANGED_EVENT } from "../stores/theme";

echarts.use([
  CandlestickChart,
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

const MA_DEFS = [
  { key: "ma5", name: "MA5" },
  { key: "ma10", name: "MA10" },
  { key: "ma20", name: "MA20" },
  { key: "ma60", name: "MA60" },
] as const;

const props = withDefaults(
  defineProps<{
    bars?: KlineBar[];
    /** 容器高度 */
    height?: number;
    /** 演示数据的种子标题 */
    title?: string;
    /** MA 开关（缺省 MA5/MA20 开） */
    maVisible?: Record<(typeof MA_DEFS)[number]["key"], boolean>;
    macdVisible?: boolean;
  }>(),
  {
    bars: undefined,
    height: 360,
    title: "",
    maVisible: () => ({ ma5: true, ma10: false, ma20: true, ma60: false }),
    macdVisible: false,
  },
);

/** 内置演示数据：确定性伪随机游走，仅用于骨架打样 */
function demoBars(): KlineBar[] {
  const bars: KlineBar[] = [];
  let price = 12.4;
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const start = new Date("2026-05-06T00:00:00");
  for (let i = 0; i < 70; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const drift = (rand() - 0.48) * 0.06;
    const open = price;
    const close = +(open * (1 + drift)).toFixed(2);
    const high = +(Math.max(open, close) * (1 + rand() * 0.02)).toFixed(2);
    const low = +(Math.min(open, close) * (1 - rand() * 0.02)).toFixed(2);
    bars.push({
      date: d.toISOString().slice(0, 10)!,
      open: +open.toFixed(2),
      close,
      low,
      high,
      volume: Math.round(20000 + rand() * 60000),
    });
    price = close;
  }
  return bars;
}

const effectiveBars = computed<KlineBar[]>(() =>
  props.bars === undefined ? demoBars() : props.bars,
);

const hasVolume = computed(() => effectiveBars.value.some((b) => b.volume !== undefined));

const el = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;
let resizeObserver: ResizeObserver | null = null;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const MA_COLORS = ["#c99436", "#7d9bc1", "#b0729a", "#8a8577"];
const chartPrice = (value: number): number => Number(value.toFixed(3));

function formatValue(value: number, unit: string, digits = 2, minimumDigits = 0): string {
  const scaled = Math.abs(value) >= 10_000 ? value / 10_000 : value;
  const suffix = Math.abs(value) >= 10_000 ? ` 万${unit}` : ` ${unit}`;
  return `${scaled.toLocaleString("zh-CN", { minimumFractionDigits: minimumDigits, maximumFractionDigits: digits })}${suffix}`;
}

function formatPrice(value: number): string {
  return formatValue(value, "元", 2, Math.abs(value) < 10_000 ? 2 : 0);
}

function tooltipHtml(bars: KlineBar[], index: number): string {
  const bar = bars[index];
  if (!bar) return "";
  const previous = bars[index - 1];
  const change = previous && previous.close > 0 ? (bar.close / previous.close - 1) * 100 : null;
  const changeText = change === null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
  const rows = [
    ["开盘", formatPrice(bar.open)],
    ["收盘", formatPrice(bar.close)],
    ["最高", formatPrice(bar.high)],
    ["最低", formatPrice(bar.low)],
    ["涨跌幅", changeText],
    ...(bar.volume == null ? [] : [["成交量", formatValue(bar.volume, "手")]]),
    ...MA_DEFS.filter((def) => props.maVisible[def.key] && bar[def.key] != null)
      .map((def) => [def.name, formatPrice(bar[def.key] as number)]),
    ...(props.macdVisible
      ? [
          ["MACD", bar.macdHist == null ? "—" : formatPrice(bar.macdHist)],
          ["DIF", bar.dif == null ? "—" : formatPrice(bar.dif)],
          ["DEA", bar.dea == null ? "—" : formatPrice(bar.dea)],
        ]
      : []),
  ];
  return `<strong>${bar.date}</strong><div style="display:grid;grid-template-columns:auto auto;gap:3px 14px;margin-top:6px">${rows
    .map(([label, value]) => `<span>${label}</span><span style="text-align:right;font-family:monospace">${value}</span>`)
    .join("")}</div>`;
}

function render(): void {
  if (!chart) return;
  const bars = effectiveBars.value;
  const vol = hasVolume.value;
  const macd = props.macdVisible && bars.some((bar) => bar.dif !== null || bar.dea !== null || bar.macdHist !== null);
  const auxiliaryCount = Number(vol) + Number(macd);
  const priceGridBottom = auxiliaryCount === 2 ? "54%" : auxiliaryCount === 1 ? "35%" : 48;
  const dates = bars.map((b) => b.date);
  const volumeAxisIndex = vol ? 1 : -1;
  const macdAxisIndex = macd ? (vol ? 2 : 1) : -1;

  const maSeries = MA_DEFS.filter((def) => props.maVisible[def.key]).map((def, i) => ({
    name: def.name,
    type: "line" as const,
    data: bars.map((b) => {
      const value = b[def.key];
      return value == null ? null : chartPrice(value);
    }),
    smooth: true,
    showSymbol: false,
    connectNulls: false,
    lineStyle: { width: 1.2, color: MA_COLORS[i % MA_COLORS.length] },
    xAxisIndex: 0,
    yAxisIndex: 0,
  }));

  chart.setOption(
    {
      animation: false,
      grid: [
        { left: 88, right: 20, top: 24, bottom: priceGridBottom },
        ...(vol ? [{ left: 88, right: 20, top: auxiliaryCount === 2 ? "52%" : "72%", bottom: auxiliaryCount === 2 ? "29%" : 48 }] : []),
        ...(macd ? [{ left: 88, right: 20, top: auxiliaryCount === 2 ? "75%" : "70%", bottom: 48 }] : []),
      ],
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        backgroundColor: cssVar("--card"),
        borderColor: cssVar("--line"),
        textStyle: { color: cssVar("--ink"), fontSize: 12 },
        formatter: (params: unknown) => {
          const first = Array.isArray(params) ? params[0] as { dataIndex?: number } | undefined : undefined;
          return tooltipHtml(bars, first?.dataIndex ?? -1);
        },
      },
      xAxis: [
        {
          type: "category",
          data: dates,
          gridIndex: 0,
          axisLine: { lineStyle: { color: cssVar("--line") } },
          axisLabel: { color: cssVar("--ink-faint"), fontSize: 11, show: auxiliaryCount === 0 },
        },
        ...(vol
          ? [
              {
                type: "category" as const,
                data: dates,
                gridIndex: 1,
                axisLine: { lineStyle: { color: cssVar("--line") } },
                axisLabel: { color: cssVar("--ink-faint"), fontSize: 11 },
              },
            ]
          : []),
        ...(macd
          ? [{
              type: "category" as const,
              data: dates,
              gridIndex: macdAxisIndex,
              axisLine: { lineStyle: { color: cssVar("--line") } },
              axisLabel: { color: cssVar("--ink-faint"), fontSize: 11 },
            }]
          : []),
      ],
      yAxis: [
        {
          scale: true,
          gridIndex: 0,
          splitLine: { lineStyle: { color: cssVar("--line"), type: "dashed" } },
          axisLabel: { color: cssVar("--ink-faint"), fontSize: 11, formatter: (value: number) => formatValue(value, "元") },
        },
        ...(vol
          ? [
              {
                scale: true,
                gridIndex: 1,
                splitLine: { show: false },
                axisLabel: { color: cssVar("--ink-faint"), fontSize: 10, formatter: (value: number) => formatValue(value, "手") },
              },
            ]
          : []),
        ...(macd
          ? [{
              scale: true,
              gridIndex: macdAxisIndex,
              splitLine: { show: false },
              axisLabel: { color: cssVar("--ink-faint"), fontSize: 10, formatter: (value: number) => formatValue(value, "元") },
            }]
          : []),
      ],
      dataZoom: [
        { type: "inside", xAxisIndex: Array.from({ length: 1 + auxiliaryCount }, (_, index) => index) },
        {
          type: "slider",
          height: 18,
          bottom: 8,
          borderColor: cssVar("--line"),
          xAxisIndex: Array.from({ length: 1 + auxiliaryCount }, (_, index) => index),
        },
      ],
      series: [
        {
          name: props.title || "K线",
          type: "candlestick",
          data: bars.map((b) => [b.open, b.close, b.low, b.high].map(chartPrice)),
          itemStyle: {
            color: cssVar("--up"),
            color0: cssVar("--down"),
            borderColor: cssVar("--up"),
            borderColor0: cssVar("--down"),
          },
          xAxisIndex: 0,
          yAxisIndex: 0,
        },
        ...maSeries,
        ...(vol
          ? [
              {
                name: "成交量",
                type: "bar" as const,
                data: bars.map((b) => ({
                  value: b.volume ?? null,
                  itemStyle: {
                    color: b.close >= b.open ? cssVar("--up") : cssVar("--down"),
                    opacity: 0.6,
                  },
                })),
                xAxisIndex: volumeAxisIndex,
                yAxisIndex: volumeAxisIndex,
              },
            ]
          : []),
        ...(macd
          ? [
              {
                name: "MACD",
                type: "bar" as const,
                data: bars.map((bar) => ({
                  value: bar.macdHist ?? null,
                  itemStyle: { color: (bar.macdHist ?? 0) >= 0 ? cssVar("--up") : cssVar("--down"), opacity: 0.65 },
                })),
                xAxisIndex: macdAxisIndex,
                yAxisIndex: macdAxisIndex,
              },
              {
                name: "DIF",
                type: "line" as const,
                data: bars.map((bar) => bar.dif ?? null),
                showSymbol: false,
                connectNulls: false,
                lineStyle: { width: 1.1, color: "#c99436" },
                xAxisIndex: macdAxisIndex,
                yAxisIndex: macdAxisIndex,
              },
              {
                name: "DEA",
                type: "line" as const,
                data: bars.map((bar) => bar.dea ?? null),
                showSymbol: false,
                connectNulls: false,
                lineStyle: { width: 1.1, color: "#7d9bc1" },
                xAxisIndex: macdAxisIndex,
                yAxisIndex: macdAxisIndex,
              },
            ]
          : []),
      ],
    },
    { notMerge: true },
  );
}

onMounted(() => {
  if (!el.value) return;
  chart = echarts.init(el.value);
  render();
  resizeObserver = new ResizeObserver(() => chart?.resize());
  resizeObserver.observe(el.value);
  window.addEventListener(THEME_CHANGED_EVENT, render);
});

watch([effectiveBars, () => props.maVisible, hasVolume, () => props.macdVisible], render, { deep: true });

onBeforeUnmount(() => {
  window.removeEventListener(THEME_CHANGED_EVENT, render);
  resizeObserver?.disconnect();
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div ref="el" class="kline-chart" :style="{ height: `${height}px` }"></div>
</template>
