<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { type PhaseStatus } from "../types";
import AnimatedClock from "./AnimatedClock.vue";

const WORK_KEY = "eye-guard.workMin";
const BREAK_KEY = "eye-guard.breakMin";
const LONG_BREAK_KEY = "eye-guard.longBreakMin";
const CYCLES_KEY = "eye-guard.cyclesPerLongBreak";
const STATS_KEY = "eye-guard.todayStats";

const phase = ref<PhaseStatus["phase"]>("idle");
const remaining = ref(0);
const cycle = ref(0);
const longBreak = ref(false);
const paused = ref(false);
const workMin = ref(25);
const breakMin = ref(5);
const longBreakMin = ref(15);
const cyclesPerLongBreak = ref(4);
// 长休息开关：关闭时 cyclesPerLongBreak 以 0 持久化（后端 0 = 禁用）
const longBreakEnabled = ref(true);
const error = ref("");

const running = computed(() => phase.value !== "idle");

let unlisteners: UnlistenFn[] = [];

interface TodayStats {
  date: string;
  count: number;
}

const todayStats = ref<TodayStats>({ date: "", count: 0 });

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function loadTodayStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as TodayStats;
      if (typeof parsed.date === "string" && typeof parsed.count === "number") {
        todayStats.value = { date: parsed.date, count: parsed.count };
      }
    }
  } catch {
    // 数据损坏时按今日 0 轮处理
  }
  if (todayStats.value.date !== todayStr()) {
    todayStats.value = { date: todayStr(), count: 0 };
  }
}

// 休息结束回到工作 = 完成一个番茄钟；跨日自动清零
function recordCompletedCycle() {
  const date = todayStr();
  const count = todayStats.value.date === date ? todayStats.value.count + 1 : 1;
  todayStats.value = { date, count };
  localStorage.setItem(STATS_KEY, JSON.stringify(todayStats.value));
}

function apply(s: PhaseStatus) {
  if (phase.value === "break" && s.phase === "work" && s.cycle > 0) {
    recordCompletedCycle();
  }
  phase.value = s.phase;
  remaining.value = s.remaining_secs;
  cycle.value = s.cycle;
  longBreak.value = s.long_break;
  paused.value = s.paused;
}

onMounted(async () => {
  const savedWork = Number(localStorage.getItem(WORK_KEY));
  const savedBreak = Number(localStorage.getItem(BREAK_KEY));
  const savedLongBreak = Number(localStorage.getItem(LONG_BREAK_KEY));
  const savedCycles = Number(localStorage.getItem(CYCLES_KEY));
  if (Number.isFinite(savedWork) && savedWork >= 1) workMin.value = Math.floor(savedWork);
  if (Number.isFinite(savedBreak) && savedBreak >= 1) breakMin.value = Math.floor(savedBreak);
  if (Number.isFinite(savedLongBreak) && savedLongBreak >= 1) longBreakMin.value = Math.floor(savedLongBreak);
  if (Number.isFinite(savedCycles) && savedCycles >= 1) cyclesPerLongBreak.value = Math.floor(savedCycles);
  else if (localStorage.getItem(CYCLES_KEY) === "0") longBreakEnabled.value = false; // 上次禁用；输入框保留默认值便于重新启用
  loadTodayStats();

  unlisteners.push(
    await listen<PhaseStatus>("timer-tick", (e) => apply(e.payload)),
    await listen<PhaseStatus>("phase-changed", (e) => apply(e.payload)),
  );
  try {
    apply(await invoke<PhaseStatus>("get_status"));
  } catch {
    // 后端不可用时保持本地默认值
  }
});

onUnmounted(() => {
  for (const unlisten of unlisteners) unlisten();
  unlisteners = [];
});

watch(workMin, (v) => localStorage.setItem(WORK_KEY, String(v)));
watch(breakMin, (v) => localStorage.setItem(BREAK_KEY, String(v)));
watch(longBreakMin, (v) => localStorage.setItem(LONG_BREAK_KEY, String(v)));
watch([longBreakEnabled, cyclesPerLongBreak], ([enabled, cycles]) => {
  localStorage.setItem(CYCLES_KEY, String(enabled ? cycles : 0));
});

