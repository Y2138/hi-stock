<script setup lang="ts">
// Markdown 渲染组件：markdown-it，禁用内嵌 HTML（设计 §1.2 T7：内容来自本库可信源）。
// props 设计保持通用：传入 markdown 源字符串即可，后续策略库/任务结果预览直接复用。
import { computed } from "vue";
import MarkdownIt from "markdown-it";
import { openResult, resultRefFromHref } from "../utils/results";

const props = withDefaults(
  defineProps<{
    /** markdown 源文本 */
    source: string;
    /** 是否自动识别 URL 为链接 */
    linkify?: boolean;
    /** 是否允许换行转 <br>（聊天消息类内容用） */
    breaks?: boolean;
  }>(),
  { linkify: true, breaks: false },
);

const md = computed(
  () =>
    new MarkdownIt({
      html: false, // 禁用内嵌 HTML：防注入的唯一边界
      linkify: props.linkify,
      breaks: props.breaks,
    }),
);

const html = computed(() => md.value.render(props.source));

function onClick(event: MouseEvent): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (!(event.target instanceof Element)) return;
  const target = event.target;
  const anchor = target.closest<HTMLAnchorElement>("a[href]");
  if (!anchor) return;
  const result = resultRefFromHref(anchor.getAttribute("href") ?? "");
  if (!result) return;
  event.preventDefault();
  openResult(result);
}
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html : html:false 下输出不含内嵌 HTML -->
  <div class="markdown-view" v-html="html" @click="onClick"></div>
</template>

<style scoped>
.markdown-view {
  font-size: 13.5px;
  line-height: 1.8;
  color: var(--ink);
}

.markdown-view :deep(h1),
.markdown-view :deep(h2),
.markdown-view :deep(h3) {
  margin: 0.9em 0 0.4em;
}

.markdown-view :deep(table) {
  border-collapse: collapse;
  margin: 0.6em 0;
  font-size: 12.5px;
}

.markdown-view :deep(th),
.markdown-view :deep(td) {
  border: 1px solid var(--line);
  padding: 5px 12px;
}

.markdown-view :deep(th) {
  background: var(--paper-deep);
}

.markdown-view :deep(code) {
  font-family: var(--font-mono);
  background: var(--paper-deep);
  border-radius: 6px;
  padding: 1px 6px;
  font-size: 12px;
}

.markdown-view :deep(pre) {
  background: var(--paper-deep);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  overflow-x: auto;
}

.markdown-view :deep(pre code) {
  background: transparent;
  padding: 0;
}

.markdown-view :deep(blockquote) {
  margin: 0.6em 0;
  padding: 2px 14px;
  border-left: 3px solid var(--accent);
  color: var(--ink-soft);
}

.markdown-view :deep(a[href^="/jobs?output="]),
.markdown-view :deep(a[href*="result="]) {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--accent-soft);
  padding: 4px 10px;
  font-weight: 600;
}
</style>
