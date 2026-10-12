// 时钟逻辑层：纯 TypeScript 计算，无 Vue / 无 DOM / 无组件依赖，vitest 直测。
// 样式组件（face）只做渲染，一律消费这里的原语——「怎么算」与「怎么画」分离。

// 已注册的时钟风格 id。新增风格：在此扩展联合类型，
// TypeScript 会强制在 clock-styles.ts 注册表补齐对应条目。
export const CLOCK_STYLE_IDS = ["digital", "clock"] as const;

export type ClockStyleId = (typeof CLOCK_STYLE_IDS)[number];

export const DEFAULT_CLOCK_STYLE: ClockStyleId = "digital";

/** 持久化值校验：非注册 id（含空/null）回退默认。 */
export function normalizeClockStyle(raw: string | null): ClockStyleId {
  return (CLOCK_STYLE_IDS as readonly string[]).includes(raw ?? "")
    ? (raw as ClockStyleId)
    : DEFAULT_CLOCK_STYLE;
}

/** 剩余秒数 → 时/分显示部件（非法输入归零，小数向下取整）。 */
export function splitClockParts(secs: number): { minutes: number; seconds: number } {
  const s = Number.isFinite(secs) && secs > 0 ? Math.floor(secs) : 0;
  return { minutes: Math.floor(s / 60), seconds: s % 60 };
}

/**
 * 表盘指针角度（倒计时进度式：主针从 12 点顺时针扫过，一圈 = 当前相位总时长）。
 * - 主针 progressDeg = 已流逝比例 × 360°，相位结束恰好转满一圈
 * - 秒针 secondDeg = 已流逝秒数 × 6°，连续角单调递增（不取模），
 *   避免每分钟 354°→0° 触发 CSS transition 倒转一整圈的视觉毛刺
 * - total 非法（idle / 缺参 / 非有限值）→ 两针归 12 点；remaining 超出 total 钳制
 */
export function handAngles(
  remaining: number,
  total: number,
): { progressDeg: number; secondDeg: number } {
  if (!Number.isFinite(total) || total <= 0) {
    return { progressDeg: 0, secondDeg: 0 };
  }
  const elapsed = Math.min(Math.max(total - remaining, 0), total);
  return {
    progressDeg: (elapsed / total) * 360,
    secondDeg: elapsed * 6,
  };
}

/**
 * 相位边界吸附判定：相位内主针角度单调递增，任何回落都意味着跨相位归零
 * （含「立即休息」中途接管——降幅可能不足 180°），该帧需跳过 transition，
 * 否则指针会倒转一大圈。正常顺时针推进（含大幅）不吸附。
 */
export function needsSnap(prevDeg: number, nextDeg: number): boolean {
  return nextDeg < prevDeg;
}
