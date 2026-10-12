import { beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import {
  breakMin,
  cyclesPerLongBreak,
  initSettings,
  lockMessage,
  longBreakEnabled,
  longBreakMin,
  notifyBeforeBreak,
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

  it("关闭长休息时 cyclesPerLongBreak 以 0 持久化", async () => {
    initSettings();
    longBreakEnabled.value = false;
    await nextTick();
    expect(localStorage.getItem("eye-guard.cyclesPerLongBreak")).toBe("0");
  });
});
