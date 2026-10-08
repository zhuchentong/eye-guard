# eye-guard

护眼番茄钟桌面应用：工作计时结束后自动全屏锁定遮罩，提醒你离开屏幕休息。

基于 **Tauri v2 + Vue 3 + TypeScript** 构建，托盘常驻，支持多显示器。

## 功能

- 番茄钟循环：工作 → 休息 → 下一轮，自动循环；每 N 轮可进入一次长休息（可关闭）；工作相位可暂停/继续
- 休息前 30 秒系统通知预告（工作时长 ≤ 30 秒时改为开始即发）；休息结束再发「休息结束」通知
- 休息时按显示器数量弹出**全屏锁定遮罩**，倒计时结束自动撤除（Alt-F4 无法关闭，只能等倒计时或点"跳过休息"）
- 托盘常驻：显示/隐藏窗口、立即休息、开机自启、退出；托盘标题实时显示剩余时间（如「工作 24:59」；GNOME 的 AppIndicator 扩展可能不渲染标题）；主窗口关窗即隐藏到托盘
- 单实例：二次启动唤出已有实例；`eye-guard --break` 可立即触发休息
- 全局快捷键 `Alt+Shift+B`：立即休息
- 今日完成轮数统计与近 7 天 mini 条形图（前端本地持久化，30 天滚动窗口，跨日自动归档）

## 平台说明

- **Linux + Wayland**（sway/wlroots、KWin 等支持 layer-shell 的合成器）：锁定遮罩以 layer-surface 逐显示器锚定（Overlay 层）。
- **全局快捷键**在 Wayland 下不可用（X11 抓取限制）：可改用桌面快捷键执行 `eye-guard --break`，参数经单实例通道转发给运行中的实例。
- macOS：遮罩窗口不走 fullscreen，按显示器 `set_size` 适配。

## 开发

包管理器仅使用 **pnpm**（Node ≥ 22）。

```sh
pnpm install
pnpm dev            # Vite dev server，http://localhost:1420（strictPort，勿改）
pnpm build          # vue-tsc --noEmit && vite build
pnpm test           # vitest run（jsdom，统计逻辑单测）
pnpm tauri dev      # 完整桌面应用
pnpm tauri build    # 发布打包
```

Rust 工具链（在 `src-tauri/` 内执行）：

```sh
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings   # 仓库规则：零警告
cargo test                                   # 整套约 7-15 s，含真实 1 s tick；会触发一条 dbus 通知
```

Linux 构建依赖：`libwebkit2gtk-4.1-dev`、`libgtk-3-dev`、`libgtk-layer-shell-dev`、`libayatana-appindicator3-dev` 等（见 `.github/workflows/ci.yml`）。

注意：`vite.config.ts` 的 watcher 忽略 `src-tauri/**`——改 Rust 代码需重启 `pnpm tauri dev`。端口 1420 是 `vite.config.ts` 与 `src-tauri/tauri.conf.json`（`build.devUrl`）的契约，两端必须一致。

## 架构速览

- **前端** `src/`：Vue 3 SFC。`App.vue` 按窗口 label 分发：`main` → 计时面板，`lock-*` → 锁屏。
- **后端** `src-tauri/src/lib.rs`：计时器状态机与 Rust 工作线程（1 s 单调时钟 tick），托盘/遮罩窗口管理，命令经 `#[tauri::command]` + `generate_handler!` 注册。
- **事件**：后端每秒发 `timer-tick`，相位变化发 `phase-changed`；前端 `listen` 渲染。
