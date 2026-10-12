import { describe, expect, it } from "vitest";
import {
  CLOCK_STYLE_IDS,
  DEFAULT_CLOCK_STYLE,
  handAngles,
  needsSnap,
  normalizeClockStyle,
  splitClockParts,
} from "./clock";

describe("normalizeClockStyle", () => {
  it("合法 id 原样返回", () => {
    expect(normalizeClockStyle("digital")).toBe("digital");
    expect(normalizeClockStyle("clock")).toBe("clock");
  });

  it("非法/空值回退默认", () => {
    expect(normalizeClockStyle("flip")).toBe(DEFAULT_CLOCK_STYLE);
    expect(normalizeClockStyle("")).toBe(DEFAULT_CLOCK_STYLE);
    expect(normalizeClockStyle(null)).toBe(DEFAULT_CLOCK_STYLE);
    expect(normalizeClockStyle("Digital")).toBe(DEFAULT_CLOCK_STYLE); // 大小写敏感
  });

  it("id 表包含默认值", () => {
    expect(CLOCK_STYLE_IDS).toContain(DEFAULT_CLOCK_STYLE);
  });
});

describe("splitClockParts", () => {
  it("常规拆分", () => {
    expect(splitClockParts(0)).toEqual({ minutes: 0, seconds: 0 });
    expect(splitClockParts(65)).toEqual({ minutes: 1, seconds: 5 });
    expect(splitClockParts(60)).toEqual({ minutes: 1, seconds: 0 });
    expect(splitClockParts(599)).toEqual({ minutes: 9, seconds: 59 });
    expect(splitClockParts(3600)).toEqual({ minutes: 60, seconds: 0 });
  });

  it("非法输入归零", () => {
    expect(splitClockParts(-3)).toEqual({ minutes: 0, seconds: 0 });
    expect(splitClockParts(Number.NaN)).toEqual({ minutes: 0, seconds: 0 });
    expect(splitClockParts(Number.POSITIVE_INFINITY)).toEqual({ minutes: 0, seconds: 0 });
  });

  it("小数向下取整", () => {
    expect(splitClockParts(65.9)).toEqual({ minutes: 1, seconds: 5 });
  });
});

describe("handAngles（倒计时进度式）", () => {
  it("相位起点两针归零", () => {
    expect(handAngles(300, 300)).toEqual({ progressDeg: 0, secondDeg: 0 });
  });

  it("半程主针 180°", () => {
    expect(handAngles(150, 300).progressDeg).toBe(180);
  });

  it("相位结束主针转满 360°", () => {
    expect(handAngles(0, 300).progressDeg).toBe(360);
  });

  it("秒针连续角 elapsed × 6°，不取模", () => {
    // elapsed = 65 → 390°，越过一整圈继续顺时针
    expect(handAngles(235, 300).secondDeg).toBe(390);
  });

  it("total 非法（idle/缺参）时两针归零", () => {
    expect(handAngles(120, 0)).toEqual({ progressDeg: 0, secondDeg: 0 });
    expect(handAngles(120, Number.NaN)).toEqual({ progressDeg: 0, secondDeg: 0 });
    expect(handAngles(120, -5)).toEqual({ progressDeg: 0, secondDeg: 0 });
  });

  it("remaining 超出 total 时钳制到起点", () => {
    expect(handAngles(400, 300)).toEqual({ progressDeg: 0, secondDeg: 0 });
  });
});

describe("needsSnap（相位边界防回绕吸附）", () => {
  it("角度回落 → 吸附", () => {
    expect(needsSnap(354, 0)).toBe(true);
    expect(needsSnap(100, 5)).toBe(true); // 「立即休息」中途接管：降幅不足 180° 也是跨相位
    expect(needsSnap(180, 0)).toBe(true);
  });

  it("正常顺时针推进 → 不吸附", () => {
    expect(needsSnap(0, 6)).toBe(false);
    expect(needsSnap(180, 200)).toBe(false);
    expect(needsSnap(10, 350)).toBe(false); // 大幅顺时针不是回绕
  });
});
