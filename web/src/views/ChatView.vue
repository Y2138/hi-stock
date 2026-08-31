<script setup lang="ts">
// 对话（/chat）：会话列表（新建/切换）、SSE 逐 token 消息流、工具卡片与写操作确认卡、
// 图片附件（vision 门控）、LLM 未配置降级引导。设计 §6.3/§6.4；产品方案 §6.3。
// 事件通道：统一 Agent session 游标流接收 confirmation_result 与 ui_refresh；切会话/离开页面时关闭。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { apiClient, postSseStream, uploadFile } from "../api/client";
import type {
  AgentControlResult,
  ChatAttachment,
  ChatMessageRow,
  ChatSession,
  ChatSseFrame,
  Confirmation,
  ConfirmationResultEvent,
  LlmConfigCatalog,
  LlmModelConfig,
  LlmProviderConfig,
  LlmStatus,
  UiRefreshRequest,
} from "../api/types";
import MarkdownView from "../components/MarkdownView.vue";
import StateBlock from "../components/StateBlock.vue";
import ToolGroupCard from "../components/chat/ToolGroupCard.vue";
import UiSelect, { type SelectOption } from "../components/ui/UiSelect.vue";
import { useResource } from "../composables/useResource";
import { useStreamTypewriter } from "../composables/useStreamTypewriter";
import { appMessage } from "../stores/message";
import { fmtTime } from "../utils/format";
import {
  groupMessagesIntoTurns,
  groupToolCalls,
  resultTextOf,
  rowsToMessages,
  type UiAgentTurn,
  type UiMessage,
  type UiToolCall,
} from "../utils/chat";
import type { AskAiRequest } from "../utils/askAi";

const props = withDefaults(
  defineProps<{ embedded?: boolean; request?: AskAiRequest | null }>(),
  { embedded: false, request: null },
);
const emit = defineEmits<{
  "request-close": [];
  "request-consumed": [id: string];
  "ui-refresh": [request: UiRefreshRequest];
}>();

const llm = useResource<LlmStatus>(() => apiClient.get<LlmStatus>("/api/llm/status"));
const llmCatalog = useResource<LlmConfigCatalog>(() =>
  apiClient.get<LlmConfigCatalog>("/api/llm/providers"),
);

// ---- 会话列表 ----
const sessions = ref<ChatSession[]>([]);
const sessionsError = ref<string | null>(null);
const activeId = ref<string | null>(null);
const activeSession = computed(() => sessions.value.find((s) => s.id === activeId.value) ?? null);

const SESSION_TYPE_LABELS: Record<ChatSession["session_type"], string> = {
  interactive: "对话",
  job: "任务",
  backtest: "回测",
  strategy_evolution: "策略演进",
};
const SESSION_STATUS_LABELS: Record<ChatSession["session_status"], string> = {
  idle: "可继续",
  queued: "排队中",
  running: "运行中",
  waiting_confirmation: "待确认",
  success: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已中断",
};

interface ChatModelChoice {
  id: string;
  provider: LlmProviderConfig;
  model: LlmModelConfig;
  ready: boolean;
  label: string;
}

const chatModelChoices = computed<ChatModelChoice[]>(() =>
  (llmCatalog.data.value?.providers ?? []).flatMap((provider) =>
    provider.models.map((model) => {
      const ready = provider.enabled && provider.api_key_configured && model.enabled;
      const capability = model.input_modalities.includes("image") ? "图文" : "文本";
      return {
        id: model.id,
        provider,
        model,
        ready,
        label: `${provider.name} · ${model.name} · ${capability}${ready ? "" : " · 不可用"}`,
      };
    }),
  ),
);

const effectiveModelId = computed(
  () => activeSession.value?.model_id ?? llmCatalog.data.value?.active_model_id ?? null,
);
const selectedChatModel = computed(
  () => chatModelChoices.value.find((choice) => choice.id === effectiveModelId.value) ?? null,
);
const chatModelOptions = computed<SelectOption[]>(() =>
  chatModelChoices.value.map((choice) => ({
    value: choice.id,
    label: choice.label,
    disabled: !choice.ready,
  })),
);
const modelAvailabilityMessage = computed(() => {
  const choice = selectedChatModel.value;
  if (!choice) return "本会话尚未选择可用模型";
  if (!choice.provider.enabled) return `模型厂商 ${choice.provider.name} 已停用`;
  if (!choice.model.enabled) return `模型 ${choice.model.name} 已停用`;
  if (!choice.provider.api_key_configured) return `模型厂商 ${choice.provider.name} 尚未配置 API Key`;
  return null;
});
/** 归档列表查看模式（?archived=1） */
const showArchived = ref(false);

async function loadSessions(): Promise<void> {
  const r = await apiClient.get<ChatSession[]>(
    `/api/chat/sessions${showArchived.value ? "?archived=1" : ""}`,
  );
  if (r.ok) {
    sessions.value = r.data;
    sessionsError.value = null;
  } else {
    sessionsError.value = `${r.code}：${r.message}`;
  }
}

async function toggleArchivedView(): Promise<void> {
  detachLocalStream("已切换会话，当前运行继续在后台执行");
  showArchived.value = !showArchived.value;
  activeId.value = null;
  messages.value = [];
  closeEvents();
  await loadSessions();
}

async function createNewSession(): Promise<void> {
  const r = await apiClient.post<ChatSession>("/api/chat/sessions", {});
  if (r.ok) {
    if (showArchived.value) {
      showArchived.value = false;
      await loadSessions();
    } else {
      sessions.value = [r.data, ...sessions.value];
    }
    await selectSession(r.data.id);
  } else {
    sessionsError.value = `${r.code}：${r.message}`;
  }
}

// ---- 重命名 / 归档 ----
const renamingId = ref<string | null>(null);
const renameDraft = ref("");

/** 内联重命名输入框自动聚焦（v-focus 局部指令） */
const vFocus = { mounted: (el: HTMLElement) => el.focus() };

function startRename(s: ChatSession): void {
  renamingId.value = s.id;
  renameDraft.value = s.title;
}

async function commitRename(): Promise<void> {
  const id = renamingId.value;
  const title = renameDraft.value.trim();
  renamingId.value = null;
  if (!id || !title) return;
  const r = await apiClient.patch<ChatSession>(`/api/chat/sessions/${id}`, { title });
  if (r.ok) {
    const s = sessions.value.find((x) => x.id === id);
    if (s) s.title = r.data.title;
    appMessage.success("会话名称已更新");
  } else {
    sessionsError.value = `${r.code}：${r.message}`;
  }
}

async function setArchived(s: ChatSession, archived: boolean): Promise<void> {
  const r = await apiClient.patch<ChatSession>(`/api/chat/sessions/${s.id}`, { archived });
  if (!r.ok) {
    sessionsError.value = `${r.code}：${r.message}`;
    return;
  }
  if (activeId.value === s.id) {
    detachLocalStream("已归档会话，当前运行继续在后台执行");
    activeId.value = null;
    messages.value = [];
    closeEvents();
  }
  appMessage.success(archived ? "会话已归档" : "会话已恢复");
  await loadSessions();
}

const switchingModel = ref(false);
const modelSwitchError = ref<string | null>(null);

