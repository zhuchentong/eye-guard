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

/** 近 n 天每日一条，缺失补零，正序（旧→今）。 */
export function lastNDays(stats: DayStat[], n: number): DayStat[] {
  const out: DayStat[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = dateStr(new Date(Date.now() - i * 86_400_000));
    out.push({ date, count: stats.find((s) => s.date === date)?.count ?? 0 });
  }
  return out;
}
