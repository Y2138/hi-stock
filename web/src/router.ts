// 工作台路由（产品方案 §五页面信息架构）
// 历史模式由 server 侧 SPA fallback 配合（server/public/app/ 缺失时给构建引导）。
import { createRouter, createWebHistory } from "vue-router";
import DashboardView from "./views/DashboardView.vue";
import FuturesView from "./views/FuturesView.vue";
import StrategiesView from "./views/StrategiesView.vue";
import PoolsView from "./views/PoolsView.vue";
import PositionsView from "./views/PositionsView.vue";
import MarketStructureView from "./views/MarketStructureView.vue";
import JobsView from "./views/JobsView.vue";
import DataSyncView from "./views/DataSyncView.vue";
import NotificationHistoryView from "./views/NotificationHistoryView.vue";
import SettingsView from "./views/SettingsView.vue";
import MemoryView from "./views/MemoryView.vue";
import MarketNewsView from "./views/MarketNewsView.vue";
import UltraShortView from "./views/UltraShortView.vue";
import { openMarket } from "./composables/useMarketDrawer";

export const router = createRouter({
  history: createWebHistory("/"),
  routes: [
    { path: "/futures", name: "futures", component: FuturesView, meta: { title: "期货行情" } },
    { path: "/", name: "dashboard", component: DashboardView, meta: { title: "仪表盘" } },
    { path: "/chat", redirect: { path: "/", query: { chat: "1" } } },
    {
      path: "/strategies",
      name: "strategies",
      component: StrategiesView,
      meta: { title: "当前策略" },
    },
    { path: "/pools", name: "pools", component: PoolsView, meta: { title: "关注池" } },
    { path: "/positions", name: "positions", component: PositionsView, meta: { title: "持仓" } },
    {
      path: "/market",
      redirect: (to) => {
        const code = typeof to.query.code === "string" ? to.query.code : undefined;
        if (code) openMarket(code);
        return { path: "/" };
      },
    },
    { path: "/market-structure", name: "market-structure", component: MarketStructureView, meta: { title: "市场结构" } },
    { path: "/market-news", name: "market-news", component: MarketNewsView, meta: { title: "市场消息" } },
    { path: "/ultra-short", name: "ultra-short", component: UltraShortView, meta: { title: "超短关注池" } },
    { path: "/memories", name: "memories", component: MemoryView, meta: { title: "Agent 记忆" } },
    { path: "/jobs", name: "jobs", component: JobsView, meta: { title: "任务中心" } },
    {
      path: "/datasync",
      name: "datasync",
      component: DataSyncView,
      meta: { title: "数据与备份" },
    },
    { path: "/settings/notifications/history", name: "notification-history", component: NotificationHistoryView, meta: { title: "通知记录" } },
    { path: "/settings", name: "settings", component: SettingsView, meta: { title: "设置" } },
  ],
});

router.afterEach((to) => {
  document.title = `${String(to.meta.title ?? "")} · Stock 策略演进系统`;
});