async function switchSessionModel(value: string | number | null): Promise<void> {
  const session = activeSession.value;
  const modelId = value === null ? null : String(value);
  if (!session || !modelId || isAgentRunning.value || switchingModel.value || session.archived) return;
  if (modelId === session.model_id) return;
  const choice = chatModelChoices.value.find((item) => item.id === modelId);
  if (!choice?.ready) {
    modelSwitchError.value = "该模型当前不可用，请先在设置页启用模型并配置厂商密钥";
    appMessage.warning(modelSwitchError.value, { title: "无法切换模型" });
    return;
  }
  if (!choice.model.input_modalities.includes("image") && pendingImages.value.length > 0) {
    modelSwitchError.value = "当前已有待发送图片，请先移除图片再切换到纯文本模型";
    appMessage.warning(modelSwitchError.value, { title: "无法切换模型" });
    return;
  }

  switchingModel.value = true;
  modelSwitchError.value = null;
  const response = await apiClient.patch<ChatSession>(`/api/chat/sessions/${session.id}`, {
    model_id: modelId,
  });
  switchingModel.value = false;
  if (!response.ok) {
    modelSwitchError.value = `${response.code}：${response.message}`;
    return;
  }
  Object.assign(session, response.data);
  appMessage.success(`本会话已切换到 ${choice.model.name}`, { title: "模型已切换" });
}

// ---- 消息区 ----
const messages = ref<UiMessage[]>([]);
const conversationTurns = computed(() =>
  groupMessagesIntoTurns(
    messages.value,
    activeSession.value?.session_status === "running" ? `pending-${activeSession.value.id}` : undefined,
    activeSession.value?.updated_at,
  ),
);
const loadingMessages = ref(false);
const messagesError = ref<string | null>(null);
const msgPane = ref<HTMLElement | null>(null);
const followingLatest = ref(true);
const showLatestButton = ref(false);
let scrollAnimationId: number | null = null;

function scrollBottom(force = false): void {
  if (force) {
    followingLatest.value = true;
    showLatestButton.value = false;
  }
  if (!followingLatest.value) return;
  void nextTick(() => {
    if (!followingLatest.value || scrollAnimationId !== null) return;
    scrollAnimationId = window.requestAnimationFrame(() => {
      scrollAnimationId = null;
      const el = msgPane.value;
      if (el && followingLatest.value) el.scrollTop = el.scrollHeight;
    });
  });
}

function onMessageScroll(): void {
  const el = msgPane.value;
  if (!el) return;
  const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  followingLatest.value = distanceToBottom <= 48;
  showLatestButton.value = !followingLatest.value;
}

function resumeFollowing(): void {
  scrollBottom(true);
}

function allTools(): UiToolCall[] {
  return messages.value.flatMap((m) => m.tools);
}

function agentTurnTime(turn: UiAgentTurn): string | null {
  return fmtTime(turn.messages[turn.messages.length - 1]?.createdAt);
}

/** 最后一段不含工具的可见文本是回答；其余可见文本属于 Agent 的思考与执行进展。 */
function isAgentAnswer(turn: UiAgentTurn, index: number): boolean {
  const message = turn.messages[index];
  if (!message?.text || message.tools.length > 0) return false;
  return !turn.messages.slice(index + 1).some((later) => later.text.trim().length > 0);
}

/** 以 confirmation 表为准对账确认卡状态（历史恢复 / 409 冲突后调用） */
async function reconcileConfirmations(): Promise<void> {
  if (!activeId.value) return;
  const r = await apiClient.get<Confirmation[]>(
    `/api/confirmations?session_id=${activeId.value}&limit=200`,
  );
  if (!r.ok) return;
  const byId = new Map(r.data.map((c) => [c.id, c]));
  for (const tool of allTools()) {
    if (!tool.confirmation) continue;
    const row = byId.get(tool.confirmation.id);
    if (row) {
      tool.confirmation.status = row.status;
      tool.confirmation.result = row.result;
      if (tool.confirmation.payload === null) tool.confirmation.payload = row.payload;
    }
  }
}

async function selectSession(id: string): Promise<void> {
  if (activeId.value === id) return;
  detachLocalStream("已切换会话，当前运行继续在后台执行");
  activeId.value = id;
  activeRunId.value = activeRunIds.get(id) ?? null;
  modelSwitchError.value = null;
  followingLatest.value = true;
  showLatestButton.value = false;
  messages.value = [];
  messagesError.value = null;
  const selected = sessions.value.find((session) => session.id === id);
  if (selected && ["queued", "running", "waiting_confirmation"].includes(selected.session_status)) {
    openEvents(id);
  }
  await loadConversation(id, true);
}

let conversationLoadVersion = 0;

async function loadConversation(id: string, showLoading: boolean): Promise<void> {
  const version = ++conversationLoadVersion;
  if (showLoading) loadingMessages.value = true;
  const [msgRes, confRes] = await Promise.all([
    apiClient.get<ChatMessageRow[]>(`/api/chat/sessions/${id}/messages`),
    apiClient.get<Confirmation[]>(`/api/confirmations?session_id=${id}&limit=200`),
  ]);
  if (activeId.value !== id || version !== conversationLoadVersion) return;
  loadingMessages.value = false;
  if (msgRes.ok) {
    messages.value = rowsToMessages(msgRes.data, confRes.ok ? confRes.data : []);
    scrollBottom(true);
  } else {
    messagesError.value = `${msgRes.code}：${msgRes.message}`;
  }
}

/** 加载失败后的原位重试（selectSession 对同 id 短路，这里强制重来） */
async function reloadActive(): Promise<void> {
  const id = activeId.value;
  if (!id) return;
  await loadConversation(id, true);
}

function refreshActive(): void {
  const id = activeId.value;
  if (id) void loadConversation(id, false);
}

// ---- Agent session 事件长连（确认结果 + 白名单页面刷新） ----
let evtSource: EventSource | null = null;
let eventsSessionId: string | null = null;
const activeRunIds = new Map<string, string>();
const eventCursors = new Map<string, bigint>();
const primedSessions = new Set<string>();
let replayingEvents = true;
let connectionStartedAt = 0;
let pendingRefreshes: UiRefreshRequest[] = [];
let pendingConversationRefresh = false;

function readEventData<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent).data) as T;
  } catch {
    return null;
  }
}

function acceptCursor(sessionId: string, data: { cursor?: unknown }): boolean {
  if (typeof data.cursor !== "string" || !/^\d+$/.test(data.cursor)) return true;
  const cursor = BigInt(data.cursor);
  const previous = eventCursors.get(sessionId) ?? 0n;
  if (cursor <= previous) return false;
  eventCursors.set(sessionId, cursor);
  return true;
}

function deliverRefresh(request: UiRefreshRequest): void {
  emit("ui-refresh", request);
}

