<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { type PhaseStatus } from "../types";
import {
  DISPLAY_DAYS,
  lastNDays,
  loadStats,
  recordCompletedCycle,
  saveStats,
  todayCount,
  todayStr,
  type DayStat,
} from "../stats";
import AnimatedClock from "./AnimatedClock.vue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const WORK_KEY = "eye-guard.workMin";
const BREAK_KEY = "eye-guard.breakMin";
const LONG_BREAK_KEY = "eye-guard.longBreakMin";
const CYCLES_KEY = "eye-guard.cyclesPerLongBreak";

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

const stats = ref<DayStat[]>([]);
const today = computed(() => todayCount(stats.value));

// —— 近 26 周（半年）贡献热力图：列 = 周，行 = 周一..周日（存储窗口仍保留 53 周）——
type HeatCell = { key: string; date: string | null; count: number };

const heatmapDays = computed(() => lastNDays(stats.value, DISPLAY_DAYS));

const heatMax = computed(() => Math.max(1, ...heatmapDays.value.map((d) => d.count)));

// 首列按起始日星期几补空位，使行对齐周一..周日；53-54 列
const heatmapColumns = computed<HeatCell[][]>(() => {
  const first = new Date(`${heatmapDays.value[0].date}T00:00:00`);
  const offset = (first.getDay() + 6) % 7; // 周一 = 0
  const columns: HeatCell[][] = [];
  let col: HeatCell[] = [];
  for (let i = 0; i < offset; i++) col.push({ key: `pad-${i}`, date: null, count: 0 });
  for (const d of heatmapDays.value) {
    col.push({ key: d.date, date: d.date, count: d.count });
    if (col.length === 7) {
      columns.push(col);
      col = [];
    }
  }
  if (col.length > 0) columns.push(col);
  return columns;
});

// 5 档色阶：0 = 空，其余按占比归一化（max 下限 1 防除零）
function heatLevel(count: number): number {
  return count === 0 ? 0 : Math.min(4, Math.ceil((count / heatMax.value) * 4));
}

// GitHub 五档色阶 → tailwind 类（静态字面量，供 v4 内容检测拾取；亮/暗各一套）
const LEVEL_CLASSES = [
  "bg-[#ebedf0] dark:bg-[#161b22]", // 0：空档
  "bg-[#9be9a8] dark:bg-[#0e4429]",
  "bg-[#40c463] dark:bg-[#006d32]",
  "bg-[#30a14e] dark:bg-[#26a641]",
  "bg-[#216e39] dark:bg-[#39d353]",
];

// 今日格描边：用工作蓝色与绿色色阶区分
const TODAY_OUTLINE = "outline-2 outline-[#396cd8] outline-offset-1";

function cellClass(cell: HeatCell): string {
  const base = LEVEL_CLASSES[cell.date === null ? 0 : heatLevel(cell.count)];
  return cell.date === todayStr() ? `${base} ${TODAY_OUTLINE}` : base;
}

// 左侧行标签：仅标周一/周三/周五（GitHub 风格），行序 = 周一..周日
const WDAY_LABELS = ["一", "", "三", "", "五", "", ""];

// 顶部月份标签：当列首个真实日期的月份与前一列不同时标注（GitHub 风格）
function monthLabel(ci: number): string {
  const first = heatmapColumns.value[ci]?.find((c) => c.date !== null);
  if (!first?.date) return "";
  const month = Number(first.date.slice(5, 7));
  const prevFirst = heatmapColumns.value[ci - 1]?.find((c) => c.date !== null);
  if (prevFirst?.date && Number(prevFirst.date.slice(5, 7)) === month) return "";
  return `${month}月`;
}

// 相位 → 时钟颜色（静态字面量；工作蓝 / 休息绿 / 空闲前景色）
const CLOCK_COLOR: Record<PhaseStatus["phase"], string> = {
  idle: "text-foreground",
  work: "text-[#396cd8]",
  break: "text-[#249b73]",
};

// 入场动画（tw-animate-css）：12px 淡入上浮，尊重系统"减少动态"设置
const RISE =
  "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:fill-mode-both motion-safe:duration-600";

// 休息结束回到工作 = 完成一个番茄钟（stats.ts 30 天滚动窗口持久化）
function completeCycle() {
  stats.value = recordCompletedCycle(stats.value);
  saveStats(stats.value);
}

