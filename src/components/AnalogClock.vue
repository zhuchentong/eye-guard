<script setup lang="ts">
// 表盘时钟样式（face）：倒计时进度式指针 + 中心 mm:ss。
// face 契约：props { value, total? } —— 只做渲染，角度/拆解逻辑复用 src/clock.ts。
// currentColor 贯穿：自动继承主面板相位色 / 暂停透明度 / 锁屏白字 / 深色模式。
import { computed, ref, watch } from "vue";
import { handAngles, needsSnap, splitClockParts } from "../clock";

const props = defineProps<{ value: number; total?: number }>();

// total 非法（idle / 缺参）→ 两针归 12 点，中心数字照常显示
const angles = computed(() => handAngles(props.value, props.total ?? Number.NaN));
const parts = computed(() => splitClockParts(props.value));
const clockText = computed(
  () => `${String(parts.value.minutes).padStart(2, "0")}:${String(parts.value.seconds).padStart(2, "0")}`,
);

// 相位边界吸附：角度回落即跨相位，该帧跳过 transition，避免指针倒转一整圈
const snap = ref(false);
watch(
  () => angles.value.progressDeg,
  (next, prev) => {
    snap.value = needsSnap(prev ?? 0, next);
  },
);

// 12 个刻度：0° = 12 点方向顺时针分布，r 88→96
const TICKS = Array.from({ length: 12 }, (_, i) => {
  const rad = (i * 30 * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = -Math.cos(rad);
  return {
    x1: 100 + 88 * sin,
    y1: 100 + 88 * cos,
    x2: 100 + 96 * sin,
    y2: 100 + 96 * cos,
  };
});

// 指针绘制为竖直向上（0°），rotate 正角 = 顺时针；transform-origin 锚定表盘中心
function needleStyle(deg: number) {
  return {
    transform: `rotate(${deg}deg)`,
    transformOrigin: "100px 100px",
    transformBox: "view-box",
  } as const;
}

// 吸附帧免过渡；其余帧每秒一次 1s 线性补间（motion-safe 尊重减少动态设置）
const SWEEP_CLASS = "motion-safe:[transition:transform_1s_linear]";
</script>

<template>
  <svg
    viewBox="0 0 200 200"
    role="img"
    :aria-label="`剩余 ${parts.minutes} 分 ${parts.seconds} 秒`"
    class="inline-block align-middle"
    style="width: 2em; height: 2em"
  >
    <!-- 表盘外圈 -->
    <circle cx="100" cy="100" r="96" fill="none" stroke="currentColor" stroke-width="3" opacity="0.9" />
    <!-- 12 刻度 -->
    <g stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity="0.4">
      <line v-for="(t, i) in TICKS" :key="i" :x1="t.x1" :y1="t.y1" :x2="t.x2" :y2="t.y2" />
    </g>
    <!-- 主针：相位进度（粗） -->
    <g :style="needleStyle(angles.progressDeg)" :class="snap ? '' : SWEEP_CLASS">
      <line x1="100" y1="100" x2="100" y2="22" stroke="currentColor" stroke-width="5" stroke-linecap="round" />
    </g>
    <!-- 秒针：细短 + 小尾巴，每秒扫 6° -->
    <g :style="needleStyle(angles.secondDeg)" :class="snap ? '' : SWEEP_CLASS">
      <line x1="100" y1="112" x2="100" y2="40" stroke="currentColor" stroke-width="2" opacity="0.7" stroke-linecap="round" />
    </g>
    <!-- 轴心 -->
    <circle cx="100" cy="100" r="4" fill="currentColor" />
    <!-- 中心数字 -->
    <text
      x="100"
      y="142"
      text-anchor="middle"
      fill="currentColor"
      font-size="26"
      font-weight="600"
      class="tabular-nums"
    >
      {{ clockText }}
    </text>
  </svg>
</template>