function openEvents(sessionId: string): void {
  if (evtSource && eventsSessionId === sessionId) return;
  closeEvents();
  eventsSessionId = sessionId;
  replayingEvents = true;
  connectionStartedAt = Date.now();
  pendingRefreshes = [];
  pendingConversationRefresh = false;
  const after = eventCursors.get(sessionId) ?? 0n;
  evtSource = new EventSource(`/api/chat/${sessionId}/events?after=${after.toString()}`);
  evtSource.addEventListener("ready", () => {
    replayingEvents = true;
    connectionStartedAt = Date.now();
    pendingRefreshes = [];
    pendingConversationRefresh = false;
  });
  evtSource.addEventListener("confirmation_result", (ev) => {
    const data = readEventData<ConfirmationResultEvent & { cursor?: string }>(ev);
    if (!data || !acceptCursor(sessionId, data)) return;
    applyConfirmationResult(data);
  });
  evtSource.addEventListener("run_started", (ev) => {
    const data = readEventData<{ run_id?: string; cursor?: string }>(ev);
    if (!data || typeof data.run_id !== "string" || !acceptCursor(sessionId, data)) return;
    activeRunIds.set(sessionId, data.run_id);
    if (activeId.value === sessionId) activeRunId.value = data.run_id;
  });
  evtSource.addEventListener("session_status", (ev) => {
    const data = readEventData<{ status?: ChatSession["session_status"]; cursor?: string }>(ev);
    if (!data?.status || !acceptCursor(sessionId, data)) return;
    const session = sessions.value.find((item) => item.id === sessionId);
    if (session) session.session_status = data.status;
    if (["idle", "success", "partial", "failed", "cancelled"].includes(data.status)) {
      activeRunIds.delete(sessionId);
      if (activeId.value === sessionId && !sending.value) activeRunId.value = null;
      queueConversationRefresh(sessionId);
    }
  });
  const onBackgroundCompleted = (ev: Event) => {
    const data = readEventData<{ cursor?: string }>(ev);
    if (!data || !acceptCursor(sessionId, data)) return;
    queueConversationRefresh(sessionId);
  };
  evtSource.addEventListener("message_completed", onBackgroundCompleted);
  evtSource.addEventListener("session_completed", onBackgroundCompleted);
  evtSource.addEventListener("session_aborted", onBackgroundCompleted);
  evtSource.addEventListener("ui_refresh", (ev) => {
    const data = readEventData<UiRefreshRequest & { cursor?: string }>(ev);
    if (!data || !Array.isArray(data.targets) || !acceptCursor(sessionId, data)) return;
    const request: UiRefreshRequest = {
      targets: data.targets,
      reason: data.reason,
      requested_at: data.requested_at,
      cursor: data.cursor,
    };
    if (replayingEvents) pendingRefreshes.push(request);
    else deliverRefresh(request);
  });
  evtSource.addEventListener("replay_complete", (ev) => {
    const data = readEventData<{ cursor?: string }>(ev);
    if (data?.cursor && /^\d+$/.test(data.cursor)) {
      const cursor = BigInt(data.cursor);
      const previous = eventCursors.get(sessionId) ?? 0n;
      if (cursor > previous) eventCursors.set(sessionId, cursor);
    }
    const alreadyPrimed = primedSessions.has(sessionId);
    for (const request of pendingRefreshes) {
      const requestedAt = Date.parse(request.requested_at);
      if (alreadyPrimed || (Number.isFinite(requestedAt) && requestedAt >= connectionStartedAt - 1_000)) {
        deliverRefresh(request);
      }
    }
    pendingRefreshes = [];
    primedSessions.add(sessionId);
    replayingEvents = false;
    if (pendingConversationRefresh) {
      pendingConversationRefresh = false;
      queueConversationRefresh(sessionId);
    }
  });
  // 断线由 EventSource 自动重连
}

function closeEvents(): void {
  evtSource?.close();
  evtSource = null;
  eventsSessionId = null;
  pendingRefreshes = [];
  pendingConversationRefresh = false;
}

function queueConversationRefresh(sessionId: string): void {
  if (activeId.value !== sessionId || sending.value) return;
  if (replayingEvents) {
    pendingConversationRefresh = true;
    return;
  }
  refreshActive();
}

function applyConfirmationResult(data: ConfirmationResultEvent): void {
  for (const tool of allTools()) {
    if (tool.confirmation?.id === data.confirmation_id) {
      tool.confirmation.status = data.status;
      tool.confirmation.result = data.result ?? null;
      tool.confirmation.acting = false;
    }
  }
}

// ---- 发送与 SSE 帧处理 ----
const draft = ref("");
const draftContextLabel = ref<string | null>(null);
const composerInput = ref<HTMLTextAreaElement | null>(null);
const workspaceReady = ref(false);
let handlingRequestId: string | null = null;
const sending = ref(false);
const controlling = ref(false);
const stopping = ref(false);
const activeRunId = ref<string | null>(null);
let abortCtrl: AbortController | null = null;
let abortedByUser = false;
let typingTarget: UiMessage | null = null;

const streamTypewriter = useStreamTypewriter({
  interval: 28,
  maxStep: 12,
  onUpdate: (text) => {
    if (!typingTarget) return;
    typingTarget.text = text;
    scrollBottom();
  },
});

interface TurnStreamState {
  sessionId: string;
  terminal: "done" | "aborted" | "error" | null;
  currentAssistant: UiMessage;
  assistantStarts: number;
  runId: string | null;
}

const configured = computed(() => selectedChatModel.value?.ready === true);
const supportsVision = computed(
  () => selectedChatModel.value?.model.input_modalities.includes("image") === true,
);
const isArchivedSession = computed(() => activeSession.value?.archived === true);
const isAgentRunning = computed(
  () =>
    sending.value ||
    activeSession.value?.session_status === "running",
);
const canSend = computed(
  () =>
    configured.value &&
    activeId.value !== null &&
    !isArchivedSession.value &&
    !isAgentRunning.value &&
    draft.value.trim().length > 0,
);
const canControl = computed(
  () =>
    configured.value &&
    isAgentRunning.value &&
    activeRunId.value !== null &&
    draft.value.trim().length > 0 &&
    !controlling.value &&
    !stopping.value,
);

async function consumeWorkspaceRequest(request: AskAiRequest): Promise<void> {
  if (!workspaceReady.value || handlingRequestId !== null) return;
  handlingRequestId = request.id;
  try {
    if (showArchived.value) {
      showArchived.value = false;
      await loadSessions();
    }
    if (request.kind === "open_session") {
      if (!request.sessionId) return;
      if (!sessions.value.some((session) => session.id === request.sessionId)) await loadSessions();
      if (!sessions.value.some((session) => session.id === request.sessionId)) {
        sessionsError.value = `会话不存在或已归档：${request.sessionId}`;
        return;
      }
      await selectSession(request.sessionId);
    } else {
      if (!request.prompt) return;
      const created = await apiClient.post<ChatSession>("/api/chat/sessions", {
        title: request.title ?? request.contextLabel ?? "新会话",
        session_type: request.sessionType ?? "interactive",
        parent_session_id: request.parentSessionId ?? null,
      });
      if (!created.ok) {
        sessionsError.value = `${created.code}：${created.message}`;
        return;
      }
      sessions.value = [created.data, ...sessions.value.filter((session) => session.id !== created.data.id)];
      await selectSession(created.data.id);
      draft.value = request.prompt;
      draftContextLabel.value = request.contextLabel ?? null;
      await nextTick();
      composerInput.value?.focus();
    }
    emit("request-consumed", request.id);
  } finally {
    handlingRequestId = null;
    if (props.request && props.request.id !== request.id) {
      void consumeWorkspaceRequest(props.request);
    }
  }
}

watch(
  () => props.request,
  (request, previous) => {
    if (!request || request.id === previous?.id) return;
    void consumeWorkspaceRequest(request);
  },
);

