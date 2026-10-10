// 导航与全局搜索共用页面名称，避免入口缺失或命名不一致。
export const NAV_GROUPS = [
  { label: "全部账户总览", items: [
    { to: "/", icon: "📊", label: "仪表盘" },
  ] },
  { label: "账户工作", items: [
    { to: "/positions", icon: "💼", label: "持仓" },
    { to: "/jobs", icon: "⏱", label: "任务中心" },
  ] },
  { label: "全局研究", items: [
    { to: "/pools", icon: "🌱", label: "关注池" },
    { to: "/market-structure", icon: "▦", label: "市场结构" },
    { to: "/market-news", icon: "📰", label: "市场消息" },
    { to: "/strategies", icon: "📜", label: "当前策略" },
    { to: "/market", icon: "📈", label: "行情" },
  ] },
  { label: "管理", items: [
    { to: "/memories", icon: "🧠", label: "Agent 记忆" },
    { to: "/datasync", icon: "💾", label: "数据与备份" },
    { to: "/settings", icon: "⚙️", label: "设置" },
  ] },
];
