<script setup lang="ts">
import { computed } from "vue";
import NumberFlow from "@number-flow/vue";

const props = defineProps<{ value: number }>();

// 与 Intl.NumberFormat 对齐：两位整数、无千分位
const DIGIT_FORMAT = { minimumIntegerDigits: 2, useGrouping: false } as const;

const minutes = computed(() => Math.floor(props.value / 60));
const seconds = computed(() => props.value % 60);
</script>

<template>
  <span class="aclock">
    <NumberFlow :value="minutes" :format="DIGIT_FORMAT" />
    <span class="colon">:</span>
    <NumberFlow :value="seconds" :format="DIGIT_FORMAT" />
  </span>
</template>

<style scoped>
.aclock {
  display: inline-flex;
  align-items: baseline;
  font-variant-numeric: tabular-nums;
}

.colon {
  display: inline-block;
}
</style>