function handleFrame(frame: ChatSseFrame, state: TurnStreamState): void {
  const ui = state.currentAssistant;
  switch (frame.type) {
    case "run_started":
      state.runId = frame.data.run_id;
      activeRunIds.set(state.sessionId, frame.data.run_id);
      activeRunId.value = frame.data.run_id;
      break;
    case "assistant_start": {
      const assistantStartedAt = typeof frame.data.timestamp === "number"
        ? new Date(frame.data.timestamp).toISOString()
        : new Date().toISOString();
      state.assistantStarts += 1;
      if (state.assistantStarts === 1) state.currentAssistant.createdAt = assistantStartedAt;
      if (state.assistantStarts > 1) {
        if (typingTarget) streamTypewriter.flush();
        ui.streaming = false;
        const nextAssistant: UiMessage = {
          key: `stream-a-${Date.now()}-${state.assistantStarts}`,
          role: "assistant",
          createdAt: assistantStartedAt,
          text: "",
          images: [],
          tools: [],
          streaming: true,
          errorText: null,
        };
        messages.value.push(nextAssistant);
        state.currentAssistant = messages.value[messages.value.length - 1]!;
        typingTarget = state.currentAssistant;
        streamTypewriter.start();
        scrollBottom();
      }
      break;
    }
    case "context_compacted": {
      const session = activeSession.value;
      if (session) {
        session.context_summary_through_seq = frame.data.through_seq;
        session.context_summary_estimated_tokens = frame.data.estimated_tokens;
        session.context_compacted_at = new Date().toISOString();
      }
      appMessage.info(`较早对话已压缩为摘要，完整原始消息仍保留（截至 #${frame.data.through_seq}）`, {
        title: "上下文已压缩",
      });
      break;
    }
    case "text":
      if (typingTarget === state.currentAssistant) streamTypewriter.push(frame.data.delta);
      break;
    case "tool_start":
      ui.tools.push({
        id: frame.data.toolCallId,
        name: frame.data.name,
        args: frame.data.args ?? null,
        status: "running",
        resultText: null,
        confirmation: null,
        expanded: false,
      });
      scrollBottom();
      break;
    case "tool_update": {
      const tool = ui.tools.find((t) => t.id === frame.data.toolCallId);
      if (tool) tool.resultText = resultTextOf(frame.data.result);
      break;
    }
    case "tool_end": {
      const tool = ui.tools.find((t) => t.id === frame.data.toolCallId);
      if (tool) {
        tool.status = frame.data.isError ? "error" : "done";
        tool.resultText = resultTextOf(frame.data.result);
      }
      scrollBottom();
      break;
    }
    case "confirmation_pending": {
      // 帧在 tool_end 之后发出：挂到本轮最后一个同名且未挂确认的工具卡
      const tool = [...ui.tools]
        .reverse()
        .find((t) => t.name === frame.data.tool_name && !t.confirmation);
      if (tool) {
        tool.confirmation = {
          id: frame.data.confirmation_id,
          payload: frame.data.payload ?? null,
          status: "pending",
          result: null,
          acting: false,
          error: null,
        };
      }
      scrollBottom();
      break;
    }
    case "done":
      state.terminal = "done";
      break;
    case "aborted":
      state.terminal = "aborted";
      state.currentAssistant.errorText ||= "已中断";
      appMessage.info("Agent 已停止；已完成的工具操作不会回滚", { title: "本轮已中断" });
      break;
    case "error":
      state.terminal = "error";
      ui.errorText = `${frame.data.code}：${frame.data.message}`;
      appMessage.error(frame.data.message, { title: "AI 回复失败", code: frame.data.code });
      break;
  }
}

/** 仅断开当前页面持有的响应流，服务端 Agent 继续后台运行。 */
function abortStream(note: string): void {
  if (!abortCtrl) return;
  abortedByUser = true;
  abortCtrl.abort();
  const streaming = messages.value.find((m) => m.streaming);
  if (streaming) {
    if (typingTarget === streaming) {
      streamTypewriter.flush();
      typingTarget = null;
    }
    streaming.streaming = false;
    if (!streaming.errorText) streaming.errorText = note;
  }
}

function detachLocalStream(note: string): void {
  abortStream(note);
  activeRunId.value = null;
  closeEvents();
}

async function reconcileMissingRun(sessionId: string): Promise<void> {
  activeRunIds.delete(sessionId);
  if (activeId.value !== sessionId) return;
  activeRunId.value = null;
  await loadSessions();
  if (activeId.value === sessionId) await loadConversation(sessionId, false);
}

async function stopCurrentTurn(): Promise<void> {
  const sessionId = activeId.value;
  const runId = activeRunId.value;
  if (!sessionId || !runId || stopping.value) return;
  stopping.value = true;
  const response = await apiClient.post<AgentControlResult>(
    `/api/chat/${sessionId}/control`,
    { action: "abort", run_id: runId },
  );
  stopping.value = false;
  if (!response.ok) {
    if (response.code === "AGENT_NOT_RUNNING") await reconcileMissingRun(sessionId);
    abortStream("停止请求未命中当前运行，请刷新会话确认状态");
    return;
  }
  appMessage.info("已发送停止请求，正在等待当前模型或工具释放", { title: "正在中断" });
}

async function submitControl(action: "steer" | "follow_up"): Promise<void> {
  const text = draft.value.trim();
  const sessionId = activeId.value;
  const runId = activeRunId.value;
  if (!canControl.value || !sessionId || !runId || !text) return;
  controlling.value = true;
  const response = await apiClient.post<AgentControlResult>(
    `/api/chat/${sessionId}/control`,
    { action, text, run_id: runId },
  );
  controlling.value = false;
  if (!response.ok) {
    if (response.code === "AGENT_NOT_RUNNING") await reconcileMissingRun(sessionId);
    return;
  }
  messages.value.push({
    key: `local-control-${Date.now()}`,
    role: "user",
    createdAt: new Date().toISOString(),
    text,
    images: [],
    tools: [],
  });
  draft.value = "";
  draftContextLabel.value = null;
  scrollBottom(true);
  appMessage.info(
    action === "steer"
      ? "干预已接收，将在当前步骤完成后的下一个模型边界生效"
      : "追问已排队，将在本轮自然结束后执行",
    { title: action === "steer" ? "已干预当前任务" : "已排队追问" },
  );
}

