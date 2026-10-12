// bumpp 配置：pnpm release 交互选版本后，
// execute 钩子在提交前把三处版本源同步好（见 scripts/sync-version.mjs）。
// commit 必须用字符串形式 + 顶层 all: true：bumpp 12.3.0 的 normalizeOptions
// 不支持对象形式（message/all 被静默丢弃，v0.1.2 发布即踩中）；all 为 true 时
// bumpp 走 git add --all + commit --all，sync 脚本改动的清单才会随发布提交
// 入库，否则 tag 与 tauri.conf.json 版本不一致（release.yml 守卫拦截）。
export default {
  tag: "v{version}",
  commit: "chore(release): 🔖 发布 {tag}",
  all: true,
  execute: "node scripts/sync-version.mjs",
};
