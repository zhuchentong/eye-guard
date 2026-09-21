<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { type PhaseStatus } from "../types";
import AnimatedClock from "./AnimatedClock.vue";

const WORK_KEY = "eye-guard.workMin";
const BREAK_KEY = "eye-guard.breakMin";

const phase = ref<PhaseStatus["phase"]>("idle");
const remaining = ref(0);
const cycle = ref(0);
const workMin = ref(25);
const breakMin = ref(5);
const error = ref("");

const running = computed(() => phase.value !== "idle");

let unlisteners: UnlistenFn[] = [];

function apply(s: PhaseStatus) {
  phase.value = s.phase;
  remaining.value = s.remaining_secs;
  cycle.value = s.cycle;
}

onMounted(async () => {
  const savedWork = Number(localStorage.getItem(WORK_KEY));
  const savedBreak = Number(localStorage.getItem(BREAK_KEY));
  if (Number.isFinite(savedWork) && savedWork >= 1) workMin.value = Math.floor(savedWork);
  if (Number.isFinite(savedBreak) && savedBreak >= 1) breakMin.value = Math.floor(savedBreak);

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

async function start() {
  error.value = "";
  if (!(workMin.value >= 1) || !(breakMin.value >= 1)) {
    error.value = "工作与休息时长必须 ≥ 1 分钟";
    return;
  }
  try {
    await invoke("start_pomodoro", {
      workSecs: Math.floor(workMin.value) * 60,
      breakSecs: Math.floor(breakMin.value) * 60,
    });
    phase.value = "work";
    remaining.value = Math.floor(workMin.value) * 60;
    cycle.value = 1;
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
  } catch (e) {
    error.value = String(e);
  }
}
</script>

<template>
  <main class="container">
    <h1>eye-guard</h1>
    <div class="clock" :class="phase">
      <AnimatedClock :value="remaining" />
    </div>
    <p class="meta">
      <span v-if="phase === 'work'">工作</span>
      <span v-else-if="phase === 'break'">休息</span>
      <span v-else>已停止</span>
      <span v-if="running"> · 第 {{ cycle }} 轮</span>
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
      <button :disabled="running" @click="start">开始</button>
      <button :disabled="!running" @click="stop">停止</button>
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
