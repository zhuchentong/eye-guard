<script setup lang="ts">
// 时钟样式分发器：按 styleId 渲染对应 face（见 clock-styles.ts 注册表）。
// 纯编排组件：不感知设置/时间来源——styleId 由调用方显式传入
// （主面板 panelClockStyle、锁屏 lockClockStyle 分别配置），
// total 为当前相位总秒数（可选，表盘进度映射用，idle 时缺省归零）。
import { computed } from "vue";
import { DEFAULT_CLOCK_STYLE, type ClockStyleId } from "../clock";
import { CLOCK_STYLES } from "../clock-styles";

const props = defineProps<{ value: number; total?: number; styleId?: ClockStyleId }>();

const face = computed(() => CLOCK_STYLES[props.styleId ?? DEFAULT_CLOCK_STYLE]);
</script>

<template>
  <component :is="face.component" :value="value" :total="total" />
</template>
