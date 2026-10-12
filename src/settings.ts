// 设置状态：模块级单例 ref + localStorage 持久化（键沿用旧版，旧数据无缝迁移）。
// initSettings() 先重置默认再应用持久化值（幂等，可重复调用），
// 首次调用时注册 watch 把改动写回 localStorage——TimerPanel 与 SettingsPanel
// 共享同一份状态，无路由/无状态库的最小实现。

import { ref, watch } from "vue";

const WORK_KEY = "eye-guard.workMin";
const BREAK_KEY = "eye-guard.breakMin";
const LONG_BREAK_KEY = "eye-guard.longBreakMin";
const CYCLES_KEY = "eye-guard.cyclesPerLongBreak";
const LOCK_MESSAGE_KEY = "eye-guard.lockMessage";
const NOTIFY_KEY = "eye-guard.notifyBeforeBreak";

export const workMin = ref(25);
export const breakMin = ref(5);
export const longBreakMin = ref(15);
export const cyclesPerLongBreak = ref(4);
// 长休息开关：关闭时 cyclesPerLongBreak 以 0 持久化（后端 0 = 禁用）
export const longBreakEnabled = ref(true);
export const lockMessage = ref("");
export const notifyBeforeBreak = ref(true);

/** 分钟数：非有限/小于 1 视为非法回退默认，小数向下取整。 */
function loadMinutes(key: string, fallback: number): number {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

function loadSettings(): void {
  workMin.value = loadMinutes(WORK_KEY, 25);
  breakMin.value = loadMinutes(BREAK_KEY, 5);
  longBreakMin.value = loadMinutes(LONG_BREAK_KEY, 15);
  const cycles = localStorage.getItem(CYCLES_KEY);
  cyclesPerLongBreak.value = loadMinutes(CYCLES_KEY, 4);
  // 上次禁用长休息：开关反推为关；输入框保留默认值便于重新启用
  longBreakEnabled.value = cycles !== "0";
  lockMessage.value = localStorage.getItem(LOCK_MESSAGE_KEY) ?? "";
  notifyBeforeBreak.value = localStorage.getItem(NOTIFY_KEY) !== "false";
}

let initialized = false;

/** 挂载时调用：加载持久化设置并注册写回 watch（仅注册一次）。 */
export function initSettings(): void {
  loadSettings();
  if (initialized) return;
  initialized = true;
  watch(workMin, (v) => localStorage.setItem(WORK_KEY, String(v)));
  watch(breakMin, (v) => localStorage.setItem(BREAK_KEY, String(v)));
  watch(longBreakMin, (v) => localStorage.setItem(LONG_BREAK_KEY, String(v)));
  watch([longBreakEnabled, cyclesPerLongBreak], ([enabled, cycles]) => {
    localStorage.setItem(CYCLES_KEY, String(enabled ? cycles : 0));
  });
  watch(lockMessage, (v) => localStorage.setItem(LOCK_MESSAGE_KEY, v));
  watch(notifyBeforeBreak, (v) => localStorage.setItem(NOTIFY_KEY, String(v)));
}
