<script setup lang="ts">
// 设置页：主窗口内视图切换（TimerPanel 齿轮进入，返回按钮退出）。
// 计时/通知/自启/锁屏/数据/关于 六个分区；计时与更新逻辑自 TimerPanel 迁入，
// 状态经 src/settings.ts 模块单例共享。
// 布局：两栏网格（800×600 内零滚动），窗口拖窄自动回落单列。
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { formatProgress } from "../update-progress";
import { clearAllStats } from "../stats";
import {
  breakMin,
  cyclesPerLongBreak,
  lockMessage,
  longBreakEnabled,
  longBreakMin,
  notifyBeforeBreak,
  workMin,
} from "../settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

const props = defineProps<{ running: boolean }>();
const emit = defineEmits<{ back: []; statsCleared: [] }>();

const settingsError = ref("");

// —— 开机自启（Rust command + 托盘勾选双向同步）——
const autostart = ref(false);

async function toggleAutostart(next: boolean) {
  settingsError.value = "";
  const prev = autostart.value;
  autostart.value = next; // 乐观更新；后端事件/失败回滚校正
  try {
    await invoke("set_autostart", { enabled: next });
  } catch (e) {
    autostart.value = prev;
    settingsError.value = `开机自启设置失败：${e}`;
  }
}

// —— 休息预告通知：改动即时同步后端（worker 逐 tick 读取共享标志）——
watch(notifyBeforeBreak, (enabled) => {
  invoke("set_notify_before_break", { enabled }).catch((e) => {
    settingsError.value = `通知设置失败：${e}`;
  });
});

// —— 清除统计：两步内联确认，避免误触 ——
const confirmingClear = ref(false);

function onClearStats() {
  settingsError.value = "";
  if (!confirmingClear.value) {
    confirmingClear.value = true;
    return;
  }
  clearAllStats(); // 含 legacy 键：清除后不复活
  emit("statsCleared");
  confirmingClear.value = false;
}

// —— 版本显示与应用内更新（自 TimerPanel 迁入，逻辑不变）——
// dev（未打包）运行环境没有可安装的产物：检查更新直接降级为打开 Releases 页
const RELEASES_PAGE_URL = "https://github.com/zhuchentong/eye-guard/releases/latest";
const appVersion = ref("");
const latestTag = ref("");
const updateState = ref<
  "idle" | "checking" | "latest" | "newer" | "downloading" | "installing" | "error"
>("idle");
const updateProgress = ref(""); // 下载进度展示文本（百分比 / 已下载字节）
const updateError = ref("检查失败");
let pendingUpdate: Update | null = null;

const updateButtonLabel = computed(
  () =>
    ({
      idle: "检查更新",
      checking: "检查中…",
      latest: "检查更新",
      newer: "立即更新",
      downloading: `下载中 ${updateProgress.value}`,
      installing: "安装中…",
      error: "检查更新",
    })[updateState.value],
);

async function checkUpdate() {
  if (
    updateState.value === "checking" ||
    updateState.value === "downloading" ||
    updateState.value === "installing"
  ) {
    return;
  }
  if (import.meta.env.DEV) {
    openReleasePage(); // 未打包环境无 updater 产物可装，降级为浏览器下载
    return;
  }
  updateState.value = "checking";
  updateError.value = "检查失败";
  try {
    const prev = pendingUpdate;
    pendingUpdate = await check();
    // Update 持有 Rust 侧资源，替换前回收旧引用（托盘长驻进程不留泄漏）
    if (prev && prev !== pendingUpdate) void prev.close();
    if (pendingUpdate) {
      latestTag.value = `v${pendingUpdate.version}`;
      updateState.value = "newer";
    } else {
      updateState.value = "latest";
    }
  } catch (e) {
    updateError.value = `检查失败：${e}`;
    updateState.value = "error";
  }
}

