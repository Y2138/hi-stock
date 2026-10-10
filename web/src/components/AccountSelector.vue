<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { apiClient } from "../api/client";
import { portfolioAccounts as accounts, selectedAccount, selectedAccountId, selectAccount, type PortfolioAccount } from "../stores/account";
import { appMessage } from "../stores/message";

const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const search = ref<HTMLInputElement | null>(null);
const dialog = ref<HTMLDialogElement | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
const open = ref(false);
const loading = ref(true);
const loadError = ref("");
const busy = ref(false);
const query = ref("");
const showArchived = ref(false);
const menuStyle = ref({ left: "0px", top: "0px", width: "320px" });
const action = ref<"create" | "rename" | "archive">("create");
const target = ref<PortfolioAccount | null>(null);
const name = ref("");
const formError = ref("");
const currentName = computed(() => selectedAccount.value?.name ?? (loading.value ? "正在读取…" : "选择账户"));
const archivedCount = computed(() => accounts.value.filter(account => account.status === "archived").length);
const groups = computed(() => [
  { label: "可用账户", status: "active" },
  ...(showArchived.value ? [{ label: "已归档 · 仅查看历史", status: "archived" }] : []),
].map(group => ({ ...group, items: accounts.value.filter(account => account.status === group.status && account.name.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())) })));
const matchingCount = computed(() => groups.value.reduce((sum, group) => sum + group.items.length, 0));
const initial = (account?: PortfolioAccount | null) => account?.name.trim().slice(0, 1) ?? "账";

async function reload() {
  loading.value = true;
  loadError.value = "";
  const response = await apiClient.get<PortfolioAccount[]>("/api/accounts");
  loading.value = false;
  if (!response.ok) { loadError.value = response.message; return; }
  accounts.value = response.data;
  if (!accounts.value.some(account => account.id === selectedAccountId.value)) selectAccount("1");
}
function closeMenu(restoreFocus = false) {
  if (open.value) menu.value?.hidePopover();
  if (restoreFocus) trigger.value?.focus();
}
async function toggleMenu() {
  if (open.value) { closeMenu(true); return; }
  const bounds = trigger.value!.getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - 24);
  menuStyle.value = { left: `${Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12))}px`, top: `${bounds.bottom + 8}px`, width: `${width}px` };
  query.value = "";
  showArchived.value = selectedAccount.value?.status === "archived";
  menu.value?.showPopover();
  await nextTick();
  search.value?.focus();
  const list = menu.value?.querySelector<HTMLElement>(".account-list");
  const selected = menu.value?.querySelector<HTMLElement>('[data-account-option][aria-selected="true"]');
  if (list && selected) list.scrollTop = Math.max(0, selected.offsetTop - list.offsetTop - (list.clientHeight - selected.offsetHeight) / 2);
  if (loadError.value || !accounts.value.length) void reload();
}
function choose(account: PortfolioAccount) {
  const changed = account.id !== selectedAccountId.value;
  selectAccount(account.id);
  closeMenu(true);
  if (changed) appMessage.info(`已切换到「${account.name}」${account.status === "archived" ? "，查看历史记录" : ""}`, { title: "当前账户", duration: 2400 });
}
function navigateOptions(event: KeyboardEvent) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  if (!(event.target instanceof HTMLElement) || (!event.target.matches("[data-account-option]") && event.target !== search.value)) return;
  if (event.target === search.value && ["Home", "End"].includes(event.key)) return;
  const options = [...(menu.value?.querySelectorAll<HTMLButtonElement>("[data-account-option]") ?? [])];
  if (!options.length) return;
  event.preventDefault();
  const index = options.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
    : index < 0 ? (event.key === "ArrowUp" ? options.length - 1 : 0)
      : event.key === "ArrowDown" ? (index + 1) % options.length : (index - 1 + options.length) % options.length;
  options[next]?.focus();
}
async function openAction(next: "create" | "rename" | "archive") {
  closeMenu();
  action.value = next;
  target.value = selectedAccount.value ?? null;
  name.value = next === "rename" ? target.value?.name ?? "" : "";
  formError.value = "";
  dialog.value?.showModal();
  await nextTick();
  if (next !== "archive") { nameInput.value?.focus(); nameInput.value?.select(); }
}
function cancelDialog() {
  if (busy.value) return;
  dialog.value?.close();
  trigger.value?.focus();
}
async function maintain() {
  if (busy.value) return;
  const accountName = name.value.trim();
  if (action.value !== "archive" && !accountName) { formError.value = "请输入账户名称"; nameInput.value?.focus(); return; }
  if (action.value !== "archive" && accounts.value.some(account => account.name === accountName && account.id !== (action.value === "rename" ? target.value?.id : null))) {
    formError.value = "这个名称已被使用，请换一个名称"; nameInput.value?.focus(); return;
  }
  if (action.value === "rename" && accountName === target.value?.name) { cancelDialog(); return; }
  busy.value = true;
  formError.value = "";
  try {
    const result = action.value === "create"
      ? await apiClient.post<PortfolioAccount>("/api/accounts", { name: accountName })
      : action.value === "rename"
        ? await apiClient.patch<PortfolioAccount>(`/api/accounts/${target.value!.id}`, { name: accountName })
        : await apiClient.post<PortfolioAccount>(`/api/accounts/${target.value!.id}/archive`, {});
    if (!result.ok) { formError.value = result.message; return; }
    if (action.value === "create") accounts.value = [...accounts.value, result.data];
    else accounts.value = accounts.value.map(account => account.id === result.data.id ? result.data : account);
    if (action.value === "create") selectAccount(result.data.id);
    if (action.value === "archive") selectAccount(accounts.value.find(account => account.status === "active")?.id ?? "1");
    dialog.value?.close();
    trigger.value?.focus();
    appMessage.success(action.value === "create" ? `已新建并切换到「${result.data.name}」` : action.value === "archive" ? `「${result.data.name}」已归档` : "账户名称已更新");
  } finally { busy.value = false; }
}
function onPopoverToggle(event: Event) { open.value = (event as ToggleEvent).newState === "open"; }
function onViewportChange(event: Event) {
  if (event.target instanceof Node && (menu.value?.contains(event.target) || dialog.value?.contains(event.target))) return;
  closeMenu();
}
onMounted(() => { void reload(); window.addEventListener("resize", onViewportChange); window.addEventListener("scroll", onViewportChange, true); });
onBeforeUnmount(() => { window.removeEventListener("resize", onViewportChange); window.removeEventListener("scroll", onViewportChange, true); });
</script>

