<script setup lang="ts">
// 统一多行文本控件：与 UiInput 同一套令牌口径，高度由 rows 控制、纵向可拉伸。
withDefaults(
  defineProps<{
    modelValue: string;
    rows?: number;
    placeholder?: string;
    disabled?: boolean;
    ariaLabel?: string;
  }>(),
  {
    rows: 3,
    placeholder: "",
    disabled: false,
    ariaLabel: undefined,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

function onInput(event: Event): void {
  emit("update:modelValue", (event.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <textarea
    class="ui-textarea"
    :rows="rows"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :aria-label="ariaLabel"
    @input="onInput"
  />
</template>

<style scoped>
.ui-textarea {
  width: 100%;
  padding: 6px var(--control-padding-x);
  font-family: var(--font-body);
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--ink);
  background: var(--control-bg);
  border: 1px solid var(--control-border);
  border-radius: var(--control-radius);
  resize: vertical;
  transition:
    border-color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}

.ui-textarea:hover:not(:disabled):not(:focus) {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--control-border));
}

.ui-textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent);
}

.ui-textarea::placeholder {
  color: var(--ink-faint);
}

.ui-textarea:disabled {
  background: var(--paper-deep);
  color: var(--ink-faint);
  cursor: not-allowed;
}
</style>