async function send(): Promise<void> {
  const text = draft.value.trim();
  if (!canSend.value || !activeId.value) return;
  const sessionId = activeId.value;
  sending.value = true;
  turnError.value = null;
  const sentAt = new Date().toISOString();

  const userMsg: UiMessage = {
    key: `local-u-${Date.now()}`,
    role: "user",
    createdAt: sentAt,
    text,
    images: pendingImages.value.map((p) => p.src),
    tools: [],
  };
  const assistantDraft: UiMessage = {
    key: `local-a-${Date.now()}`,
    role: "assistant",
    createdAt: sentAt,
    text: "",
    images: [],
    tools: [],
    streaming: true,
    errorText: null,
  };
  messages.value.push(userMsg, assistantDraft);
  // 后续 SSE 回调必须持有 reactive 数组中返回的 Proxy；继续修改原始对象不会触发 Vue 重绘。
  const assistant = messages.value[messages.value.length - 1]!;
  typingTarget = assistant;
  streamTypewriter.start();
  const attachmentIds = pendingImages.value.map((p) => p.id);
  draft.value = "";
  draftContextLabel.value = null;
  pendingImages.value = [];
  uploadError.value = null;
  scrollBottom(true);

  abortedByUser = false;
  abortCtrl = new AbortController();
  const streamState: TurnStreamState = {
    sessionId,
    terminal: null,
    currentAssistant: assistant,
    assistantStarts: 0,
    runId: null,
  };
  // 空闲会话只在用户真正发送后建立事件流；重新进入历史会话不会启动流或调用模型。
  openEvents(sessionId);
  const fail = await postSseStream(
    `/api/chat/${sessionId}/messages`,
    { text, attachment_ids: attachmentIds },
    {
      signal: abortCtrl.signal,
      onFrame: (f) => handleFrame(f as ChatSseFrame, streamState),
    },
  );
  if (typingTarget === streamState.currentAssistant) {
    await streamTypewriter.finish();
    typingTarget = null;
  }
  abortCtrl = null;
  sending.value = false;
  streamState.currentAssistant.streaming = false;
  if (streamState.runId && activeRunIds.get(sessionId) === streamState.runId) {
    activeRunIds.delete(sessionId);
  }
  if (activeRunId.value === streamState.runId) activeRunId.value = null;
  stopping.value = false;
  controlling.value = false;

  if (fail) {
    // 建流前失败（LLM_NOT_CONFIGURED / 校验失败 / 网络）：移除空气泡，整轮错误条呈现
    streamState.currentAssistant.errorText = `${fail.code}：${fail.message}`;
    if (!streamState.currentAssistant.text && streamState.currentAssistant.tools.length === 0) {
      messages.value = messages.value.filter((m) => m !== streamState.currentAssistant);
      turnError.value = streamState.currentAssistant.errorText;
    }
    if (fail.code === "LLM_NOT_CONFIGURED" || fail.code === "LLM_UNKNOWN_PROVIDER") {
      void llm.reload();
    }
  } else if (streamState.terminal === null) {
    // 流结束但没有 done/error 帧：主动中断或连接中断，已产出部分保留
    if (!streamState.currentAssistant.errorText) {
      streamState.currentAssistant.errorText = abortedByUser ? "已中断" : "连接中断，以上内容可能不完整";
    }
  }
  scrollBottom();
  void loadSessions(); // 首条消息后会话标题更新
}

const turnError = ref<string | null>(null);

// ---- 确认卡决策 ----
async function decide(tool: UiToolCall, action: "approve" | "reject"): Promise<void> {
  const conf = tool.confirmation;
  if (!conf || conf.status !== "pending") return;
  conf.acting = true;
  conf.error = null;
  const r = await apiClient.post<Confirmation>(`/api/confirmations/${conf.id}/${action}`, {});
  conf.acting = false;
  if (r.ok) {
    conf.status = r.data.status;
    conf.result = r.data.result;
    appMessage.success(action === "approve" ? "变更提案已批准" : "变更提案已拒绝");
  } else {
    conf.error = `${r.code}：${r.message}`;
    if (r.status === 409) await reconcileConfirmations(); // 状态已变化（如已过期/他处处理）
  }
}

// ---- 图片附件（vision 门控） ----
const pendingImages = ref<{ id: string; src: string; name: string }[]>([]);
const uploading = ref(false);
const uploadError = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const uploadDisabled = computed(
  () =>
    !configured.value ||
    !supportsVision.value ||
    !activeId.value ||
    isArchivedSession.value ||
    isAgentRunning.value ||
    uploading.value,
);
const uploadHint = computed(() => {
  if (!configured.value) return null;
  const choice = selectedChatModel.value;
  if (choice && !choice.model.input_modalities.includes("image")) {
    return `本会话模型 ${choice.provider.name}·${choice.model.name} 仅支持文本，切换图文模型后可上传图片`;
  }
  return null;
});

async function onPickImage(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !activeId.value) return;
  if (!file.type.startsWith("image/")) {
    uploadError.value = "仅支持图片文件（png/jpg/jpeg/gif/webp/bmp）";
    appMessage.warning(uploadError.value, { title: "无法上传图片" });
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    uploadError.value = `图片 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过 10MB 上限`;
    appMessage.warning(uploadError.value, { title: "图片过大" });
    return;
  }
  uploading.value = true;
  uploadError.value = null;
  const r = await uploadFile<ChatAttachment>(
    `/api/chat/${activeId.value}/attachments`,
    file,
  );
  uploading.value = false;
  if (r.ok) {
    pendingImages.value.push({
      id: r.data.id,
      src: URL.createObjectURL(file),
      name: file.name,
    });
  } else {
    uploadError.value = `上传失败（${r.code}）：${r.message}`;
  }
}

function removePendingImage(id: string): void {
  pendingImages.value = pendingImages.value.filter((p) => p.id !== id);
}

function onComposerKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (isAgentRunning.value) void submitControl("steer");
    else void send();
  }
}

function reloadLlmConfig(): void {
  void Promise.all([llm.reload(), llmCatalog.reload()]);
}

onMounted(async () => {
  window.addEventListener("stock:agent-settings-changed", llm.reload);
  window.addEventListener("stock:llm-config-changed", reloadLlmConfig);
  await Promise.all([llm.reload(), llmCatalog.reload(), loadSessions()]);
  const first = sessions.value[0];
  if (first) await selectSession(first.id);
  workspaceReady.value = true;
  if (props.request) await consumeWorkspaceRequest(props.request);
});

onBeforeUnmount(() => {
  window.removeEventListener("stock:agent-settings-changed", llm.reload);
  window.removeEventListener("stock:llm-config-changed", reloadLlmConfig);
  detachLocalStream("已关闭对话面板，当前运行继续在后台执行");
  if (scrollAnimationId !== null) window.cancelAnimationFrame(scrollAnimationId);
});
</script>