// 下载 + 安装 + 自动重启；任一步失败给出错误与手动下载兜底
async function installUpdate() {
  if (
    !pendingUpdate ||
    updateState.value === "downloading" ||
    updateState.value === "installing"
  ) {
    return;
  }
  updateState.value = "downloading";
  updateProgress.value = "";
  try {
    let received = 0;
    let total: number | null = null;
    await pendingUpdate.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? null;
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
        updateProgress.value = formatProgress(received, total);
      } else if (event.event === "Finished") {
        updateState.value = "installing";
      }
    });
    await relaunch(); // Linux：安装完成后必须重启才会运行新版本
  } catch (e) {
    updateError.value = `更新失败：${e}`;
    updateState.value = "error";
  }
}

function openReleasePage() {
  void openUrl(RELEASES_PAGE_URL);
}

let unlisteners: UnlistenFn[] = [];

onMounted(async () => {
  try {
    appVersion.value = await getVersion();
  } catch {
    // 取不到时界面显示未知，检查更新会提示失败
  }
  try {
    autostart.value = await invoke<boolean>("get_autostart");
  } catch {
    // 后端不可用时保持关闭态，切换时会给出错误
  }
  // 托盘菜单勾选切换时同步本页开关
  unlisteners.push(
    await listen<boolean>("autostart-changed", (e) => {
      autostart.value = e.payload;
    }),
  );
});

