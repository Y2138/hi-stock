<script setup lang="ts">
import { appMessage, appMessages, type AppMessageType } from "../stores/message";

const ICONS: Record<AppMessageType, string> = {
  success: "✓",
  error: "!",
  warning: "!",
  info: "i",
};

function ariaRole(type: AppMessageType): "alert" | "status" {
  return type === "error" || type === "warning" ? "alert" : "status";
}
</script>

<template>
  <Teleport to="body">
    <TransitionGroup
      name="app-message"
      tag="div"
      class="app-message-stack"
      aria-label="系统提示"
      aria-live="polite"
    >
      <article
        v-for="item in appMessages"
        :key="item.id"
        class="app-message-card"
        :class="item.type"
        :role="ariaRole(item.type)"
      >
        <span class="app-message-icon" aria-hidden="true">{{ ICONS[item.type] }}</span>
        <div class="app-message-content">
          <div class="app-message-title">
            {{ item.title }}
            <code v-if="item.code">{{ item.code }}</code>
          </div>
          <p>{{ item.text }}</p>
        </div>
        <button
          class="app-message-close"
          type="button"
          aria-label="关闭提示"
          @click="appMessage.dismiss(item.id)"
        >×</button>
      </article>
    </TransitionGroup>
  </Teleport>
</template>

<style scoped>
.app-message-stack {
  position: fixed;
  z-index: 130;
  top: 62px;
  left: 50%;
  width: min(440px, calc(100vw - 32px));
  display: grid;
  gap: var(--space-sm);
  pointer-events: none;
  transform: translateX(-50%);
}

.app-message-card {
  --message-color: var(--idle);
  position: relative;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) 24px;
  align-items: start;
  gap: 10px;
  min-height: 58px;
  overflow: hidden;
  padding: 11px 10px 11px 12px;
  border: 1px solid color-mix(in srgb, var(--message-color) 34%, var(--line));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--card) 96%, var(--message-color) 4%);
  color: var(--ink);
  box-shadow: var(--shadow-lift);
  pointer-events: auto;
}

.app-message-card::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--message-color);
  content: "";
}

.app-message-card.success { --message-color: var(--ok); }
.app-message-card.error { --message-color: var(--bad); }
.app-message-card.warning { --message-color: var(--warn); }
.app-message-card.info { --message-color: var(--accent); }

.app-message-icon {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--message-color) 14%, transparent);
  color: var(--message-color);
  font: 700 13px/1 var(--font-body);
}

.app-message-content {
  min-width: 0;
}

.app-message-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
  color: var(--ink);
  font-size: var(--fs-md);
  font-weight: 650;
  line-height: 1.35;
}

.app-message-title code {
  color: var(--ink-faint);
  font-size: var(--fs-xs);
  font-weight: 500;
}

.app-message-content p {
  margin: 3px 0 0;
  color: var(--ink-soft);
  font-size: var(--fs-sm);
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.app-message-close {
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ink-faint);
  font: 16px/1 var(--font-body);
  cursor: pointer;
}

.app-message-close:hover {
  background: var(--paper-deep);
  color: var(--ink);
}

.app-message-enter-active,
.app-message-leave-active,
.app-message-move {
  transition: opacity 180ms var(--ease), transform 180ms var(--ease);
}

.app-message-enter-from,
.app-message-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}

@media (max-width: 560px) {
  .app-message-stack {
    top: 12px;
    width: calc(100vw - 24px);
  }
}
</style>
