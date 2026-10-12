import { describe, expect, it } from "vitest";
import { formatBytes, formatProgress } from "./update-progress";

describe("formatProgress", () => {
  it("已知总量时返回整数百分比", () => {
    expect(formatProgress(0, 1024 * 1024)).toBe("0%");
    expect(formatProgress(512 * 1024, 1024 * 1024)).toBe("50%");
    expect(formatProgress(1024 * 1024, 1024 * 1024)).toBe("100%");
  });

  it("百分比向下取整且封顶 100%", () => {
    // 1/3 = 33.33% → 33%（不四舍五入到 34）
    expect(formatProgress(1, 3)).toBe("33%");
    // 分块累加可能瞬时越过总量，进度不得回退显示超过 100%
    expect(formatProgress(2048, 1024)).toBe("100%");
  });

  it("总量未知时降级为已下载字节数", () => {
    expect(formatProgress(42, null)).toBe("42 B");
    expect(formatProgress(2048, 0)).toBe("2 KB");
    expect(formatProgress(1536 * 1024, null)).toBe("1.5 MB");
  });
});

describe("formatBytes", () => {
  it("按 B/KB/MB 分档", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(100 * 1024)).toBe("100 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5 * 1024 * 1024 + 300 * 1024)).toBe("5.3 MB");
  });
});