<template>
  <div class="account-selector">
    <button ref="trigger" class="account-trigger" type="button" :class="{ expanded: open }" :aria-label="`切换账户，当前${currentName}`" aria-haspopup="dialog" :aria-expanded="open" :title="`当前账户：${currentName}`" @click="toggleMenu" @keydown.down.prevent="!open && toggleMenu()">
      <span class="account-avatar" :class="{ archived: selectedAccount?.status === 'archived' }" aria-hidden="true">{{ initial(selectedAccount) }}</span>
      <span class="account-caption"><span class="account-eyebrow">{{ selectedAccount?.status === 'archived' ? '历史账户 · 只读' : '持仓账户' }}</span><strong>{{ currentName }}</strong></span>
      <svg class="account-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
    </button>
    <div ref="menu" class="account-menu" popover="auto" role="dialog" aria-label="切换持仓账户" :style="menuStyle" @beforetoggle="onPopoverToggle" @keydown="navigateOptions" @keydown.esc.stop="closeMenu(true)">
      <header class="menu-heading"><strong>切换账户</strong><span>持仓与任务独立维护</span></header>
      <div class="account-search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input ref="search" v-model="query" type="search" placeholder="搜索账户名称" aria-label="搜索账户名称" autocomplete="off" /></div>
      <div class="account-list" role="listbox" aria-label="持仓账户" :aria-busy="loading">
        <div v-if="loading && !accounts.length" class="menu-state">正在读取账户…</div>
        <div v-else-if="loadError" class="menu-state"><span>{{ loadError }}</span><button type="button" class="btn compact" @click="reload">重新读取</button></div>
        <template v-else>
          <section v-for="group in groups.filter(group => group.items.length)" :key="group.status" role="group" :aria-label="group.label">
            <div class="account-group-title">{{ group.label }} <span>{{ group.items.length }}</span></div>
            <button v-for="account in group.items" :key="account.id" type="button" role="option" data-account-option :aria-selected="account.id === selectedAccountId" :class="['account-option', { selected: account.id === selectedAccountId }]" @click="choose(account)">
              <span class="account-avatar" :class="{ archived: account.status === 'archived' }" aria-hidden="true">{{ initial(account) }}</span>
              <span class="option-name" :title="account.name"><span class="full-account-name">{{ account.name }}</span><small v-if="account.status === 'archived'">已归档</small></span>
              <svg v-if="account.id === selectedAccountId" class="selected-check" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 12 4 4 10-10" /></svg>
            </button>
          </section>
          <p v-if="!matchingCount" class="menu-state" role="status">没有匹配的账户</p>
        </template>
      </div>
      <button v-if="archivedCount" type="button" class="archive-toggle" :aria-expanded="showArchived" @click="showArchived = !showArchived">{{ showArchived ? '收起已归档账户' : `查看已归档账户 · ${archivedCount}` }}</button>
      <footer class="account-menu-footer">
        <button class="new-account" type="button" :disabled="loading || !!loadError" @click="openAction('create')"><span aria-hidden="true">＋</span> 新建账户</button>
        <div v-if="selectedAccount?.status === 'active'" class="account-management"><button type="button" @click="openAction('rename')">修改名称</button><button v-if="selectedAccountId !== '1'" type="button" @click="openAction('archive')">归档当前账户</button></div>
      </footer>
    </div>
    <dialog ref="dialog" class="account-dialog" aria-labelledby="account-dialog-title" @keydown.esc.stop @cancel="busy ? $event.preventDefault() : undefined" @close="trigger?.focus()">
      <form @submit.prevent="maintain" novalidate>
        <div class="dialog-topline"><span>{{ action === 'create' ? '独立管理一组持仓' : '账户管理' }}</span><button type="button" class="dialog-close" :disabled="busy" aria-label="关闭账户管理" @click="cancelDialog">×</button></div>
        <h2 id="account-dialog-title">{{ action === 'create' ? '新建持仓账户' : action === 'rename' ? '修改账户名称' : '归档账户' }}</h2>
        <p v-if="action === 'archive'" class="dialog-description">归档「{{ target?.name }}」后将停止新的账户任务，持仓与任务历史仍可查看。有持仓或未完成任务时无法归档。</p>
        <template v-else><p class="dialog-description">{{ action === 'create' ? '用容易辨认的名称区分账户，例如「长期持有」或「波段账户」。' : '只更新显示名称，持仓和历史记录会保留。' }}</p><label for="account-name">账户名称</label><input id="account-name" ref="nameInput" v-model="name" maxlength="100" :disabled="busy" :aria-invalid="!!formError" :aria-describedby="formError ? 'account-form-error' : undefined" autocomplete="off" @input="formError = ''" /></template>
        <p v-if="formError" id="account-form-error" class="form-error" role="alert">{{ formError }}</p>
        <div class="dialog-actions"><button class="btn" type="button" :disabled="busy" @click="cancelDialog">取消</button><button class="btn" :class="action === 'archive' ? 'archive-confirm' : 'primary'" type="submit" :disabled="busy">{{ busy ? '保存中…' : action === 'create' ? '创建并切换' : action === 'rename' ? '保存名称' : '确认归档' }}</button></div>
      </form>
    </dialog>
  </div>
