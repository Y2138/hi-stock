// 主题与动效偏好：主色和明暗外观彼此独立，均持久化到 localStorage。
import { ref } from "vue";

export type ThemeName = "warm" | "teal";
export type ColorSchemePreference = "system" | "light" | "dark";
export type ResolvedColorScheme = "light" | "dark";

const THEME_KEY = "stock.web.theme";
const COLOR_SCHEME_KEY = "stock.web.color-scheme";
const MOTION_KEY = "stock.web.motion";
export const THEME_CHANGED_EVENT = "stock:theme-changed";

function readTheme(): ThemeName {
  const v = localStorage.getItem(THEME_KEY);
  return v === "teal" ? "teal" : "warm";
}

function readColorScheme(): ColorSchemePreference {
  const value = localStorage.getItem(COLOR_SCHEME_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export const currentTheme = ref<ThemeName>(readTheme());
export const colorSchemePreference = ref<ColorSchemePreference>(readColorScheme());
export const resolvedColorScheme = ref<ResolvedColorScheme>("light");
export const motionOff = ref<boolean>(localStorage.getItem(MOTION_KEY) === "off");

function apply(): void {
  resolvedColorScheme.value =
    colorSchemePreference.value === "system"
      ? systemPrefersDark() ? "dark" : "light"
      : colorSchemePreference.value;
  document.documentElement.dataset.theme = currentTheme.value;
  document.documentElement.dataset.colorScheme = resolvedColorScheme.value;
  document.documentElement.dataset.motion = motionOff.value ? "off" : "on";
  document.documentElement.style.colorScheme = resolvedColorScheme.value;
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT));
}

export function setTheme(name: ThemeName): void {
  currentTheme.value = name;
  localStorage.setItem(THEME_KEY, name);
  apply();
}

export function setColorScheme(preference: ColorSchemePreference): void {
  colorSchemePreference.value = preference;
  localStorage.setItem(COLOR_SCHEME_KEY, preference);
  apply();
}

export function setMotionOff(off: boolean): void {
  motionOff.value = off;
  localStorage.setItem(MOTION_KEY, off ? "off" : "on");
  apply();
}

let initialized = false;

/** main.ts 启动时调用一次，把持久化偏好落到 <html> 上并监听系统外观。 */
export function initTheme(): void {
  if (!initialized && typeof window.matchMedia === "function") {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (colorSchemePreference.value === "system") apply();
    });
    initialized = true;
  }
  apply();
}
