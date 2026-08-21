<script setup lang="ts">
import Multiselect from "@vueform/multiselect";

export interface SelectOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

withDefaults(
  defineProps<{
    modelValue: string | number | null;
    options: SelectOption[];
    placeholder?: string;
    searchable?: boolean;
    canClear?: boolean;
    disabled?: boolean;
    ariaLabel?: string;
  }>(),
  {
    placeholder: "请选择",
    searchable: false,
    canClear: false,
    disabled: false,
    ariaLabel: "选择项",
  },
);

defineEmits<{
  "update:modelValue": [value: string | number | null];
}>();
</script>

<template>
  <Multiselect
    :model-value="modelValue"
    :options="options"
    value-prop="value"
    label="label"
    :placeholder="placeholder"
    :searchable="searchable"
    :can-clear="canClear"
    :can-deselect="canClear"
    :disabled="disabled"
    :aria-label="ariaLabel"
    no-options-text="没有可选项"
    no-results-text="没有匹配项"
    class="ui-select"
    @update:model-value="$emit('update:modelValue', $event as string | number | null)"
  />
</template>

<style>
.ui-select {
  --ms-font-size: 13px;
  --ms-line-height: 1.4;
  --ms-bg: var(--card);
  --ms-bg-disabled: var(--paper-deep);
  --ms-border-color: var(--line);
  --ms-border-width: 1px;
  --ms-border-color-active: var(--accent);
  --ms-border-width-active: 1px;
  --ms-radius: 9px;
  --ms-py: 6px;
  --ms-px: 10px;
  --ms-ring-width: 3px;
  --ms-ring-color: color-mix(in srgb, var(--accent) 18%, transparent);
  --ms-placeholder-color: var(--ink-faint);
  --ms-spinner-color: var(--accent);
  --ms-caret-color: var(--ink-soft);
  --ms-clear-color: var(--ink-faint);
  --ms-clear-color-hover: var(--ink);
  --ms-dropdown-bg: var(--card);
  --ms-dropdown-border-color: var(--line);
  --ms-dropdown-radius: 10px;
  --ms-option-font-size: 13px;
  --ms-option-bg-pointed: var(--accent-soft);
  --ms-option-color-pointed: var(--accent-ink);
  --ms-option-bg-selected: var(--accent-soft);
  --ms-option-color-selected: var(--accent-ink);
  --ms-option-bg-selected-pointed: var(--accent);
  --ms-option-color-selected-pointed: white;
  min-height: 36px;
  color: var(--ink);
}

.ui-select .multiselect-dropdown {
  box-shadow: var(--shadow-lift);
  z-index: 80;
}
</style>