async function start() {
  error.value = "";
  if (!(workMin.value >= 1) || !(breakMin.value >= 1)) {
    error.value = "工作与休息时长必须 ≥ 1 分钟";
    return;
  }
  if (longBreakEnabled.value && (!(cyclesPerLongBreak.value >= 1) || !(longBreakMin.value >= 1))) {
    error.value = "长休息周期与时长必须 ≥ 1";
    return;
  }
  try {
    await invoke("start_pomodoro", {
      workSecs: Math.floor(workMin.value) * 60,
      breakSecs: Math.floor(breakMin.value) * 60,
      longBreakSecs: Math.floor(longBreakMin.value) * 60,
      cyclesPerLongBreak: longBreakEnabled.value ? Math.floor(cyclesPerLongBreak.value) : 0,
    });
    phase.value = "work";
    remaining.value = Math.floor(workMin.value) * 60;
    cycle.value = 1;
    longBreak.value = false;
    paused.value = false;
  } catch (e) {
    error.value = String(e);
  }
}

async function stop() {
  error.value = "";
  try {
    await invoke("stop_pomodoro");
    phase.value = "idle";
    remaining.value = 0;
    cycle.value = 0;
    longBreak.value = false;
    paused.value = false;
  } catch (e) {
    error.value = String(e);
  }
}

// 立即休息：与托盘「立即休息」共用后端入口，空闲/工作中均可触发
async function startNow() {
  error.value = "";
  try {
    await invoke("start_break_now");
    phase.value = "break";
    paused.value = false;
  } catch (e) {
    error.value = String(e);
  }
}

// 暂停/继续：乐观更新本地状态，phase-changed/timer-tick 事件随后校正
async function togglePause() {
  error.value = "";
  const next = !paused.value;
  try {
    await invoke(next ? "pause_pomodoro" : "resume_pomodoro");
    paused.value = next;
  } catch (e) {
    error.value = String(e);
  }
}
</script>

<template>
  <main class="container">
    <h1>eye-guard</h1>
    <div class="clock" :class="[phase, { paused }]">
      <AnimatedClock :value="remaining" />
    </div>
    <p class="meta">
      <span v-if="phase === 'work'">工作</span>
      <span v-else-if="phase === 'break'">{{ longBreak ? "长休息" : "休息" }}</span>
      <span v-else>已停止</span>
      <span v-if="running"> · 第 {{ cycle }} 轮</span>
      <span v-if="paused"> · 已暂停</span>
      <span v-if="todayStats.count > 0"> · 今日 {{ todayStats.count }} 轮</span>
    </p>
    <div class="row">
      <label>
        工作 <input v-model.number="workMin" type="number" min="1" :disabled="running" /> 分钟
      </label>
      <label>
        休息 <input v-model.number="breakMin" type="number" min="1" :disabled="running" /> 分钟
      </label>
    </div>
    <div class="row">
      <label>
        <input v-model="longBreakEnabled" type="checkbox" :disabled="running" /> 长休息
      </label>
      <label>
        每 <input v-model.number="cyclesPerLongBreak" type="number" min="1" :disabled="running || !longBreakEnabled" /> 轮
      </label>
      <label>
        时长 <input v-model.number="longBreakMin" type="number" min="1" :disabled="running || !longBreakEnabled" /> 分钟
      </label>
    </div>
    <div class="row">
      <button :disabled="running" @click="start">开始</button>
      <button :disabled="!running" @click="stop">停止</button>
      <button :disabled="phase !== 'work'" @click="togglePause">{{ paused ? "继续" : "暂停" }}</button>
      <button :disabled="phase === 'break'" @click="startNow">立即执行</button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
  </main>
</template>

<style scoped>
.clock {
  font-size: 4rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin: 0.5rem 0;
  transition: color 0.6s ease;
}

.clock.work {
  color: #396cd8;
}

.clock.break {
  color: #249b73;
}

.clock.paused {
  opacity: 0.45;
}

.meta {
  margin: 0 0 1.5rem;
  color: #888;
}

.row {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1rem;
}

.row + .row {
  justify-content: center;
}

label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

input {
  width: 4.5em;
  text-align: center;
}

input[type="checkbox"] {
  width: auto;
  padding: 0.1em;
  border: none;
  box-shadow: none;
  accent-color: #249b73;
}

.error {
  color: #e5484d;
  margin-top: 1rem;
}

/* 入场：标题 → 时钟 → 状态 → 表单 依次淡入上浮（尊重“减少动态”） */
@media (prefers-reduced-motion: no-preference) {
  .container > * {
    animation: panel-rise 0.6s ease-out both;
  }

  .container > h1 {
    animation-delay: 0s;
  }

  .container > .clock {
    animation-delay: 0.12s;
  }

  .container > .meta {
    animation-delay: 0.24s;
  }

  .container > .row {
    animation-delay: 0.36s;
  }
}

@keyframes panel-rise {
  from {
    opacity: 0;
    transform: translateY(12px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}
</style>
