# Repository Guidelines

## Project Overview

**eye-guard** (v0.1.4) is a cross-platform desktop app built with Tauri v2 + Vue 3 + TypeScript + Vite. Implemented feature: a pomodoro-style eye-rest timer — a Rust background thread counts work/break cycles, fires a system notification 30 s before break, pops frameless fullscreen **lock overlay windows** (one per monitor, label prefix `lock-*`) that cover the screen during breaks, and auto-loops to the next cycle. 工作相位可暂停/继续。 The app is tray-resident: closing the main window hides it, and the tray menu offers show/hide, "立即休息", 开机自启 toggle, and quit. Additional integrations: **single instance**（二次启动唤出已有实例；`eye-guard --break` 经单实例通道转发触发立即休息，冷启动同参数直接生效）、**global shortcut Alt+Shift+B**（Wayland 下不可用，注册失败不致命）、**应用内自动更新**（设置区显示版本 + 检查更新，下载安装后 `relaunch` 重启）、**设置页**（主窗口内视图切换：计时/通知/通用/锁屏文案/数据/关于六分区）、**多种时钟风格**（数字滚动 / 模拟表盘，主面板与锁屏分别配置，注册表架构见 `src/clock-styles.ts`）。

## Architecture & Data Flow

Two-process Tauri v2 app:

- **Frontend (webview)** — Vue 3 SFCs in `src/`, mounted by `src/main.ts` (`createApp(App).mount("#app")`). No router, no Pinia, no state library.
- **Backend (Rust)** — `src-tauri/src/main.rs` is a thin binary entry calling `eye_guard_lib::run()`; `src-tauri/src/lib.rs` builds the app via `tauri::Builder` and registers commands.
- **IPC bridge** — frontend calls Rust with `invoke("command_name", { camelCaseArgs })` from `@tauri-apps/api`; Rust exposes `#[tauri::command]` fns registered in `tauri::generate_handler![...]`. Commands: `start_pomodoro(work_secs, break_secs, long_break_secs, cycles_per_long_break)`, `stop_pomodoro`, `get_status`, `end_break_early`, `start_break_now`, `pause_pomodoro`（仅 work 相位）, `resume_pomodoro`, `set_notify_before_break`, `get_autostart`, `set_autostart`.
- **Permissions** — frontend→backend access is gated by `src-tauri/capabilities/default.json` (`core:default` + `opener:default` on windows `main` **and `lock-*`** — the glob is required so overlay windows may `listen`/`invoke`) and `src-tauri/capabilities/updater.json` (`updater:default` + `process:allow-restart`, main window only — 遮罩窗口无更新 UI). Any command/plugin needing non-default permissions requires a capability update.
- **State & events** — `TimerState` (managed in `lib.rs`) owns an `Arc<AtomicBool>` running flag, the worker `JoinHandle`, a `Mutex<PhaseStatus>` (`{running, phase: "idle"|"work"|"break", remaining_secs, cycle, long_break, paused}`), and the `TimerConfig` (`{work_secs, break_secs, long_break_secs, cycles_per_long_break}`; `cycles_per_long_break` 为 0 表示禁用长休息). The clock lives in a **Rust std thread** (`run_cycles`, `pace_tick` 单调时钟锚定的 1 s tick) — never move it to JS (throttled webview timers miss overlays). 工作线程每 tick 都以共享 `status` 为准（不缓存本地副本），因此 `start_break_now` 能在运行中接管相位。Backend emits `timer-tick` (every second) and `phase-changed` (phase transitions); frontends `listen` and render `PhaseStatus`. 休息通知「30 秒后休息」在剩余 30 s 时发送；`work_secs ≤ 30` 时改为相位开始即发。休息结束（`finish_break`，含跳过）发「休息结束，开始下一轮工作」通知。 `App.vue` dispatches on `getCurrentWindow().label`: `main` → `TimerPanel`, `lock-*` → `LockScreen`. 休息预告通知受 `TimerState.notify_before_break`（`Arc<AtomicBool>`，worker 逐 tick 读取，改动即时生效）控制；开机自启经 `get_autostart`/`set_autostart` 查改，与托盘勾选双向同步（两侧变更均发 `autostart-changed` 事件）。 今日完成轮数与热力图统计由前端管理（`phase-changed` 的 break→work 转换经 `src/stats.ts` 写入 localStorage `eye-guard.stats` 53 周滚动窗口（`WINDOW_DAYS = 371`），旧键 `todayStats` 自动迁移；热力图仅显示近 26 周（`DISPLAY_DAYS = 182`），格子 14px，悬停经 shadcn Tooltip 显示日期/轮数/色阶圆点）。首页统计卡展示 5 项指标——今日轮数（含每日目标 `N/goal` + 4px 进度条）/累计轮数/单日峰值/当前连续/最长连续天数，全部由 `src/stats.ts` 纯函数（`totalCycles`/`peakCycles`/`currentStreak`/`longestStreak`）推导，均在 53 周窗口内统计；`currentStreak` 今日为 0 时从昨天宽限回数。
- **Window management** — overlays are created on the **main thread** (`run_on_main_thread`) via `WebviewWindowBuilder`. On Linux + Wayland with a layer-shell-capable compositor (sway/wlroots, KWin), each overlay is initialized as a **layer surface** (`gtk-layer-shell`, Overlay layer, anchored to all edges of the matched `gdk::Monitor`) so dual-monitor setups get one lock window per output; the window is built `.visible(false)`, attached, then shown via GTK `show_all()` (Tauri's `show()` is event-loop-queued). All other platforms and the fallback path use `.fullscreen(true)` + `set_position` per monitor（macOS 例外：不走 fullscreen，用 `set_size` 适配显示器）. Their `CloseRequested` is prevented (Alt-F4 cannot dismiss), and they are destroyed only by the timer (`close_lock_overlays`) — 必须用 `destroy()` 而非 `close()`：`close()` 会被窗口自身的 prevent_close 拦截。遮罩窗口创建是幂等的（已存在的 `lock-i` 跳过）；显示器枚举经主窗口（仅隐藏不销毁），枚举为空（如 test mock runtime）则整体跳过。 Do NOT add `.resizable(false)` — on GTK-Wayland it clamps min=max and deadlocks the fullscreen configure handshake (window never maps). Main window `CloseRequested` hides to tray instead of exiting. 托盘标题经 `update_tray_status` 同步剩余时间（`tray_title` 纯函数生成文本；按相位变化/分钟边界节流，`run_on_main_thread` 派发；Windows 不支持 title 静默忽略，GNOME AppIndicator 扩展可能不渲染）。

## Key Directories

- `src/` — Vue frontend: `App.vue` (window-label dispatcher), `components/TimerPanel.vue` (main timer UI：时钟/统计卡（5 指标+目标进度）/贡献热力图), `components/SettingsPanel.vue` (设置页：计时/通知/通用/锁屏文案/数据/关于六分区，应用内更新逻辑在此), `components/LockScreen.vue` (fullscreen break overlay), `components/AnimatedClock.vue` (时钟样式分发器：按 `styleId` 渲染 face，纯编排), `components/DigitalFace.vue` (数字滚动样式 face，`@number-flow/vue`), `components/AnalogClock.vue` (模拟表盘样式 face：SVG 倒计时进度式指针+中心 mm:ss), `components/ui/` (shadcn-vue 原语：button/input/label/switch/alert/tooltip), `clock.ts` + `clock.test.ts` (时钟逻辑纯函数：风格 id 校验/时间拆解/表盘角度与防回绕吸附), `clock-styles.ts` (时钟样式注册表：`Record<ClockStyleId, ClockStyleDef>` 编译期穷尽，新增样式 = face 组件 + 一行注册), `settings.ts` + `settings.test.ts` (设置模块单例：模块级 ref + localStorage 持久化，TimerPanel/SettingsPanel/LockScreen 共享), `stats.ts` + `stats.test.ts` (轮数统计纯函数：记录/热力图窗口/5 项指标与单测), `update-progress.ts` + `update-progress.test.ts`（更新下载进度格式化纯函数，百分比/字节降级）, `types.ts` (`PhaseStatus`；`formatClock` 目前无组件使用), `main.ts` (entry), `vite-env.d.ts`.
- `src-tauri/src/` — Rust backend: `lib.rs` (app builder + commands), `main.rs` (entry).
- `src-tauri/capabilities/` — Tauri v2 permission files (`default.json`, `updater.json`).
- `scripts/` — `install.sh`（用户一键安装：按发行版选 deb/rpm/AppImage，支持 `GH_MIRROR` 镜像与 `--uninstall`）、`sync-version.mjs`（bumpp execute 钩子，同步四处版本，带替换计数守卫）。`bump.config.ts` — bumpp 配置（release 流程见下）。
- `src-tauri/gen/`, `src-tauri/icons/` — generated output; never hand-edit (`gen/schemas/` regenerates from capabilities).
- `public/` — static assets copied verbatim into the bundle.

## Development Commands

Package manager: **pnpm only** (lockfile: `pnpm-lock.yaml`). Node ≥ 22；`packageManager` 字段锁定 pnpm 版本（`corepack enable` 可得正确版本）。

```sh
pnpm install
pnpm dev            # Vite dev server on http://localhost:1420 (strictPort)
pnpm build          # vue-tsc --noEmit && vite build → dist/
pnpm test           # vitest run（jsdom：stats 统计 / settings 设置 / clock 时钟逻辑 / update-progress 格式化）
pnpm preview
pnpm tauri dev      # full desktop app (wires pnpm dev → devUrl :1420；dev 模式「检查更新」降级为打开 Releases 页)
pnpm tauri build    # release bundle, targets "all"；createUpdaterArtifacts 已开启——无签名 env 直接失败：
                    #   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/eye-guard.key)"
                    #   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""   # 无密码也要显式空串
```

Rust tooling (run inside `src-tauri/`): `cargo fmt`, `cargo clippy`, `cargo test` — default config, no custom rustfmt/clippy settings.

**Port 1420 is contractual**: `vite.config.ts` `strictPort` must match `tauri.conf.json` `build.devUrl`. Never change one without the other.

发布：`pnpm release`（bumpp 交互）→ `bump.config.ts` 的 execute 钩子经 `scripts/sync-version.mjs` 同步四处版本（带替换计数守卫）→ 提交 + `v*` tag → `release.yml` 构建 deb/rpm/AppImage 并发 Release。手动验证流水线：Actions 页 `workflow_dispatch`；tag push 时 release.yml 校验 tag 版本与 `tauri.conf.json` 一致，不一致直接失败（v0.1.1 首发踩中）。注意：`bump.config.ts` 必须保持字符串形式 `commit` + 顶层 `all: true`——bumpp 12.3.0 的 normalizeOptions 会静默丢弃对象形式的 message/all（v0.1.2 踩中），且路径限定提交会丢掉 sync 脚本改动的清单文件；release 上传 glob 显式三目录（宽 glob 会把 AppImage 解包文件一起传并触发次级限流），`latest.json` 置首保证更新可发现。

## Code Conventions & Common Patterns

- **Vue**: `<script setup lang="ts">`, `ref()` for local state, camelCase identifiers, double quotes; forms via `@submit.prevent` + async handler wrapping `invoke`.
- **Styling**: Tailwind v4 + shadcn-vue 全面就绪（`@tailwindcss/vite` 插件、`src/styles/globals.css` 主题变量与动画 tokens、`components.json`、`cn()` 在 `src/lib/utils.ts`、`@/*` 别名（`tsconfig.json` `paths` 与 `vite.config.ts` `resolve.alias` 必须同步）；深色模式跟随系统 media query，无 `.dark` class 切换；`--primary` 等品牌色已注入）。TimerPanel/LockScreen/AnimatedClock 均为 shadcn 组件 + tailwind 工具类实现，**全仓库无 `<style>` 块**；shadcn 原语在 `src/components/ui/`（registry 生成物，可 `pnpm dlx shadcn-vue@latest add <component>` 增补；CLI 拉取 registry 失败时可 curl `https://shadcn-vue.com/r/styles/new-york-v4/<name>.json` 手动落地，依赖 reka-ui + @vueuse/core）。App.vue **没有全局样式块**——勿再添加未分层的元素选择器规则（会压过 shadcn 的分层工具类）；字体栈/文字渲染/body 底色由 globals.css 承接。入场动画用 tw-animate-css（配 `motion-safe:` 与 `fill-mode-both`），循环动画在 `@theme --animate-*` 定义。注意 shadcn `Input` 用 `useVModel`，`v-model.number` 修饰符实际不生效（现有校验与强转逻辑已容忍字符串值）。
- **Rust commands**: snake_case names; keep them in `lib.rs` and register each in `generate_handler!`. Template commands return plain values; adopt `Result<T, E>` when real error handling is needed (current code only `.expect()`s at startup).
- **Rust naming**: package `eye-guard` (kebab), lib `eye_guard_lib` (snake, set in `Cargo.toml [lib]`) — keep in sync with the `use eye_guard_lib::...` in `main.rs`.
- **TS strictness**: `strict`, `noUnusedLocals`, `noUnusedParameters`, `isolatedModules` — dead/unused code fails `pnpm build`.
- **localStorage 键**：统一 `eye-guard.` 前缀 — `workMin` / `breakMin` / `longBreakMin` / `cyclesPerLongBreak`（设置持久化，`cyclesPerLongBreak` 为 `0` 表示禁用长休息——UI 由它反推勾选态）、`dailyGoal`（每日目标轮数，`0` = 关闭目标，UI 由 `dailyGoalEnabled` 反推勾选态）、`notifyBeforeBreak`（休息预告通知开关，`"false"` = 关，其余 = 开）、`panelClockStyle` / `lockClockStyle`（主面板/锁屏时钟风格 id，非法值回退 `digital`）、`stats`（每日完成轮数，`src/stats.ts` 管理 53 周滚动窗口；旧键 `todayStats` 首次读取自动迁移）、`lockMessage`（LockScreen 自定义文案接入点：设置该键即覆盖锁屏默认提示）。
- **诊断日志**：Rust 侧统一 `eprintln!("[eg] ...")`，无日志框架。

## Important Files

- `src/App.vue` — window-label dispatcher (`main` → TimerPanel, `lock-*` → LockScreen)；无全局样式。
- `src-tauri/src/lib.rs` — timer state machine, worker thread, overlay/tray management（休息态切换内嵌的 `icons/tray-break.png` 托盘图标，`image-png` feature 解码）, plugins (`tauri_plugin_single_instance` — must register first, 支持 `--break` argv 转发与冷启动参数, `tauri_plugin_autostart` — tray 开机自启 toggle, `tauri_plugin_global_shortcut` — `break_shortcut()` = Alt+Shift+B 触发立即休息, Linux-Wayland 下不可用需桌面快捷键 + `--break`, `tauri_plugin_opener`, `tauri_plugin_notification`, `tauri_plugin_updater` — 应用内自动更新（`capabilities/updater.json` 授权，endpoint 为 GitHub Releases 静态 `latest.json`，签名密钥见 README「开发」）, `tauri_plugin_process` — relaunch), command registry, `#[cfg(test)]` unit tests.
- `src-tauri/tauri.conf.json` — identity (`com.zhuchentong.eye-guard`), single 800×600 window (label `main`), bundling; CSP：`default-src 'self'` + 样式放行 `unsafe-inline`（Vue/NumberFlow 内联样式），`devCsp` 额外放行 `ws://localhost:1420` 与 `http://localhost:1420`（Vite HMR）。
- `src-tauri/Cargo.toml` — deps: `tauri 2` (`tray-icon` + `image-png` features), `parking_lot`, `serde`/`serde_json`, plugins `single-instance`/`autostart`/`global-shortcut`/`opener`/`notification`/`updater`/`process`; Linux-gated (`cfg(target_os = "linux")`): `gtk`/`gdk` 0.18 + `gtk-layer-shell` 0.8 (`v0_5` feature, for Wayland per-monitor lock overlays); dev-dep `tauri` with `test` feature (mock runtime); hardened release profile (lto, `panic="abort"`, strip).
- `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json` — build/typecheck config.
- `package.json` — scripts and dependency versions.

## Runtime/Tooling Preferences

- Node side: pnpm, ESM (`"type": "module"`); never npm/yarn (lockfile drift). Tauri CLI via `pnpm tauri`.
- pnpm 12 的设置与 overrides 唯一读取位置是 `pnpm-workspace.yaml`（package.json 的 `pnpm` 字段已废弃不再读取）。仓库显式声明 `minimumReleaseAge: 1440`（拒绝发布不足 24 h 的包版本，CI 同策略）；`tldts`/`tldts-core` 钉 7.4.16 是为绕开 2026-10-07 双发的过新版本，老化后可移除。
- Rust crate 走国内 mirror（同步有滞后）：npm 侧 `@tauri-apps/api`/`@tauri-apps/plugin-opener` 用精确版本与 Cargo.lock 的 crate minor 配对（tauri CLI 硬校验 mismatch，`pnpm tauri build` 直接失败）。mirror 同步后先 `cargo update -p tauri -p tauri-plugin-opener` 升 crate，再放开 npm pin。
- Rust: edition 2021.
- `vite.config.ts` ignores `src-tauri/**` in its watcher — backend changes need a `pnpm tauri dev` restart.
- Do not edit: `pnpm-lock.yaml`, `src-tauri/gen/`, `src-tauri/icons/`, `src-tauri/target/`.
- Recommended VS Code extensions (`.vscode/extensions.json`): Volar, tauri-vscode, rust-analyzer.

## Testing & QA

- **Rust unit tests exist** in `src-tauri/src/lib.rs` (`#[cfg(test)] mod tests`, 11 tests): 两条 `pace_tick` 网格测试（秒级）+ zero-duration rejection、`end_break_early` guard、idle→break worker spawn + auto-cycle、running-timer break takeover、pause 冻结/恢复 + break 相位拒绝、break takeover 清除 pause、`tray_title` 纯函数（相位/paused/补零格式）+ tray 相位编码。4 条时序测试跑真实 1 s tick（配置已缩短至 work 4s / break 2s 量级）— 整套实测约 7 s，且 `idle_break_spawns_worker_and_auto_cycles` 会触发真实 dbus 通知。单个测试：`cargo test <name>`。
- **Frontend tests** — vitest run（jsdom，共 62 条）：`src/stats.test.ts`（27 条）覆盖 `src/stats.ts`（跨日累加、53 周滚动窗口裁剪、legacy 迁移、容错、5 项指标含连续天数宽限语义），`src/settings.test.ts`（17 条）覆盖设置模块单例（时长/目标/锁屏文案/通知开关/时钟风格的加载校验与写回），`src/clock.test.ts`（14 条）覆盖时钟逻辑纯函数（风格 id 校验、时间拆解、表盘角度、防回绕吸附），`src/update-progress.test.ts`（4 条）覆盖下载进度格式化。仍无 JS linter/formatter setup。
- QA gates（`ci.yml` 同款）: `pnpm test`（vitest）→ `pnpm build`（内含 `vue-tsc --noEmit`）；Rust: `cargo fmt --all -- --check` + `cargo clippy --all-targets -- -D warnings`（zero warnings expected; repo rule: use `parking_lot::Mutex`, never `.lock().unwrap()`）+ `cargo test`。CI 两个 job 均锚定 ubuntu-24.04（`libgtk-layer-shell-dev` 0.8.x 与 Cargo 的 `v0_5` feature 绑定）。