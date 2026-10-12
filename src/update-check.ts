// 版本更新检查：纯逻辑拆出，fetch 以参数注入便于 vitest 覆盖。
// GitHub Releases API 直连取 JSON（webview fetch 读不到跨域 302 的 Location，
// 勿模仿 install.sh 的 HEAD+Location 手法）；CORS 已由 api.github.com 放行 *。

export const RELEASES_LATEST_URL =
  "https://api.github.com/repos/zhuchentong/eye-guard/releases/latest";

export const RELEASES_PAGE_URL =
  "https://github.com/zhuchentong/eye-guard/releases/latest";

/** 按 major.minor.patch 数值逐段比较：a<b 返回 -1，相等 0，a>b 返回 1。 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const m = v.replace(/^[vV]/, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!m) throw new Error(`非法版本号: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** 拉取最新 release 的 tag 名；网络、HTTP 与响应形态异常均抛错。 */
export async function fetchLatestTag(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(RELEASES_LATEST_URL, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const data = (await res.json()) as { tag_name?: unknown };
  if (typeof data.tag_name !== "string" || !/^v?\d/.test(data.tag_name)) {
    throw new Error("GitHub 响应缺少 tag_name");
  }
  return data.tag_name;
}
