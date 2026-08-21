// 工作台路由（产品方案 §五页面信息架构）
// 历史模式由 server 侧 SPA fallback 配合（server/public/app/ 缺失时给构建引导）。
import { createRouter, createWebHistory } from "vue-router";
import DashboardView from "./views/DashboardView.vue";
import StrategiesView from "./views/StrategiesView.vue";
import PoolsView from "./views/PoolsView.vue";
import PositionsView from "./views/PositionsView.vue";
import MarketView from "./views/MarketView.vue";
import MarketStructureView from "./views/MarketStructureView.vue";
import BacktestsView from "./views/BacktestsView.vue";
import JobsView from "./views/JobsView.vue";
import DataSyncView from "./views/DataSyncView.vue";
import SettingsView from "./views/SettingsView.vue";
import MemoryView from "./views/MemoryView.vue";

export const router = createRouter({
  history: createWebHistory("/"),
  routes: [
    { path: "/", name: "dashboard", component: DashboardView, meta: { title: "仪表盘" } },
    { path: "/chat", redirect: { path: "/", query: { chat: "1" } } },
    {
      path: "/strategies",
      name: "strategies",
      component: StrategiesView,
      meta: { title: "当前策略" },
    },
    { path: "/short-pool", name: "short-pool", component: PoolsView, props: { pool: "short" }, meta: { title: "短线池" } },
    { path: "/long-pool", name: "long-pool", component: PoolsView, props: { pool: "long" }, meta: { title: "长线池" } },
    { path: "/pools", redirect: "/short-pool" },
    { path: "/positions", name: "positions", component: PositionsView, meta: { title: "持仓" } },
    { path: "/market", name: "market", component: MarketView, meta: { title: "行情" } },
    { path: "/market-structure", name: "market-structure", component: MarketStructureView, meta: { title: "市场结构" } },
    {
      path: "/backtests",
      name: "backtests",
      component: BacktestsView,
      meta: { title: "回测历史" },
    },
    { path: "/memories", name: "memories", component: MemoryView, meta: { title: "Agent 记忆" } },
    { path: "/jobs", name: "jobs", component: JobsView, meta: { title: "任务中心" } },
    {
      path: "/datasync",
      name: "datasync",
      component: DataSyncView,
      meta: { title: "数据与备份" },
    },
    { path: "/settings", name: "settings", component: SettingsView, meta: { title: "设置" } },
  ],
});

router.afterEach((to) => {
  document.title = `${String(to.meta.title ?? "")} · Stock 策略演进系统`;
});
