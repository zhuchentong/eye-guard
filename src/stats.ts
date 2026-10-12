// 今日/历史完成轮数统计：localStorage 53 周滚动窗口（与全年热力图展示范围一致）。
// 旧版单日键 eye-guard.todayStats 首次读取时自动迁移。

export interface DayStat {
  date: string; // 本地日期 YYYY-MM-DD
  count: number;
}

const STATS_KEY = "eye-guard.stats";
const LEGACY_KEY = "eye-guard.todayStats";
/** 存储滚动窗口天数：53 周 = 371 天。 */
export const WINDOW_DAYS = 371;
/** 热力图显示窗口天数：近 26 周 = 182 天（格子更大更易读；存储仍保留 53 周）。 */
export const DISPLAY_DAYS = 26 * 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function dateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function todayStr(): string {
  return dateStr(new Date());
}

function isValid(stats: unknown): stats is DayStat[] {
  return (
    Array.isArray(stats) &&
    stats.every(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as DayStat).date === "string" &&
        DATE_RE.test((s as DayStat).date) &&
        typeof (s as DayStat).count === "number",
    )
  );
}

export function loadStats(): DayStat[] {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      // 键存在但结构非法：视为无数据（避免脏数据混入视图）
      return isValid(parsed) ? parsed : [];
    }
  } catch {
    // JSON 损坏：继续尝试 legacy 迁移
  }
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const parsed: unknown = JSON.parse(legacy);
      // 旧版为单对象 {date, count}；容错兼容数组形式
      const single = Array.isArray(parsed) ? parsed : [parsed];
      if (single.length > 0 && isValid(single)) return single;
    }
  } catch {
    // 忽略：按无数据处理
  }
  return [];
}

export function saveStats(stats: DayStat[]): void {
  // 按 date 升序去抖后仅保留最近 30 天
  const trimmed = [...stats]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(-WINDOW_DAYS);
  localStorage.setItem(STATS_KEY, JSON.stringify(trimmed));
}

/** 纯函数：休息结束回到工作 = 完成一轮；今日存在则 +1，否则新建今日条目。 */
export function recordCompletedCycle(stats: DayStat[]): DayStat[] {
  const today = todayStr();
  if (stats.some((s) => s.date === today)) {
    return stats.map((s) =>
      s.date === today ? { ...s, count: s.count + 1 } : s,
    );
  }
  return [...stats, { date: today, count: 1 }];
}

export function todayCount(stats: DayStat[]): number {
  const today = todayStr();
  return stats.find((s) => s.date === today)?.count ?? 0;
}

/** 清空统计：主键与 legacy 键一并删除，否则 loadStats 的 legacy 回退会让数据复活。 */
export function clearAllStats(): void {
  localStorage.removeItem(STATS_KEY);
  localStorage.removeItem(LEGACY_KEY);
}

/** 近 n 天每日一条，缺失补零，正序（旧→今）。 */
export function lastNDays(stats: DayStat[], n: number): DayStat[] {
  const out: DayStat[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = dateStr(new Date(Date.now() - i * 86_400_000));
    out.push({ date, count: stats.find((s) => s.date === date)?.count ?? 0 });
  }
  return out;
}

// —— 首页统计条指标（均在 53 周滚动窗口内统计；窗口外的历史已被 saveStats 裁剪）——

/** 窗口内累计轮数。 */
export function totalCycles(stats: DayStat[]): number {
  return stats.reduce((sum, s) => sum + s.count, 0);
}

/** 单日峰值轮数，空数据 0。 */
export function peakCycles(stats: DayStat[]): number {
  return stats.reduce((max, s) => Math.max(max, s.count), 0);
}

/** count ≥ 1 视为「有记录的一天」。 */
const dayMs = 86_400_000;

/**
 * 当前连续天数：从今天往回数连续有记录的日子。
 * 今日为 0 时从昨天起算（宽限——当天还没完成不至于清零挫败）。
 */
export function currentStreak(stats: DayStat[]): number {
  const byDate = new Map(stats.map((s) => [s.date, s.count]));
  const has = (date: string): boolean => (byDate.get(date) ?? 0) >= 1;
  let cursor = Date.now();
  if (!has(todayStr())) cursor -= dayMs; // 今日宽限
  let streak = 0;
  while (has(dateStr(new Date(cursor)))) {
    streak += 1;
    cursor -= dayMs;
  }
  return streak;
}

/** 窗口内最长连续天数：按日期排序后扫描连续段（相邻差恰好一天且均有记录）。 */
export function longestStreak(stats: DayStat[]): number {
  const active = stats
    .filter((s) => s.count >= 1)
    .map((s) => s.date)
    .sort();
  let best = 0;
  let run = 0;
  let prevMs = Number.NaN;
  for (const date of active) {
    const ms = new Date(`${date}T00:00:00`).getTime();
    run = ms - prevMs === dayMs ? run + 1 : 1;
    prevMs = ms;
    best = Math.max(best, run);
  }
  return best;
}
