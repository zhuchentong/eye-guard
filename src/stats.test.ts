import { beforeEach, describe, expect, it } from "vitest";
import {
  dateStr,
  lastNDays,
  loadStats,
  recordCompletedCycle,
  saveStats,
  todayCount,
  todayStr,
} from "./stats";

beforeEach(() => {
  localStorage.clear();
});

describe("todayStr / dateStr", () => {
  it("todayStr 为本地日期 YYYY-MM-DD", () => {
    expect(todayStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("dateStr 按本地时区格式化", () => {
    expect(dateStr(new Date(2026, 9, 8))).toBe("2026-10-08");
  });
});

describe("recordCompletedCycle", () => {
  it("空列表记录今日 1 轮", () => {
    expect(recordCompletedCycle([])).toEqual([{ date: todayStr(), count: 1 }]);
  });

  it("同日累加", () => {
    const today = todayStr();
    expect(recordCompletedCycle([{ date: today, count: 3 }])).toEqual([
      { date: today, count: 4 },
    ]);
  });

  it("跨日新建一条且保留历史", () => {
    expect(recordCompletedCycle([{ date: "2020-01-01", count: 5 }])).toEqual([
      { date: "2020-01-01", count: 5 },
      { date: todayStr(), count: 1 },
    ]);
  });

  it("纯函数：不修改入参", () => {
    const prev = [{ date: todayStr(), count: 1 }];
    recordCompletedCycle(prev);
    expect(prev[0].count).toBe(1);
  });
});

describe("todayCount / lastNDays", () => {
  it("todayCount 无今日记录为 0", () => {
    expect(todayCount([{ date: "2020-01-01", count: 5 }])).toBe(0);
  });

  it("todayCount 取今日记录", () => {
    expect(todayCount([{ date: todayStr(), count: 2 }])).toBe(2);
  });

  it("lastNDays 补零缺失日期且正序（旧→今）", () => {
    const yesterday = dateStr(new Date(Date.now() - 86_400_000));
    const stats = [
      { date: yesterday, count: 2 },
      { date: todayStr(), count: 3 },
    ];
    const week = lastNDays(stats, 3);
    expect(week).toEqual([
      { date: dateStr(new Date(Date.now() - 2 * 86_400_000)), count: 0 },
      { date: yesterday, count: 2 },
      { date: todayStr(), count: 3 },
    ]);
  });
});

describe("loadStats / saveStats", () => {
  it("保存后读回一致", () => {
    const stats = [{ date: todayStr(), count: 1 }];
    saveStats(stats);
    expect(loadStats()).toEqual(stats);
  });

  it("saveStats 裁剪到 30 天窗口（保留最近）", () => {
    const stats = Array.from({ length: 40 }, (_, i) => ({
      date: dateStr(new Date(Date.now() - (39 - i) * 86_400_000)),
      count: i,
    }));
    saveStats(stats);
    const loaded = loadStats();
    expect(loaded).toHaveLength(30);
    expect(loaded[0].count).toBe(10);
    expect(loaded[29].count).toBe(39);
  });

  it("迁移旧 eye-guard.todayStats 键", () => {
    localStorage.setItem(
      "eye-guard.todayStats",
      JSON.stringify({ date: todayStr(), count: 7 }),
    );
    expect(loadStats()).toEqual([{ date: todayStr(), count: 7 }]);
  });

  it("损坏 JSON 容错返回空", () => {
    localStorage.setItem("eye-guard.stats", "not-json{");
    expect(loadStats()).toEqual([]);
  });

  it("非法结构（非数组/字段类型错）容错", () => {
    localStorage.setItem("eye-guard.stats", JSON.stringify({ date: "x" }));
    expect(loadStats()).toEqual([]);
    localStorage.setItem(
      "eye-guard.stats",
      JSON.stringify([{ date: 123, count: "x" }]),
    );
    expect(loadStats()).toEqual([]);
  });
});
