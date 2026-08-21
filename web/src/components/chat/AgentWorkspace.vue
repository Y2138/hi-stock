<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import ChatView from "../../views/ChatView.vue";
import type { UiRefreshRequest } from "../../api/types";
import type { AskAiRequest } from "../../utils/askAi";

const props = defineProps<{ open: boolean; request?: AskAiRequest | null }>();
const emit = defineEmits<{
  open: [];
  close: [];
  "request-consumed": [id: string];
  "ui-refresh": [request: UiRefreshRequest];
}>();

const MIN_WIDTH = 480;
const MAX_WIDTH = 960;
const oldStored = Number(localStorage.getItem("stock-chat-drawer-width"));
const stored = Number(localStorage.getItem("stock-agent-workspace-width"));
const initial = Number.isFinite(stored) && stored > 0 ? stored : oldStored;
const width = ref(Number.isFinite(initial) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, initial)) : 680);
const resizing = ref(false);
let startX = 0;
let startWidth = width.value;

const workspaceStyle = computed(() => ({ width: props.open ? `${width.value}px` : "48px" }));

function onPointerMove(event: PointerEvent): void {
  if (!resizing.value) return;
  width.value = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + startX - event.clientX));
}

function stopResize(): void {
  if (!resizing.value) return;
  resizing.value = false;
  document.body.classList.remove("chat-resizing");
  localStorage.setItem("stock-agent-workspace-width", String(width.value));
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", stopResize);
}

function startResize(event: PointerEvent): void {
  if (!props.open) return;
  resizing.value = true;
  startX = event.clientX;
  startWidth = width.value;
  document.body.classList.add("chat-resizing");
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", stopResize);
}

function resizeWithKeyboard(event: KeyboardEvent): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const delta = event.key === "ArrowLeft" ? 24 : -24;
  width.value = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width.value + delta));
  localStorage.setItem("stock-agent-workspace-width", String(width.value));
}

onBeforeUnmount(stopResize);
</script>

<template>
  <aside
    class="agent-workspace"
    :class="{ open }"
    :style="workspaceStyle"
    aria-label="Agent 工作区"
  >
    <div
      v-if="open"
      class="workspace-resize-handle"
      role="separator"
      aria-label="调整业务区与 Agent 工作区宽度"
      aria-orientation="vertical"
      :aria-valuenow="width"
      :aria-valuemin="MIN_WIDTH"
      :aria-valuemax="MAX_WIDTH"
      tabindex="0"
      @pointerdown.prevent="startResize"
      @keydown="resizeWithKeyboard"
    ><span></span></div>

    <button
      v-show="!open"
      class="workspace-rail"
      type="button"
      aria-label="展开 Agent 工作区"
      title="展开 Agent 工作区"
      @click="emit('open')"
    >
      <span class="rail-spark">✦</span>
      <span class="rail-label">Agent</span>
      <span class="rail-arrow">‹</span>
    </button>

    <div v-show="open" class="workspace-expanded">
      <header class="workspace-head">
        <div class="workspace-title">
          <span>✦</span>
          <strong>Agent</strong>
          <small>与当前业务页面并排</small>
        </div>
        <button class="workspace-collapse" type="button" aria-label="收起 Agent 工作区" title="收起 Agent 工作区" @click="emit('close')">›</button>
      </header>
      <div class="workspace-body">
        <ChatView
          embedded
          :request="request"
          @request-close="emit('close')"
          @request-consumed="(id) => emit('request-consumed', id)"
          @ui-refresh="(request) => emit('ui-refresh', request)"
        />
      </div>
    </div>
  </aside>
</template>

<style scoped>
.agent-workspace{grid-area:agent;position:relative;z-index:12;height:100vh;min-width:48px;max-width:min(960px,calc(100vw - 244px));overflow:hidden;border-left:1px solid var(--line);background:var(--paper);transition:width 180ms var(--ease)}.agent-workspace.open{min-width:480px}.workspace-expanded{display:grid;height:100%;grid-template-rows:48px minmax(0,1fr)}.workspace-head{display:flex;align-items:center;justify-content:space-between;padding:0 10px 0 14px;border-bottom:1px solid var(--line);background:var(--card)}.workspace-title{display:flex;align-items:center;gap:7px;min-width:0}.workspace-title>span{color:var(--accent);font-size:17px}.workspace-title strong{font-size:13px}.workspace-title small{overflow:hidden;color:var(--ink-faint);font-size:10.5px;text-overflow:ellipsis;white-space:nowrap}.workspace-collapse{width:30px;height:30px;border:1px solid transparent;border-radius:var(--radius-sm);background:transparent;color:var(--ink-soft);font-size:22px;cursor:pointer}.workspace-collapse:hover{border-color:var(--line);background:var(--paper-deep);color:var(--ink)}.workspace-body{min-height:0;overflow:hidden}.workspace-rail{display:flex;width:48px;height:100%;padding:14px 0;align-items:center;flex-direction:column;gap:12px;border:0;background:var(--card);color:var(--ink-soft);cursor:pointer}.workspace-rail:hover{color:var(--accent-ink);background:var(--accent-soft)}.rail-spark{color:var(--accent);font-size:18px}.rail-label{margin-top:4px;font-size:11px;font-weight:700;letter-spacing:.08em;writing-mode:vertical-rl}.rail-arrow{margin-top:auto;font-size:20px}.workspace-resize-handle{position:absolute;inset:0 auto 0 -6px;width:12px;z-index:3;cursor:col-resize;outline:none}.workspace-resize-handle span{position:absolute;top:50%;left:4px;width:4px;height:50px;border-radius:999px;background:var(--line);transform:translateY(-50%);transition:background var(--dur) var(--ease),width var(--dur) var(--ease)}.workspace-resize-handle:hover span,.workspace-resize-handle:focus span{width:5px;background:var(--accent)}
@media(max-width:1100px){.agent-workspace{width:100%!important;max-width:none;height:48px;min-width:0;border-top:1px solid var(--line);border-left:0}.agent-workspace.open{height:min(48vh,520px);min-width:0}.workspace-expanded{grid-template-rows:40px minmax(0,1fr)}.workspace-head{height:40px}.workspace-rail{width:100%;height:48px;padding:0 16px;flex-direction:row;justify-content:center}.rail-label{margin:0;writing-mode:horizontal-tb}.rail-arrow{margin:0 0 0 auto;transform:rotate(-90deg)}.workspace-resize-handle{display:none}}
</style>
