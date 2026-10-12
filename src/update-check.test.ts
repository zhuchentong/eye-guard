import { describe, expect, it } from "vitest";
import { compareVersions, fetchLatestTag, RELEASES_LATEST_URL } from "./update-check";

describe("compareVersions", () => {
  it("相等返回 0（容忍 v/V 前缀）", () => {
    expect(compareVersions("0.1.2", "0.1.2")).toBe(0);
    expect(compareVersions("v0.1.2", "0.1.2")).toBe(0);
    expect(compareVersions("0.1.2", "V0.1.2")).toBe(0);
  });

  it("按数值逐段比较，规避 0.1.10 < 0.1.9 的字符串陷阱", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("1.0.0", "0.9.99")).toBe(1);
  });

  it("当前版本更旧返回 -1", () => {
    expect(compareVersions("0.1.1", "0.1.2")).toBe(-1);
    expect(compareVersions("0.1.2", "1.0.0")).toBe(-1);
  });

  it("非法版本号抛错", () => {
    expect(() => compareVersions("abc", "0.1.2")).toThrow();
    expect(() => compareVersions("0.1", "0.1.2")).toThrow();
  });
});

describe("fetchLatestTag", () => {
  const okResponse = (body: unknown, ok = true, status = 200) =>
    ({ ok, status, json: async () => body }) as Response;

  it("解析 releases/latest 的 tag_name 并请求固定 URL", async () => {
    const calls: unknown[] = [];
    const fake = (async (input: unknown) => {
      calls.push(input);
      return okResponse({ tag_name: "v0.2.0" });
    }) as typeof fetch;
    await expect(fetchLatestTag(fake)).resolves.toBe("v0.2.0");
    expect(String(calls[0])).toBe(RELEASES_LATEST_URL);
  });

  it("HTTP 非 2xx 抛错", async () => {
    const fake = (async () => okResponse({}, false, 403)) as typeof fetch;
    await expect(fetchLatestTag(fake)).rejects.toThrow("403");
  });

  it("响应缺少 tag_name 抛错", async () => {
    const fake = (async () => okResponse({})) as typeof fetch;
    await expect(fetchLatestTag(fake)).rejects.toThrow("tag_name");
  });
});
