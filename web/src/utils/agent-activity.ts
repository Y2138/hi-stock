import { TOOL_LABELS, type AgentActivity } from "../api/types";

const ACTIONS: Record<string, string> = {
  daily_plan_write: "每日计划预案与打板机会",
  pool_attention_write: "标的池近期关注",
  auction_assessment_write: "打板机会竞价复核",
  daily_plan_context_query: "每日计划市场与持仓分析",
  swing_signal_query: "波段信号扫描",
  limit_up_signal_query: "打板机会筛选",
};

export function activityLabel(activity: AgentActivity | null, isJob: boolean): string {
  if (!activity) return "正在等待 Agent 的进度反馈";
  const action = ACTIONS[activity.tool_name ?? ""] ?? TOOL_LABELS[activity.tool_name ?? ""] ?? "工具操作";
  switch (activity.phase) {
    case "thinking": return "正在分析已有信息，准备下一步";
    case "writing": return isJob ? "正在生成任务文档" : "正在组织答复";
    case "preparing_tool": return `正在准备${action}内容`;
    case "executing_tool": return activity.tool_name === "pool_attention_write" ? "正在同步结果到标的池近期关注"
      : activity.tool_name === "daily_plan_write" ? "正在写入每日计划预案与打板机会草稿"
      : activity.tool_name === "auction_assessment_write" ? "正在写入打板机会竞价复核草稿"
      : `正在执行${action}`;
    case "tool_finished": return `${action}已返回，等待 Agent 继续`;
    case "tool_failed": return `${action}执行失败，等待 Agent 处理`;
    case "saving": return activity.job_code === "daily_plan_flow"
      ? "正在保存每日计划并更新打板机会"
      : activity.job_code === "auction_opportunity_assessment"
        ? "正在保存并发布打板机会复核结果" : "正在保存任务结果";
  }
}
