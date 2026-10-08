// bumpp 配置：pnpm release 交互选版本后，
// execute 钩子在提交前把三处版本源同步好（见 scripts/sync-version.mjs）。
// commit.all 必须为 true：bumpp 默认只提交它自己更新的文件（path-scoped
// git commit -- <files>），sync 脚本暂存的其余清单会被排除，导致 tag 与
// tauri.conf.json 版本不一致（release.yml 守卫拦截，v0.1.1 首发即踩中）。
export default {
  tag: "v{version}",
  commit: {
    message: "chore(release): 🔖 发布 {tag}",
    all: true,
  },
  execute: "node scripts/sync-version.mjs",
};
