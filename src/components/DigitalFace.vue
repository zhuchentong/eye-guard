<script setup lang="ts">
// 数字时钟样式（face）：NumberFlow 滚动数字 mm:ss。
// face 契约：props { value, total? } —— 只做渲染，逻辑复用 src/clock.ts。
import { computed } from "vue";
import NumberFlow from "@number-flow/vue";
import { splitClockParts } from "../clock";

const props = defineProps<{ value: number; total?: number }>();

// 与 Intl.NumberFormat 对齐：两位整数、无千分位
const DIGIT_FORMAT = { minimumIntegerDigits: 2, useGrouping: false } as const;

const parts = computed(() => splitClockParts(props.value));
</script>

<template>
  <span class="inline-flex items-baseline tabular-nums">
    <NumberFlow :value="parts.minutes" :format="DIGIT_FORMAT" />
    <span class="inline-block">:</span>
    <NumberFlow :value="parts.seconds" :format="DIGIT_FORMAT" />
  </span>
</template>