onUnmounted(() => {
  for (const unlisten of unlisteners) unlisten();
  unlisteners = [];
});
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <header
      class="flex items-center gap-2 px-6 pt-5 motion-safe:animate-in motion-safe:fade-in motion-safe:fill-mode-both"
    >
      <Button variant="ghost" size="icon" aria-label="返回计时" @click="emit('back')">
        <svg
          aria-hidden="true"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="size-4"
        >
          <path d="m12 19-7-7 7-7" />
          <path d="M19 12H5" />
        </svg>
      </Button>
      <h1 class="text-lg font-semibold">设置</h1>
    </header>

    <div
      class="grid flex-1 content-start grid-cols-1 gap-3 overflow-y-auto px-6 pt-4 pb-6 text-left md:grid-cols-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:fill-mode-both motion-safe:duration-600"
    >
      <!-- 计时 -->
      <section class="rounded-lg border bg-card p-4 md:col-span-2">
        <h2 class="mb-3 text-sm font-medium text-muted-foreground">计时</h2>
        <div class="flex flex-wrap items-center gap-4">
          <Label class="gap-1.5">
            工作
            <Input
              v-model.number="workMin"
              name="workMin"
              type="number"
              min="1"
              autocomplete="off"
              :disabled="props.running"
              class="w-20 text-center"
            />
            分钟
          </Label>
          <Label class="gap-1.5">
            休息
            <Input
              v-model.number="breakMin"
              name="breakMin"
              type="number"
              min="1"
              autocomplete="off"
              :disabled="props.running"
              class="w-20 text-center"
            />
            分钟
          </Label>
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-4">
          <Label for="long-break-enabled" class="gap-1.5">
            <Switch id="long-break-enabled" v-model="longBreakEnabled" :disabled="props.running" />
            长休息
          </Label>
          <Label class="gap-1.5">
            每
            <Input
              v-model.number="cyclesPerLongBreak"
              name="cyclesPerLongBreak"
              type="number"
              min="1"
              autocomplete="off"
              :disabled="props.running || !longBreakEnabled"
              class="w-16 text-center"
            />
            轮
          </Label>
          <Label class="gap-1.5">
            时长
            <Input
              v-model.number="longBreakMin"
              name="longBreakMin"
              type="number"
              min="1"
              autocomplete="off"
              :disabled="props.running || !longBreakEnabled"
              class="w-16 text-center"
            />
            分钟
          </Label>
        </div>
        <p v-if="props.running" class="mt-2 text-xs text-muted-foreground">
          计时进行中，时长暂不可修改
        </p>
      </section>

      <!-- 通知 / 通用：同构开关行（左标题+描述，右控件） -->
      <section class="rounded-lg border bg-card p-4">
        <h2 class="mb-3 text-sm font-medium text-muted-foreground">通知</h2>
        <div class="flex items-center justify-between gap-4">
          <Label for="notify-before-break" class="min-w-0 flex-col items-start gap-0.5">
            <span>休息预告</span>
            <span class="text-xs font-normal text-muted-foreground">休息结束前 30 秒发送系统通知</span>
          </Label>
          <Switch id="notify-before-break" v-model="notifyBeforeBreak" class="shrink-0" />
        </div>
      </section>

      <section class="rounded-lg border bg-card p-4">
        <h2 class="mb-3 text-sm font-medium text-muted-foreground">通用</h2>
        <div class="flex items-center justify-between gap-4">
          <Label for="autostart" class="min-w-0 flex-col items-start gap-0.5">
            <span>开机自启</span>
            <span class="text-xs font-normal text-muted-foreground">登录后自动启动，与托盘菜单同步</span>
          </Label>
          <Switch
            id="autostart"
            :model-value="autostart"
            class="shrink-0"
            @update:model-value="toggleAutostart"
          />
        </div>
      </section>

      <!-- 锁屏文案 / 数据 -->
      <section class="rounded-lg border bg-card p-4">
        <h2 class="mb-3 text-sm font-medium text-muted-foreground">锁屏文案</h2>
        <div class="flex items-center gap-2">
          <Input
            v-model="lockMessage"
            name="lockMessage"
            type="text"
            autocomplete="off"
            aria-label="锁屏文案"
            placeholder="如：远眺 20 秒…"
            class="min-w-0 flex-1"
          />
          <Button
            v-if="lockMessage"
            variant="ghost"
            size="sm"
            class="h-8 shrink-0 px-2 text-xs"
            @click="lockMessage = ''"
          >
            恢复默认
          </Button>
        </div>
        <p class="mt-2 text-xs text-muted-foreground">留空显示默认提示；下次休息时生效</p>
      </section>

      <section class="rounded-lg border bg-card p-4">
        <h2 class="mb-3 text-sm font-medium text-muted-foreground">数据</h2>
        <div class="flex items-center justify-between gap-4">
          <div class="min-w-0">
            <p class="text-sm">完成轮数统计</p>
            <p class="text-xs text-muted-foreground">清除热力图与今日轮数，不可恢复</p>
          </div>
          <Button
            :variant="confirmingClear ? 'destructive' : 'outline'"
            size="sm"
            class="shrink-0"
            @click="onClearStats"
          >
            {{ confirmingClear ? "确认清除？" : "清除统计" }}
          </Button>
        </div>
      </section>

      <!-- 关于 -->
      <section class="rounded-lg border bg-card p-4 md:col-span-2">
        <h2 class="mb-3 text-sm font-medium text-muted-foreground">关于</h2>
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="tabular-nums">eye-guard v{{ appVersion || "?" }}</span>
          <Button
            variant="outline"
            size="sm"
            class="h-7 px-2 text-xs"
            :disabled="
              updateState === 'checking' || updateState === 'downloading' || updateState === 'installing'
            "
            @click="updateState === 'newer' ? installUpdate() : checkUpdate()"
          >
            {{ updateButtonLabel }}
          </Button>
          <span v-if="updateState === 'latest'" class="text-xs text-muted-foreground">已是最新版本</span>
          <template v-else-if="updateState === 'newer'">
            <span class="text-xs text-muted-foreground">发现新版本 {{ latestTag }}</span>
            <Button variant="link" size="sm" class="h-6 px-1 text-xs" @click="openReleasePage">
              手动下载
            </Button>
          </template>
        </div>
        <!-- 异步更新状态：读屏软件播报进度变化 -->
        <div aria-live="polite">
          <p
            v-if="updateState === 'downloading' || updateState === 'installing'"
            class="mt-2 text-xs text-muted-foreground"
          >
            {{ updateState === "installing" ? "安装中，完成后将自动重启…" : `下载中 ${updateProgress}` }}
          </p>
          <p
            v-else-if="updateState === 'error'"
            class="mt-2 max-w-xl text-xs break-words text-destructive"
          >
            {{ updateError }}
          </p>
        </div>
      </section>

      <Alert v-if="settingsError" variant="destructive" class="md:col-span-2">
        <AlertDescription class="break-words">{{ settingsError }}</AlertDescription>
      </Alert>
    </div>
  </div>
</template>
