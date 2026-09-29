// 导航与全局搜索共用页面名称，避免入口缺失或命名不一致。
export const NAV_GROUPS = [
  { label: "日常工作", items: [
    { to: "/", icon: "📊", label: "仪表盘" },
    { to: "/positions", icon: "💼", label: "持仓" },
    { to: "/pools", icon: "🌱", label: "关注池" },
  ] },
  { label: "研究与执行", items: [
    { to: "/jobs", icon: "⏱", label: "任务中心" },
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
