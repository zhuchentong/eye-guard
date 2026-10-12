import { beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import {
  breakMin,
  cyclesPerLongBreak,
  dailyGoal,
  dailyGoalEnabled,
  initSettings,
  lockClockStyle,
  lockMessage,
  longBreakEnabled,
  longBreakMin,
  notifyBeforeBreak,
  panelClockStyle,
  workMin,
} from "./settings";

beforeEach(() => {
  localStorage.clear();
});

describe("loadSettings（initSettings 内含）", () => {
  it("读取已保存的设置", () => {
    localStorage.setItem("eye-guard.workMin", "30");
    localStorage.setItem("eye-guard.breakMin", "8");
    localStorage.setItem("eye-guard.longBreakMin", "20");
    localStorage.setItem("eye-guard.cyclesPerLongBreak", "3");
    initSettings();
    expect(workMin.value).toBe(30);
    expect(breakMin.value).toBe(8);
    expect(longBreakMin.value).toBe(20);
    expect(cyclesPerLongBreak.value).toBe(3);
    expect(longBreakEnabled.value).toBe(true);
  });

  it("非法值回退默认", () => {
    localStorage.setItem("eye-guard.workMin", "abc");
    localStorage.setItem("eye-guard.breakMin", "0");
    localStorage.setItem("eye-guard.longBreakMin", "-5");
    localStorage.setItem("eye-guard.cyclesPerLongBreak", "NaN");
    initSettings();
    expect(workMin.value).toBe(25);
    expect(breakMin.value).toBe(5);
    expect(longBreakMin.value).toBe(15);
    expect(cyclesPerLongBreak.value).toBe(4);
    expect(longBreakEnabled.value).toBe(true);
  });

  it("小数分钟向下取整", () => {
    localStorage.setItem("eye-guard.workMin", "30.7");
    initSettings();
    expect(workMin.value).toBe(30);
  });

  it("cyclesPerLongBreak 为 0 表示上次禁用长休息", () => {
    localStorage.setItem("eye-guard.cyclesPerLongBreak", "0");
    initSettings();
    expect(longBreakEnabled.value).toBe(false);
    // 输入框保留默认值便于重新启用
    expect(cyclesPerLongBreak.value).toBe(4);
  });

  it("lockMessage 默认为空并支持读回", () => {
    initSettings();
    expect(lockMessage.value).toBe("");
    localStorage.setItem("eye-guard.lockMessage", "多眨眨眼");
    initSettings();
    expect(lockMessage.value).toBe("多眨眨眼");
  });

  it("notifyBeforeBreak 默认开启并支持读回", () => {
    initSettings();
    expect(notifyBeforeBreak.value).toBe(true);
    localStorage.setItem("eye-guard.notifyBeforeBreak", "false");
    initSettings();
    expect(notifyBeforeBreak.value).toBe(false);
  });

  it("notifyBeforeBreak 非法值回退默认开启", () => {
    localStorage.setItem("eye-guard.notifyBeforeBreak", "yes");
    initSettings();
    expect(notifyBeforeBreak.value).toBe(true);
  });

  it("panelClockStyle / lockClockStyle 默认 digital，保存后可读回", () => {
    initSettings();
    expect(panelClockStyle.value).toBe("digital");
    expect(lockClockStyle.value).toBe("digital");
    localStorage.setItem("eye-guard.panelClockStyle", "clock");
    localStorage.setItem("eye-guard.lockClockStyle", "clock");
    initSettings();
    expect(panelClockStyle.value).toBe("clock");
    expect(lockClockStyle.value).toBe("clock");
  });

  it("时钟风格非法值回退 digital", () => {
    localStorage.setItem("eye-guard.panelClockStyle", "flip");
    localStorage.setItem("eye-guard.lockClockStyle", "");
    initSettings();
    expect(panelClockStyle.value).toBe("digital");
    expect(lockClockStyle.value).toBe("digital");
  });

  it("dailyGoal 默认 8 且开启", () => {
    initSettings();
    expect(dailyGoal.value).toBe(8);
    expect(dailyGoalEnabled.value).toBe(true);
  });

  it("dailyGoal 存 0 表示关闭，输入框回默认 8 便于重新启用", () => {
    localStorage.setItem("eye-guard.dailyGoal", "0");
    initSettings();
    expect(dailyGoalEnabled.value).toBe(false);
    expect(dailyGoal.value).toBe(8);
  });

  it("dailyGoal 合法值读回", () => {
    localStorage.setItem("eye-guard.dailyGoal", "10");
    initSettings();
    expect(dailyGoal.value).toBe(10);
    expect(dailyGoalEnabled.value).toBe(true);
  });

  it("dailyGoal 非法值回退 8 且开启", () => {
    localStorage.setItem("eye-guard.dailyGoal", "abc");
    initSettings();
    expect(dailyGoal.value).toBe(8);
    expect(dailyGoalEnabled.value).toBe(true);
  });
});

describe("watch 持久化", () => {
  it("修改 ref 写回 localStorage", async () => {
    initSettings();
    workMin.value = 40;
    lockMessage.value = "多眨眨眼";
    notifyBeforeBreak.value = false;
    await nextTick();
    expect(localStorage.getItem("eye-guard.workMin")).toBe("40");
    expect(localStorage.getItem("eye-guard.lockMessage")).toBe("多眨眨眼");
    expect(localStorage.getItem("eye-guard.notifyBeforeBreak")).toBe("false");
  });

  it("时钟风格修改写回 localStorage", async () => {
    initSettings();
    panelClockStyle.value = "clock";
    lockClockStyle.value = "clock";
    await nextTick();
    expect(localStorage.getItem("eye-guard.panelClockStyle")).toBe("clock");
    expect(localStorage.getItem("eye-guard.lockClockStyle")).toBe("clock");
  });

  it("dailyGoal 关闭时以 0 写回", async () => {
    initSettings();
    dailyGoalEnabled.value = false;
    await nextTick();
    expect(localStorage.getItem("eye-guard.dailyGoal")).toBe("0");
  });

  it("关闭长休息时 cyclesPerLongBreak 以 0 持久化", async () => {
    initSettings();
    longBreakEnabled.value = false;
    await nextTick();
    expect(localStorage.getItem("eye-guard.cyclesPerLongBreak")).toBe("0");
  });
});