function apply(s: PhaseStatus) {
  if (phase.value === "break" && s.phase === "work" && s.cycle > 0) {
    completeCycle();
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
  stats.value = loadStats();

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
  <main class="flex min-h-screen flex-col text-center">
    <header class="flex items-baseline justify-between px-8 pt-5" :class="RISE">
      <h1 class="text-xl font-semibold">eye-guard</h1>
      <span class="text-sm text-muted-foreground">今日 {{ today }} 轮</span>
    </header>

    <section class="flex flex-1 flex-col items-center justify-center" :class="[RISE, 'motion-safe:[animation-delay:120ms]']">
      <div
        class="text-[5.5rem] leading-[1.15] font-semibold tabular-nums transition-colors duration-600"
        :class="[CLOCK_COLOR[phase], { 'opacity-45': paused }]"
      >
        <AnimatedClock :value="remaining" />
      </div>
      <p class="mb-6 text-muted-foreground">
        <span v-if="phase === 'work'">工作</span>
        <span v-else-if="phase === 'break'">{{ longBreak ? "长休息" : "休息" }}</span>
        <span v-else>已停止</span>
        <span v-if="running"> · 第 {{ cycle }} 轮</span>
        <span v-if="paused"> · 已暂停</span>
      </p>

      <!-- 近 26 周热力图（GitHub 风格）：2×2 网格 = 角空 / 月份行 / 星期列 / 格子区 -->
      <TooltipProvider :delay-duration="100">
        <div class="flex max-w-full flex-col items-center gap-[0.4rem] overflow-x-auto">
          <div class="grid grid-cols-[auto_auto] pr-[14px]">
            <div aria-hidden="true" class="col-start-1 row-start-1"></div>
            <div
              aria-hidden="true"
              class="col-start-2 row-start-1 flex h-4 items-end gap-[3px] text-[0.65rem] text-muted-foreground"
            >
              <span v-for="(_, ci) in heatmapColumns" :key="ci" class="w-3.5 shrink-0 text-left whitespace-nowrap">{{
                monthLabel(ci)
              }}</span>
            </div>
            <div
              aria-hidden="true"
              class="col-start-1 row-start-2 flex flex-col gap-[3px] pr-1 text-[0.65rem] text-muted-foreground"
            >
              <span v-for="(w, wi) in WDAY_LABELS" :key="wi" class="h-3.5 leading-[14px]">{{ w }}</span>
            </div>
            <div class="col-start-2 row-start-2 flex gap-[3px]">
              <div v-for="(col, ci) in heatmapColumns" :key="ci" class="flex flex-col gap-[3px]">
                <template v-for="cell in col" :key="cell.key">
                  <!-- 补零空位格无数据，不给 tooltip -->
                  <span v-if="cell.date === null" class="size-3.5 rounded-[3px]" :class="LEVEL_CLASSES[0]"></span>
                  <Tooltip v-else>
                    <TooltipTrigger as-child>
                      <span
                        class="size-3.5 rounded-[3px] hover:ring-2 hover:ring-foreground/25"
                        :class="cellClass(cell)"
                      ></span>
                    </TooltipTrigger>
                    <TooltipContent class="flex items-center gap-1.5 px-2 py-1">
                      <i class="size-2 rounded-full" :class="LEVEL_CLASSES[heatLevel(cell.count)]"></i>
                      {{ cell.date }}：{{ cell.count }} 轮
                    </TooltipContent>
                  </Tooltip>
                </template>
              </div>
            </div>
          </div>
          <div class="flex items-center justify-end gap-[3px] self-end text-[0.7rem] text-muted-foreground">
            <span>少</span>
            <i v-for="lv in 5" :key="lv" class="size-3.5 rounded-[3px]" :class="LEVEL_CLASSES[lv - 1]"></i>
            <span>多</span>
          </div>
        </div>
      </TooltipProvider>
    </section>

    <section class="border-t border-border bg-muted/40 px-8 pt-4 pb-5" :class="[RISE, 'motion-safe:[animation-delay:240ms]']">
      <div class="flex items-center justify-center gap-4">
        <Label class="gap-1.5">
          工作
          <Input v-model.number="workMin" type="number" min="1" :disabled="running" class="w-20 text-center" />
          分钟
        </Label>
        <Label class="gap-1.5">
          休息
          <Input v-model.number="breakMin" type="number" min="1" :disabled="running" class="w-20 text-center" />
          分钟
        </Label>
      </div>
      <div class="mt-2 flex items-center justify-center gap-4">
        <Label for="long-break-enabled" class="gap-1.5">
          <Switch id="long-break-enabled" v-model="longBreakEnabled" :disabled="running" />
          长休息
        </Label>
        <Label class="gap-1.5">
          每
          <Input
            v-model.number="cyclesPerLongBreak"
            type="number"
            min="1"
            :disabled="running || !longBreakEnabled"
            class="w-16 text-center"
          />
          轮
        </Label>
        <Label class="gap-1.5">
          时长
          <Input
            v-model.number="longBreakMin"
            type="number"
            min="1"
            :disabled="running || !longBreakEnabled"
            class="w-16 text-center"
          />
          分钟
        </Label>
      </div>
      <div class="mt-4 flex items-center justify-center gap-3">
        <Button size="lg" :disabled="running" @click="start">开始</Button>
        <Button variant="outline" :disabled="!running" @click="stop">停止</Button>
        <Button variant="outline" :disabled="phase !== 'work'" @click="togglePause">
          {{ paused ? "继续" : "暂停" }}
        </Button>
        <Button variant="outline" :disabled="phase === 'break'" @click="startNow">立即执行</Button>
      </div>
      <Alert v-if="error" variant="destructive" class="mx-auto mt-3 max-w-xl">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>
    </section>
  </main>
</template>
