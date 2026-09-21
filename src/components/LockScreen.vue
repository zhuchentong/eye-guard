<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { type PhaseStatus } from "../types";
import AnimatedClock from "./AnimatedClock.vue";

const remaining = ref(0);
const error = ref("");
// 自定义锁屏文案的接入点：设置该 localStorage 键即可覆盖默认提示
const lockMessage = ref(localStorage.getItem("eye-guard.lockMessage") ?? "");
// 休息即将结束的提示脉冲（避开初始 remaining=0）
const ending = computed(() => remaining.value > 0 && remaining.value <= 3);

let unlisten: UnlistenFn | undefined;

async function skip() {
  error.value = "";
  try {
    await invoke("end_break_early");
  } catch (e) {
    error.value = String(e);
  }
}

onMounted(async () => {
  unlisten = await listen<PhaseStatus>("timer-tick", (e) => {
    remaining.value = e.payload.remaining_secs;
  });
  try {
    const s = await invoke<PhaseStatus>("get_status");
    remaining.value = s.remaining_secs;
  } catch {
    // 等 timer-tick 事件兜底
  }
});

onUnmounted(() => unlisten?.());
</script>

<template>
  <div class="lock">
    <div class="glow" aria-hidden="true"></div>
    <h1>休息一下 · 远离屏幕放松眼睛</h1>
    <div class="clock-wrap" :class="{ ending }">
      <AnimatedClock :value="remaining" class="clock" />
    </div>
    <p v-if="lockMessage" class="message">{{ lockMessage }}</p>
    <p class="hint">倒计时结束后将自动开始下一轮工作</p>
    <button class="skip" @click="skip">跳过休息</button>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.lock {
  position: fixed;
  inset: 0;
  background: #000;
  color: #fff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  user-select: none;
  overflow: hidden;
}

/* 时钟后方的呼吸光晕，营造休息氛围 */
.glow {
  position: absolute;
  width: 62vmin;
  height: 62vmin;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(36, 155, 115, 0.16), transparent 65%);
  filter: blur(12px);
  pointer-events: none;
}

h1 {
  margin: 0;
  font-size: 2.2rem;
  font-weight: 500;
  letter-spacing: 0.1em;
}

.clock {
  font-size: 8rem;
  font-weight: 600;
}

.message {
  font-size: 1.4rem;
  color: #ddd;
  margin: 0;
}

.hint {
  color: #9a9a9a;
  margin: 0;
}

.skip {
  margin-top: 2rem;
  background: transparent;
  color: #777;
  border-color: #444;
  box-shadow: none;
}

.skip:hover {
  border-color: #777;
}

.error {
  color: #e5484d;
  margin: 0;
}

/* —— 动效（平静舒缓；尊重系统“减少动态”设置）—— */
@media (prefers-reduced-motion: no-preference) {
  /* 入场：标题 → 时钟 → 提示 → 按钮 依次淡入上浮 */
  .lock > * {
    animation: lock-rise 0.6s ease-out both;
  }

  .lock > h1 {
    animation-delay: 0s;
  }

  .lock > .clock-wrap {
    animation-delay: 0.15s;
  }

  .lock > .message,
  .lock > .hint {
    animation-delay: 0.3s;
  }

  .lock > .skip {
    animation-delay: 0.45s;
  }

  .glow {
    animation: lock-breathe 8s ease-in-out infinite alternate;
  }

  /* 剩余 ≤3s：轻微呼吸脉冲提示休息即将结束 */
  .ending {
    animation: lock-pulse 1s ease-in-out infinite;
  }
}

@keyframes lock-rise {
  from {
    opacity: 0;
    transform: translateY(12px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes lock-breathe {
  from {
    opacity: 0.35;
    transform: scale(1);
  }

  to {
    opacity: 0.9;
    transform: scale(1.08);
  }
}

@keyframes lock-pulse {
  50% {
    transform: scale(1.02);
    opacity: 0.85;
  }
}
</style>
