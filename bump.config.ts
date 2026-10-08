// bumpp 配置：pnpm release 交互选版本后，
// execute 钩子在提交前把三处版本源同步好（见 scripts/sync-version.mjs）。
export default {
  tag: "v{version}",
  commit: "chore(release): 🔖 发布 {tag}",
  execute: "node scripts/sync-version.mjs",
};
