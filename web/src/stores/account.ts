import { computed, ref } from "vue";

export interface PortfolioAccount {
  id: string;
  name: string;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
}

// 这里只保存界面选择偏好，账户和业务事实仍从 PostgreSQL 读取。
export const selectedAccountId = ref(localStorage.getItem("stock-account-id") ?? "1");
export const portfolioAccounts = ref<PortfolioAccount[]>([]);
export const selectedAccount = computed(() => portfolioAccounts.value.find(account => account.id === selectedAccountId.value) ?? null);

// 未发送的文本及会话选择仅在当前页面生命周期内按账户保留。
export const accountWorkspaceState = new Map<string, { sessionId: string | null; draft: string; contextLabel: string | null }>();

export function selectAccount(id: string): void {
  if (id === selectedAccountId.value) return;
  selectedAccountId.value = id;
  localStorage.setItem("stock-account-id", id);
}

// 账户选择仅服务于明确标注的账户页面，研究页面使用全局上下文。
export const taskScope = ref<"account" | "global">("account");