</template>

<style scoped>
.account-selector { padding: 4px 0 12px; margin-bottom: 6px; border-bottom: 1px solid var(--line); }
.account-trigger { display: flex; align-items: center; gap: 9px; width: 100%; padding: 10px 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--paper); color: var(--ink); text-align: left; cursor: pointer; transition: border-color var(--dur), background var(--dur); }
.account-trigger:hover, .account-trigger.expanded { border-color: var(--accent); background: var(--accent-soft); }
.account-trigger:focus-visible, .account-option:focus-visible, .account-menu button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.account-avatar { display: inline-grid; place-items: center; flex: 0 0 30px; width: 30px; height: 30px; border: 1px solid color-mix(in srgb, var(--accent) 20%, var(--line)); border-radius: 8px; background: var(--accent-soft); color: var(--accent-ink); font-size: 13px; font-weight: 650; }
.account-avatar.archived { background: var(--paper-deep); color: var(--ink-faint); border-color: var(--line); }
.account-caption { display: grid; min-width: 0; flex: 1; gap: 2px; }
.account-eyebrow { color: var(--ink-faint); font-size: 10px; }
.account-caption strong { overflow: hidden; color: var(--ink); font-size: 12.5px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.account-chevron { flex-shrink: 0; color: var(--ink-faint); }
.account-menu { position: fixed; inset: auto; margin: 0; padding: 12px; max-height: calc(100dvh - 150px); overflow: auto; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--card); color: var(--ink); box-shadow: var(--shadow-lift); }
.menu-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 1px 3px 11px; }
.menu-heading strong { font-size: 13px; } .menu-heading > span { font-size: 10.5px; color: var(--ink-faint); }
.account-search { display: flex; align-items: center; gap: 8px; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--paper); color: var(--ink-faint); }
.account-search:focus-within { border-color: var(--accent); } .account-search input { min-width: 0; width: 100%; height: 36px; padding: 0; border: 0; outline: none; background: none; color: var(--ink); font-size: 12px; }
.account-search input:focus { outline: none; box-shadow: none; }
.account-list { max-height: 260px; overflow-y: auto; margin-top: 7px; padding: 2px; }
.account-group-title { display: flex; align-items: center; justify-content: space-between; padding: 9px 5px 5px; color: var(--ink-faint); font-size: 10.5px; }
.account-option { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 7px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--ink); text-align: left; cursor: pointer; }
.account-option:hover, .account-option.selected { background: var(--accent-soft); } .option-name { display: grid; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; } .full-account-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .option-name small { color: var(--ink-faint); font-size: 10px; } .selected-check { flex-shrink: 0; color: var(--accent-strong); }
.archive-toggle { width: 100%; margin-top: 4px; padding: 7px; border: 0; background: none; color: var(--ink-faint); font-size: 11px; text-align: left; cursor: pointer; }
.account-menu-footer { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
.new-account { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--accent-ink); font-size: 12px; text-align: left; cursor: pointer; } .new-account:hover { background: var(--accent-soft); } .new-account > span { font-size: 18px; line-height: 1; }
.account-management { display: flex; gap: 16px; padding: 8px 9px 2px; } .account-management button { padding: 0; border: 0; background: none; color: var(--ink-soft); font-size: 10.5px; cursor: pointer; } .account-management button:hover { color: var(--ink); }
.menu-state { display: grid; justify-items: center; gap: 8px; margin: 0; padding: 20px 8px; color: var(--ink-soft); font-size: 12px; text-align: center; }
.account-dialog { width: min(420px, calc(100vw - 32px)); padding: 24px; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--card); color: var(--ink); box-shadow: var(--shadow-lift); }
.account-dialog::backdrop { background: var(--overlay); } .dialog-topline { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; color: var(--ink-faint); font-size: 11px; } .dialog-close { width: 26px; height: 26px; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--ink-soft); font-size: 22px; cursor: pointer; } .dialog-close:hover { background: var(--paper-deep); }
h2 { margin: 0; font-size: 19px; } .dialog-description { margin: 12px 0 20px; color: var(--ink-soft); font-size: 12.5px; line-height: 1.7; }
label { display: block; margin-bottom: 7px; color: var(--ink-soft); font-size: 12px; } #account-name { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--paper); color: var(--ink); font: inherit; } #account-name:focus { outline: 2px solid var(--accent-soft); border-color: var(--accent); } #account-name[aria-invalid="true"] { border-color: var(--bad); }
.form-error { margin: 8px 0 0; color: var(--bad); font-size: 12px; } .dialog-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 24px; } .archive-confirm { border-color: var(--bad); color: var(--bad); }
button:disabled { opacity: .45; cursor: default; }
:global(.nav-collapsed .side-nav .account-trigger) { justify-content: center; padding: 7px 0; } :global(.nav-collapsed .side-nav .account-caption), :global(.nav-collapsed .side-nav .account-chevron) { display: none; }
@media (max-width: 720px) { .menu-heading { flex-wrap: wrap; gap:4px; } }
</style>