<template>
  <section class="chat-view" :class="{ embedded }">
    <div v-if="!embedded" class="page-head">
      <h1>对话</h1>
      <div class="sub">
        复合问题与非结构化操作 ·
        <span v-if="llm.data.value?.yolo_mode" class="badge yolo-badge" title="数据库变更校验通过后直接执行，不显示待确认卡">⚡ YOLO 直接写库</span>
        <template v-else>写操作确认后生效</template>
        <span v-if="selectedChatModel" class="badge accent">
          {{ selectedChatModel.provider.name }}·{{ selectedChatModel.model.name }}
        </span>
      </div>
    </div>

    <!-- LLM 未配置/异常降级引导（其余页面不受影响） -->
    <div v-if="llmCatalog.data.value && !configured" class="card llm-guide">
      <div class="card-title">✦ AI 通道未配置</div>
      <p class="card-desc">
        {{ modelAvailabilityMessage }}。可直接在本会话模型选择器中切换，或前往<RouterLink to="/settings" @click="embedded && emit('request-close')">设置 → AI 模型与厂商</RouterLink>补齐配置。
        配置保存后立即生效；未配置不影响系统其余功能，历史会话仍可回看。
      </p>
      <p v-if="llmCatalog.error.value" class="guide-detail num">
        {{ llmCatalog.error.value.code }}：{{ llmCatalog.error.value.message }}
      </p>
    </div>

    <div class="chat-layout">
      <!-- 会话列表 -->
      <aside class="card session-panel">
        <button class="btn primary new-session agent-entry" type="button" @click="createNewSession">
          新建会话
        </button>
        <p v-if="sessionsError" class="panel-error">{{ sessionsError }}</p>
        <p v-else-if="sessions.length === 0" class="panel-empty">
          {{ showArchived ? "没有已归档会话" : "还没有会话，点上方新建" }}
        </p>
        <ul v-else class="session-list">
          <li
            v-for="s in sessions"
            :key="s.id"
            class="session-item"
            :class="{ active: s.id === activeId }"
            @click="selectSession(s.id)"
          >
            <input
              v-if="renamingId === s.id"
              v-model="renameDraft"
              class="rename-input"
              type="text"
              @click.stop
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="renamingId = null"
              @blur="commitRename"
              v-focus
            />
            <template v-else>
              <span class="session-title-row">
                <span class="session-title">{{ s.title }}</span>
                <span v-if="s.session_type !== 'interactive'" class="session-kind">
                  {{ SESSION_TYPE_LABELS[s.session_type] }}
                </span>
              </span>
              <span class="session-meta">
                <span class="session-id num">#{{ s.id }}</span>
                <span v-if="s.session_status !== 'idle'" class="session-state">
                  {{ SESSION_STATUS_LABELS[s.session_status] }}
                </span>
                <span class="session-actions" @click.stop>
                  <button type="button" title="重命名" @click="startRename(s)">✏️</button>
                  <button
                    v-if="!showArchived"
                    type="button"
                    title="归档"
                    @click="setArchived(s, true)"
                  >🗂</button>
                  <button
                    v-else
                    type="button"
                    title="取消归档"
                    @click="setArchived(s, false)"
                  >↩︎</button>
                </span>
              </span>
            </template>
          </li>
        </ul>
        <button class="archived-toggle" type="button" @click="toggleArchivedView">
          {{ showArchived ? "← 返回进行中的会话" : "已归档会话" }}
        </button>
      </aside>

      <!-- 消息区 + 输入区 -->
      <div class="card chat-panel">
        <div v-if="activeSession" class="conversation-toolbar">
          <span class="model-switch-label">本会话模型</span>
          <UiSelect
            :model-value="effectiveModelId"
            :options="chatModelOptions"
            class="chat-model-select"
            placeholder="选择模型"
            searchable
            aria-label="本会话模型"
            :disabled="isArchivedSession || isAgentRunning || switchingModel || llmCatalog.loading.value"
            @update:model-value="switchSessionModel"
          />
          <span v-if="switchingModel" class="model-switch-state">保存中…</span>
          <span v-if="activeSession.session_type !== 'interactive'" class="badge task-session-badge">
            {{ SESSION_TYPE_LABELS[activeSession.session_type] }}会话 · 可继续追问
          </span>
          <span
            v-if="activeSession.context_summary_through_seq > 0"
            class="badge compacted-badge"
            :title="`较早消息已压缩为模型上下文摘要；完整原始历史仍保留。摘要截至 #${activeSession.context_summary_through_seq}`"
          >
            已压缩上下文
          </span>
        </div>
        <p v-if="modelSwitchError" class="model-switch-error" role="alert">
          {{ modelSwitchError }}
        </p>
        <div ref="msgPane" class="msg-list" @scroll.passive="onMessageScroll">
          <StateBlock
            v-if="!activeSession"
            :loading="false"
            :error="null"
            :empty="true"
            empty-text="选择左侧会话，或新建一个开始对话"
          />
          <StateBlock
            v-else-if="loadingMessages || messagesError"
            :loading="loadingMessages"
            :error="messagesError ? { ok: false, code: 'LOAD', message: messagesError } : null"
            :empty="false"
            :skeleton-rows="4"
            @retry="reloadActive"
          />
          <template v-else>
            <div v-if="conversationTurns.length === 0" class="chat-empty">
              <p>开始提问吧，例如：</p>
              <p class="hint">「我现在有哪些持仓？一句话列一下」</p>
              <p class="hint">「完整评估格林美，符合条件就加入短线池」</p>
            </div>
            <template v-for="turn in conversationTurns" :key="turn.key">
              <div v-if="turn.role === 'user'" class="msg user">
                <div class="msg-bubble">
                  <div v-if="turn.message.images.length" class="msg-images">
                    <img v-for="(src, i) in turn.message.images" :key="i" :src="src" alt="图片附件" />
                  </div>
                  <div v-if="turn.message.text" class="user-text">{{ turn.message.text }}</div>
                  <time class="message-time user-message-time" :datetime="turn.message.createdAt">
                    {{ fmtTime(turn.message.createdAt) }}
                  </time>
                </div>
              </div>

              <div v-else class="msg agent">
                <article class="agent-turn">
                  <span class="agent-mark" aria-hidden="true">✦</span>
                  <div class="agent-turn-flow">
                    <div class="agent-turn-body">
                      <template v-for="(phase, phaseIndex) in turn.messages" :key="phase.key">
                        <section
                          v-if="phase.text"
                          class="agent-phase"
                          :class="[
                            isAgentAnswer(turn, phaseIndex) ? 'answer' : 'thought',
                            { active: phase.streaming },
                          ]"
                        >
                          <MarkdownView :source="phase.text" breaks />
                        </section>

                        <section v-if="phase.tools.length" class="agent-phase tools">
                          <ToolGroupCard
                            v-for="group in groupToolCalls(phase.tools)"
                            :key="group.key"
                            :tools="group.tools"
                            @decide="(tool, action) => decide(tool, action)"
                          />
                        </section>

                        <section
                          v-if="phase.streaming && !phase.text && phase.tools.length === 0"
                          class="agent-phase pending"
                          role="status"
                          aria-label="Agent 正在思考"
                        >
                          <div class="assistant-thinking">
                            <span>思考与进展</span>
                            <span class="thinking-dots" aria-hidden="true">
                              <i></i><i></i><i></i>
                            </span>
                          </div>
                        </section>

                        <div v-if="phase.errorText" class="chat-error-bar">⚠ {{ phase.errorText }}</div>
                      </template>
                    </div>
                    <time
                      v-if="agentTurnTime(turn)"
                      class="message-time agent-message-time"
                      :datetime="turn.messages[turn.messages.length - 1]?.createdAt"
                    >
                      {{ agentTurnTime(turn) }}
                    </time>
                  </div>
                </article>
              </div>
            </template>
            <div v-if="turnError" class="chat-error-bar global">⚠ {{ turnError }}</div>
          </template>
        </div>
        <button
          v-if="showLatestButton"
          class="jump-latest"
          type="button"
          @click="resumeFollowing"
        >
          ↓ 回到最新
        </button>

        <!-- 输入区 -->
        <div class="composer">
          <p v-if="draftContextLabel" class="context-prefill">
            <span>✦ 已带入：{{ draftContextLabel }}</span>
            <span>检查问题后发送</span>
          </p>
          <p v-if="uploadHint" class="upload-hint">🖼 {{ uploadHint }}</p>
          <p v-if="uploadError" class="upload-error">⚠ {{ uploadError }}</p>
          <div class="composer-box">
            <div v-if="pendingImages.length" class="pending-images">
              <span v-for="p in pendingImages" :key="p.id" class="pending-img">
                <img :src="p.src" :alt="p.name" />
                <button type="button" class="remove-img" @click="removePendingImage(p.id)">×</button>
              </span>
            </div>
            <input
              ref="fileInput"
              type="file"
              accept="image/*"
              hidden
              @change="onPickImage"
            />
            <textarea
              ref="composerInput"
              v-model="draft"
              rows="2"
              :placeholder="
                !configured
                  ? 'AI 通道未配置，配置后可对话'
                  : isArchivedSession
                    ? '会话已归档，仅可回看'
                    : isAgentRunning
                      ? '回复生成中，可输入补充并干预或排到下一轮'
                      : '输入问题，Enter 发送，Shift+Enter 换行'
              "
              :disabled="!configured || !activeSession || isArchivedSession"
              @keydown="onComposerKeydown"
            ></textarea>
            <div class="composer-bar">
              <div class="composer-bar-left">
                <button
                  class="upload-btn"
                  type="button"
                  :disabled="uploadDisabled"
                  :title="uploadHint ?? '上传图片（≤10MB）'"
                  @click="fileInput?.click()"
                >{{ uploading ? "…" : "🖼" }}</button>
                <span
                  v-if="embedded && llm.data.value?.yolo_mode"
                  class="badge yolo-badge"
                  title="YOLO 模式：数据库变更校验通过后直接执行，不显示待确认卡"
                >⚡ YOLO</span>
              </div>
              <div v-if="isAgentRunning" class="running-controls">
                <button
                  class="queue-btn"
                  type="button"
                  :disabled="!canControl"
                  title="本轮自然结束后再处理"
                  @click="submitControl('follow_up')"
                >排到下一轮</button>
                <button
                  class="send-btn steer"
                  type="button"
                  :disabled="!canControl"
                  title="当前步骤完成后立即注入"
                  @click="submitControl('steer')"
                >{{ controlling ? "提交中…" : "干预" }}</button>
                <button
                  class="send-btn stop"
                  type="button"
                  :disabled="!activeRunId || stopping"
                  @click="stopCurrentTurn"
                >{{ stopping ? "停止中…" : "■ 停止" }}</button>
              </div>
              <button v-else class="send-btn" type="button" :disabled="!canSend" @click="send">
                发送
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 76px);
}

