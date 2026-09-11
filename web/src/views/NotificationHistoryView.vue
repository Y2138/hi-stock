<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { apiClient } from "../api/client";
import type { NotificationPage, NotificationDelivery, NotificationSettings } from "../api/types";
import { appMessage } from "../stores/message";
const listContainer = ref<HTMLElement | null>(null);
const page = ref<NotificationPage>({ items: [], next_cursor: null });
const cursors = ref<Array<string | null>>([null]);
const status = ref("");
const job = ref("");
const jobs = ref<NotificationSettings["jobs"]>([]);
const loading = ref(false);
const error = ref("");
const selected = ref<NotificationDelivery | null>(null);
const labels = { pending: "等待发送", sending: "发送中", sent: "飞书已接收", failed: "发送失败", cancelled: "已取消" };
let disposed = false;
let request = 0;
let detailRequest = 0;
let timer: ReturnType<typeof setInterval> | undefined;
async function load() {
  const ticket = ++request;
  loading.value = true; error.value = "";
  const query = new URLSearchParams();
  if (status.value) query.set("status", status.value);
  if (job.value) query.set("job_code", job.value);
  const before = cursors.value.at(-1);
  if (before) query.set("before", before);
  const response = await apiClient.get<NotificationPage>(`/api/notifications?${query}`);
  if (ticket !== request) return;
  loading.value = false;
  if (response.ok) page.value = response.data; else error.value = response.message;
}
function reset() { listContainer.value?.scrollTo(0, 0); cursors.value = [null]; selected.value = null; detailRequest++; void load(); }
function next() { if (page.value.next_cursor) { listContainer.value?.scrollTo(0, 0); cursors.value.push(page.value.next_cursor); selected.value = null; detailRequest++; void load(); } }
function previous() { listContainer.value?.scrollTo(0, 0); cursors.value.pop(); selected.value = null; detailRequest++; void load(); }
async function detail(id: string) {
  if (selected.value?.id === id) { selected.value = null; detailRequest++; return; }
  const ticket = ++detailRequest;
  selected.value = null;
  const response = await apiClient.get<NotificationDelivery>(`/api/notifications/${id}`);
  if (ticket !== detailRequest) return;
  if (response.ok) selected.value = response.data; else error.value = response.message;
}
async function retry(id: string) {
  loading.value = true;
  const response = await apiClient.post(`/api/notifications/${id}/retry`, {});
  loading.value = false;
  if (!response.ok) { error.value = response.message; return; }
  selected.value = null; detailRequest++;
  appMessage.success("原结论已重新排队，任务不会重新运行");
  await load();
}
function time(value: string) { return new Date(value).toLocaleString("zh-CN", { hour12: false }); }
onMounted(async () => {
  void load();
  const response = await apiClient.get<NotificationSettings>("/api/notifications/settings");
  if (disposed) return;
  if (response.ok) jobs.value = response.data.jobs;
  timer = setInterval(() => {
    if (!document.hidden && !loading.value && cursors.value.length === 1 && page.value.items.some((i) => i.status === 'pending' || i.status === 'sending')) void load();
  }, 5_000);
});
onUnmounted(() => { disposed = true; request++; detailRequest++; if (timer) clearInterval(timer); });
</script>
<template>
  <section>
    <div class="page-head"><h1>通知记录</h1><RouterLink to="/settings?section=notifications">← 消息推送设置</RouterLink></div>
    <p class="sub">每页 20 条，按需查看正文。“飞书已接收”不代表用户已读。</p>
    <div class="filters">
      <label>任务 <select v-model="job" :disabled="loading" @change="reset"><option value="">全部任务及测试</option><option v-for="item in jobs" :key="item.code" :value="item.code">{{ item.name }}</option></select></label>
      <label>状态 <select v-model="status" :disabled="loading" @change="reset"><option value="">全部状态</option><option v-for="(label, key) in labels" :key="key" :value="key">{{ label }}</option></select></label>
      <button class="btn" :disabled="loading" @click="load">刷新</button>
    </div>
    <p v-if="error" class="bad-text" role="alert">{{ error }}</p>
    <div ref="listContainer" class="card history-list" tabindex="0" aria-label="通知列表" :aria-busy="loading">
      <p v-if="!page.items.length" class="empty">{{ loading ? '正在读取通知…' : '没有符合条件的通知' }}</p>
      <article v-for="item in page.items" :key="item.id" class="history-row">
        <div class="row-main">
          <div><strong>{{ item.kind === 'test' ? '连接测试' : item.job_name || '任务结果' }}</strong><span v-if="item.output_id" class="meta">结果 #{{ item.output_id }}</span><p class="meta">{{ time(item.created_at) }} · 本轮尝试 {{ item.attempts }} 次</p></div>
          <span class="badge" :class="{ ok: item.status === 'sent', bad: item.status === 'failed' }">{{ labels[item.status] }}</span>
        </div>
        <p v-if="item.error" class="hint">{{ item.error }}</p>
        <div class="row-actions">
          <button class="btn" :aria-expanded="selected?.id === item.id" @click="detail(item.id)">{{ selected?.id === item.id ? '收起正文' : '查看正文' }}</button>
          <button v-if="item.status === 'failed'" class="btn" :disabled="loading" @click="retry(item.id)">补发原结论</button>
        </div>
        <pre v-if="selected?.id === item.id">{{ selected.content }}</pre>
      </article>
    </div>
    <nav class="pagination" aria-label="通知分页"><button class="btn" :disabled="loading || cursors.length === 1" @click="previous">上一页</button><span>第 {{ cursors.length }} 页</span><button class="btn" :disabled="loading || !page.next_cursor" @click="next">下一页</button></nav>
    <p class="hint">临时故障最多尝试 3 次。超过 24 小时、渠道已变更或同一任务同一日期已有更新结果的通知停止发送。历史记录保留供查阅。</p>
  </section>
</template>
<style scoped>
.filters, .filters label, .row-actions, .pagination { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.filters { margin: 20px 0; }
select { max-width: 100%; padding: 8px; background: var(--card); color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius-sm); }
.history-list { padding: 0 18px; max-height: min(60vh, 680px); overflow-y: auto; overscroll-behavior: contain; }
.history-row { padding: 16px 0; }
.history-row + .history-row { border-top: 1px solid var(--line); }
.row-main { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.row-main .badge { flex: none; }
.meta, .hint { color: var(--ink-soft); font-size: 12px; line-height: 1.7; }
span.meta { margin-left: 8px; }
p.meta { margin: 5px 0 10px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--paper-deep); padding: 14px; font: inherit; font-size: 13px; line-height: 1.7; }
.pagination { justify-content: center; margin: 20px 0; }
.empty { padding: 28px 0; text-align: center; color: var(--ink-soft); }
</style>
