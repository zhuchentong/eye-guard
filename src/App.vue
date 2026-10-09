<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import TimerPanel from "./components/TimerPanel.vue";
import LockScreen from "./components/LockScreen.vue";

const label = getCurrentWindow().label;
</script>

<template>
  <TimerPanel v-if="label === 'main'" />
  <LockScreen v-else-if="label.startsWith('lock-')" />
</template>