.chat-view.embedded {
  height: 100%;
  min-height: 0;
}

.chat-view.embedded .llm-guide {
  margin: var(--space-md) var(--space-md) 0;
}

.chat-view.embedded .chat-layout {
  min-height: 0;
  grid-template-columns: minmax(148px, 172px) minmax(0, 1fr);
  gap: 0;
}

.context-prefill {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  margin: 0 0 6px;
  color: var(--accent-ink);
  font-size: var(--fs-xs);
}

.context-prefill span:last-child {
  color: var(--ink-faint);
}

.chat-view.embedded .session-panel,
.chat-view.embedded .chat-panel {
  border-width: 0;
  border-radius: 0;
  box-shadow: none;
}

.chat-view.embedded .session-panel {
  border-right: 1px solid var(--line);
  padding: 10px 8px;
}

.chat-view.embedded .model-switch-label {
  display: none;
}

.chat-view.embedded .conversation-toolbar {
  gap: 6px;
}

.llm-guide {
  margin-bottom: var(--space-lg);
  border-color: var(--warn);
}

.llm-guide code {
  background: var(--paper-deep);
  border-radius: 6px;
  padding: 1px 6px;
  font-size: var(--fs-sm);
}

.guide-detail {
  margin: 10px 0 0;
  font-size: var(--fs-sm);
  color: var(--warn);
}

.yolo-badge {
  background: color-mix(in srgb, var(--bad) 10%, var(--paper));
  color: var(--bad);
  font-weight: 600;
}

.chat-layout {
  flex: 1;
  min-height: 420px;
  display: grid;
  grid-template-columns: 228px 1fr;
  gap: var(--space-lg);
}

.session-panel {
  padding: var(--space-md);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.new-session {
  width: 100%;
  justify-content: center;
  margin-bottom: 10px;
}

.panel-empty,
.panel-error {
  font-size: var(--fs-sm);
  color: var(--ink-faint);
  padding: 6px 4px;
}

.panel-error {
  color: var(--bad);
}

.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.session-item {
  position: relative;
  padding: var(--space-sm) 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
  transition: background var(--dur) var(--ease);
}

.session-item:hover {
  background: var(--accent-soft);
}

.session-item.active {
  background: var(--accent-soft);
}

.session-item.active .session-title {
  color: var(--accent-ink);
  font-weight: 600;
}

.session-title {
  font-size: var(--fs-md);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-title-row {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.session-title-row .session-title {
  min-width: 0;
  flex: 1;
}

/* 悬浮出现操作图标时，标题提前截断让位 */
.session-item:hover .session-title-row {
  padding-right: 44px;
}

.session-kind,
.session-state {
  flex: none;
  border-radius: 999px;
  background: var(--paper-deep);
  color: var(--ink-faint);
  padding: 1px 6px;
  font-size: 10px;
  line-height: 1.5;
}

.session-kind {
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.session-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

/* 会话 ID 可收缩，状态标签（运行中…）始终完整不溢出 */
.session-id {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--ink-faint);
}

/* 悬浮操作：绝对定位浮在标题行右端，不参与排版，避免挤压时间换行 */
.session-actions {
  position: absolute;
  top: 6px;
  right: 6px;
  display: none;
  gap: 2px;
  padding: 1px 3px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
}

.session-item:hover .session-actions {
  display: inline-flex;
}

.session-actions button {
  border: none;
  background: none;
  cursor: pointer;
  font-size: var(--fs-sm);
  padding: 0 3px;
  opacity: 0.75;
}

.session-actions button:hover {
  opacity: 1;
}

.rename-input {
  width: 100%;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--card);
  color: var(--ink);
  padding: 3px var(--space-sm);
  font-size: var(--fs-md);
  font-family: var(--font-body);
  outline: none;
}

.archived-toggle {
  margin-top: auto;
  border: none;
  background: none;
  color: var(--ink-faint);
  font-size: var(--fs-sm);
  cursor: pointer;
  padding: var(--space-sm) 4px 2px;
  text-align: left;
  font-family: var(--font-body);
}

.archived-toggle:hover {
  color: var(--accent-ink);
}

.chat-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}

.conversation-toolbar {
  position: relative;
  z-index: 3;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-sm);
  min-height: 48px;
  padding: 6px var(--space-md);
  border-bottom: 1px solid var(--line);
  background: var(--card);
}

.model-switch-label,
.model-switch-state {
  color: var(--ink-faint);
  font-size: var(--fs-xs);
  white-space: nowrap;
}

.conversation-toolbar :deep(.chat-model-select) {
  width: auto;
  min-width: 0;
  flex: 1 1 260px;
  min-height: 34px;
  --ms-font-size: 12px;
  --ms-py: 5px;
  --ms-radius: var(--radius-sm);
}

.task-session-badge,
.compacted-badge {
  flex: none;
  white-space: nowrap;
  font-size: 10px;
}

.task-session-badge {
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.compacted-badge {
  background: var(--paper-deep);
  color: var(--ink-soft);
}

.model-switch-error {
  flex: none;
  margin: 0;
  padding: 5px var(--space-md);
  border-bottom: 1px solid color-mix(in srgb, var(--bad) 24%, var(--line));
  background: var(--up-bg);
  color: var(--bad);
  font-size: var(--fs-xs);
}

.msg-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-lg);
}

.chat-view.embedded .msg-list {
  padding: var(--space-md);
}

.chat-empty {
  color: var(--ink-faint);
  font-size: var(--fs-md);
  text-align: center;
  margin-top: 12vh;
}

.chat-empty .hint {
  color: var(--ink-soft);
}

.msg {
  display: flex;
  margin-bottom: var(--space-md);
  animation: message-enter 160ms var(--ease) both;
}

.msg.user {
  justify-content: flex-end;
}

