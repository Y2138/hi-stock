<script setup lang="ts">
// 统一文本输入控件：与 UiSelect 同一套令牌口径（--control-* / --fs-sm / accent 聚焦光环）。
// 宽度默认 100%，由调用处布局类约束；min/step/autocomplete 等原生属性自动透传到 input。
const props = withDefaults(
  defineProps<{
    modelValue: string | number | null;
    type?: string;
    placeholder?: string;
    disabled?: boolean;
    ariaLabel?: string;
    /** v-model.number 时由 Vue 注入，用于同步 looseToNumber 行为 */
    modelModifiers?: { number?: boolean };
  }>(),
  {
    type: "text",
    placeholder: "",
    disabled: false,
    ariaLabel: undefined,
    modelModifiers: undefined,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string | number];
}>();

function onInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  if (props.modelModifiers?.number) {
    const n = parseFloat(value);
    emit("update:modelValue", Number.isNaN(n) ? value : n);
  } else {
    emit("update:modelValue", value);
  }
}
</script>

<template>
  <input
    class="ui-input"
    :type="type"
    :value="modelValue ?? ''"
    :placeholder="placeholder"
    :disabled="disabled"
    :aria-label="ariaLabel"
    @input="onInput"
  />
</template>

<style scoped>
.ui-input {
  width: 100%;
  height: var(--control-height);
  padding: 0 var(--control-padding-x);
  font-family: var(--font-body);
  font-size: var(--fs-sm);
  color: var(--ink);
  background: var(--control-bg);
  border: 1px solid var(--control-border);
  border-radius: var(--control-radius);
  transition:
    border-color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}

.ui-input:hover:not(:disabled):not(:focus) {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--control-border));
}

.ui-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent);
}

.ui-input::placeholder {
  color: var(--ink-faint);
}

.ui-input:disabled {
  background: var(--paper-deep);
  color: var(--ink-faint);
  cursor: not-allowed;
}
</style>
