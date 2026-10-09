<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { type PhaseStatus } from "../types";
import AnimatedClock from "./AnimatedClock.vue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

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

// 入场动画（tw-animate-css）：12px 淡入上浮，尊重系统"减少动态"设置
const RISE =
  "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:fill-mode-both motion-safe:duration-600";
</script>

<template>
  <div class="fixed inset-0 flex flex-col items-center justify-center gap-6 overflow-hidden bg-black text-white select-none">
    <!-- 时钟后方的呼吸光晕，营造休息氛围 -->
    <div
      aria-hidden="true"
      class="pointer-events-none absolute size-[62vmin] rounded-full bg-[radial-gradient(circle,rgba(36,155,115,0.16),transparent_65%)] blur-[12px] motion-safe:animate-breathe"
    ></div>

    <h1 :class="RISE" class="text-[2.2rem] font-medium tracking-[0.1em]">休息一下 · 远离屏幕放松眼睛</h1>

    <div :class="[RISE, 'motion-safe:[animation-delay:150ms]']">
      <!-- 脉冲放在内层，避免与入场动画的 animation 属性相互覆盖 -->
      <div :class="{ 'motion-safe:animate-pulse-soft': ending }">
        <AnimatedClock class="text-[8rem] font-semibold" :value="remaining" />
      </div>
    </div>

    <p
      v-if="lockMessage"
      :class="[RISE, 'motion-safe:[animation-delay:300ms]']"
      class="m-0 text-[1.4rem] text-neutral-300"
    >
      {{ lockMessage }}
    </p>
    <p :class="[RISE, 'motion-safe:[animation-delay:300ms]']" class="m-0 text-neutral-400">
      倒计时结束后将自动开始下一轮工作
    </p>

    <Button
      variant="outline"
      :class="[RISE, 'motion-safe:[animation-delay:450ms]']"
      class="mt-8 border-neutral-700 bg-transparent text-neutral-400 hover:border-neutral-500 hover:bg-transparent hover:text-neutral-300 dark:bg-transparent dark:text-neutral-400 dark:border-neutral-700 dark:hover:bg-neutral-900 dark:hover:text-neutral-300"
      @click="skip"
    >
      跳过休息
    </Button>

    <Alert v-if="error" variant="destructive" class="w-auto border-destructive/40 bg-black/60">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>
  </div>
</template>