.msg.agent {
  justify-content: flex-start;
}

.msg-bubble {
  max-width: 82%;
  border-radius: var(--radius-md);
  padding: var(--space-sm) var(--space-md);
  font-size: var(--fs-md);
}

.msg.user .msg-bubble {
  background: var(--accent-soft);
  color: var(--accent-ink);
  border: 1px solid var(--line);
}

.message-time {
  display: block;
  color: var(--ink-faint);
  font-size: 10px;
  font-weight: 400;
  line-height: 1.4;
}

.user-message-time {
  margin-top: 5px;
  color: color-mix(in srgb, var(--accent-ink) 62%, transparent);
  text-align: right;
}

.agent-message-time {
  margin-top: 5px;
  text-align: left;
}

.agent-turn {
  display: grid;
  width: min(92%, 900px);
  min-width: 0;
  grid-template-columns: 26px minmax(0, 1fr);
  align-items: start;
  gap: 9px;
}

.chat-view.embedded .agent-turn {
  width: 100%;
}

.agent-mark {
  display: inline-flex;
  width: 26px;
  height: 26px;
  flex: none;
  align-items: center;
  justify-content: center;
  color: var(--accent-strong);
  font-size: 15px;
}

.agent-turn-flow {
  min-width: 0;
  padding-top: 2px;
}

.agent-turn-body {
  min-width: 0;
}

.agent-phase + .agent-phase,
.agent-phase + .chat-error-bar,
.chat-error-bar + .agent-phase {
  margin-top: 12px;
}

.agent-phase {
  min-width: 0;
}

.agent-phase :deep(.markdown-view) {
  min-width: 0;
  overflow-wrap: anywhere;
}

.agent-phase :deep(.markdown-view table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
}

.agent-phase.thought {
  padding: 1px 0 1px 11px;
  border-left: 2px solid color-mix(in srgb, var(--ink-faint) 48%, var(--line));
  color: var(--ink-soft);
}

.agent-phase.thought :deep(.markdown-view) {
  font-size: var(--fs-sm);
}

.agent-phase.answer {
  padding: 0;
}

.agent-phase.tools {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 1px 0;
}

.agent-phase.active :deep(.markdown-view > :last-child)::after {
  content: "";
  display: inline-block;
  width: 2px;
  height: 0.95em;
  margin-left: 3px;
  vertical-align: -0.08em;
  border-radius: 1px;
  background: var(--accent);
  animation: blink 900ms steps(2) infinite;
}

.assistant-thinking {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  color: var(--ink-soft);
  font-size: var(--fs-sm);
}

.thinking-dots {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.thinking-dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ink-faint);
  animation: thinking-pulse 1.15s ease-in-out infinite;
}

.thinking-dots i:nth-child(2) {
  animation-delay: 120ms;
}

.thinking-dots i:nth-child(3) {
  animation-delay: 240ms;
}

.user-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.msg-images {
  display: flex;
  gap: var(--space-sm);
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.msg-images img {
  max-width: 180px;
  max-height: 140px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  object-fit: cover;
}

.jump-latest {
  position: absolute;
  z-index: 2;
  left: 50%;
  bottom: 108px;
  transform: translateX(-50%);
  border: 1px solid var(--line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--card) 92%, transparent);
  color: var(--ink-soft);
  box-shadow: var(--shadow-sm);
  padding: 6px 12px;
  font: 500 var(--fs-sm) var(--font-body);
  cursor: pointer;
  backdrop-filter: blur(8px);
}

.jump-latest:hover {
  color: var(--accent-ink);
  border-color: var(--accent);
}

.chat-view.embedded .jump-latest {
  bottom: 92px;
}

@keyframes message-enter {
  from {
    opacity: 0;
    transform: translateY(5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes thinking-pulse {
  0%,
  70%,
  100% {
    opacity: 0.35;
    transform: translateY(0);
  }
  35% {
    opacity: 1;
    transform: translateY(-3px);
  }
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

.chat-error-bar {
  margin-top: var(--space-sm);
  font-size: var(--fs-sm);
  color: var(--bad);
  background: var(--up-bg);
  border-radius: var(--radius-sm);
  padding: var(--space-xs) 10px;
}

.chat-error-bar.global {
  margin: var(--space-xs) 0 var(--space-md);
}

.composer {
  border-top: 1px solid var(--line);
  padding: var(--space-md) var(--space-lg);
}

.chat-view.embedded .composer {
  padding: var(--space-sm) var(--space-md);
}

.composer-box {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  border: 1px solid var(--control-border);
  border-radius: var(--radius-md);
  background: var(--control-bg);
  padding: var(--space-xs);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}

.composer-box:focus-within {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--control-bg) 96%, var(--accent-soft));
}

.pending-images {
  display: flex;
  gap: var(--space-sm);
  padding: var(--space-xs) var(--space-xs) 0;
}

.pending-img {
  position: relative;
  display: inline-block;
}

.pending-img img {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
}

.remove-img {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--ink-soft);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}

.upload-hint {
  font-size: var(--fs-sm);
  color: var(--ink-faint);
  margin: 0 0 var(--space-sm);
}

.upload-error {
  font-size: var(--fs-sm);
  color: var(--bad);
  margin: 0 0 var(--space-sm);
}

.composer textarea {
  width: 100%;
  resize: none;
  border: none;
  background: transparent;
  color: var(--ink);
  padding: var(--space-xs) var(--space-sm);
  font-size: var(--fs-md);
  font-family: var(--font-body);
  line-height: 1.6;
  outline: none;
  box-shadow: none;
}

.composer textarea:disabled {
  color: var(--ink-faint);
}

.composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  padding: 0 var(--space-xs) var(--space-xs);
}

.composer-bar-left {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
}

.upload-btn {
  width: var(--control-height);
  height: var(--control-height);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ink-soft);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}

.upload-btn:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.send-btn {
  height: 28px;
  padding: 0 var(--space-md);
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: white;
  font-size: var(--fs-sm);
  font-weight: 600;
  font-family: var(--font-body);
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}

.send-btn:hover:not(:disabled) {
  background: var(--accent-strong);
}

.send-btn.stop {
  background: var(--paper-deep);
  color: var(--ink-soft);
  border: 1px solid var(--line);
}

.send-btn.stop:hover {
  background: var(--up-bg);
  color: var(--bad);
  border-color: color-mix(in srgb, var(--bad) 38%, var(--line));
}

.running-controls {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.queue-btn {
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ink-soft);
  font: 500 var(--fs-xs) var(--font-body);
  cursor: pointer;
}

.queue-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent-ink);
}

.send-btn.steer {
  padding-inline: 12px;
}

.send-btn:disabled,
.queue-btn:disabled,
.upload-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

@media (max-width: 720px) {
  .chat-view.embedded .chat-layout {
    grid-template-columns: minmax(104px, 112px) minmax(0, 1fr);
  }

  .chat-view.embedded .session-panel {
    padding-inline: 6px;
  }

  .conversation-toolbar .model-switch-label {
    display: none;
  }

  .running-controls {
    gap: 4px;
    margin-left: auto;
  }

  .composer-bar {
    flex-wrap: wrap;
  }

  .queue-btn,
  .send-btn {
    padding-inline: 8px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .msg,
  .thinking-dots i,
  .agent-phase.active :deep(.markdown-view > :last-child)::after {
    animation: none;
  }
}
</style>
