# Repository Guidelines

## Project Overview

**eye-guard** (v0.1.0) is a cross-platform desktop app built with Tauri v2 + Vue 3 + TypeScript + Vite. Implemented feature: a pomodoro-style eye-rest timer — a Rust background thread counts work/break cycles, fires a system notification 30 s before break, pops frameless fullscreen **lock overlay windows** (one per monitor, label prefix `lock-*`) that cover the screen during breaks, and auto-loops to the next cycle. The app is tray-resident: closing the main window hides it, and the tray menu offers show/hide, "立即休息", and quit.

## Architecture & Data Flow

Two-process Tauri v2 app:

- **Frontend (webview)** — Vue 3 SFCs in `src/`, mounted by `src/main.ts` (`createApp(App).mount("#app")`). No router, no Pinia, no state library.
- **Backend (Rust)** — `src-tauri/src/main.rs` is a thin binary entry calling `eye_guard_lib::run()`; `src-tauri/src/lib.rs` builds the app via `tauri::Builder` and registers commands.
- **IPC bridge** — frontend calls Rust with `invoke("command_name", { camelCaseArgs })` from `@tauri-apps/api`; Rust exposes `#[tauri::command]` fns registered in `tauri::generate_handler![...]`. Commands: `start_pomodoro(work_secs, break_secs, long_break_secs, cycles_per_long_break)`, `stop_pomodoro`, `get_status`, `end_break_early`, `start_break_now`, `pause_pomodoro`（仅 work 相位）, `resume_pomodoro`.
- **Permissions** — frontend→backend access is gated by `src-tauri/capabilities/default.json` (`core:default` + `opener:default` on windows `main` **and `lock-*`** — the glob is required so overlay windows may `listen`/`invoke`). Any command/plugin needing non-default permissions requires a capability update.
- **State & events** — `TimerState` (managed in `lib.rs`) owns an `Arc<AtomicBool>` running flag, the worker `JoinHandle`, a `Mutex<PhaseStatus>` (`{running, phase: "idle"|"work"|"break", remaining_secs, cycle, long_break, paused}`), and the `TimerConfig` (`{work_secs, break_secs, long_break_secs, cycles_per_long_break}`; `cycles_per_long_break` 为 0 表示禁用长休息). The clock lives in a **Rust std thread** (`run_cycles`, `pace_tick` 单调时钟锚定的 1 s tick) — never move it to JS (throttled webview timers miss overlays). 工作线程每 tick 都以共享 `status` 为准（不缓存本地副本），因此 `start_break_now` 能在运行中接管相位。Backend emits `timer-tick` (every second) and `phase-changed` (phase transitions); frontends `listen` and render `PhaseStatus`. 休息通知「30 秒后休息」在剩余 30 s 时发送；`work_secs ≤ 30` 时改为相位开始即发。休息结束（`finish_break`，含跳过）发「休息结束，开始下一轮工作」通知。 `App.vue` dispatches on `getCurrentWindow().label`: `main` → `TimerPanel`, `lock-*` → `LockScreen`. 今日完成轮数与近 7 天统计由前端管理（`phase-changed` 的 break→work 转换经 `src/stats.ts` 写入 localStorage `eye-guard.stats` 30 天滚动窗口，旧键 `todayStats` 自动迁移）。
- **Window management** — overlays are created on the **main thread** (`run_on_main_thread`) via `WebviewWindowBuilder`. On Linux + Wayland with a layer-shell-capable compositor (sway/wlroots, KWin), each overlay is initialized as a **layer surface** (`gtk-layer-shell`, Overlay layer, anchored to all edges of the matched `gdk::Monitor`) so dual-monitor setups get one lock window per output; the window is built `.visible(false)`, attached, then shown via GTK `show_all()` (Tauri's `show()` is event-loop-queued). All other platforms and the fallback path use `.fullscreen(true)` + `set_position` per monitor（macOS 例外：不走 fullscreen，用 `set_size` 适配显示器）. Their `CloseRequested` is prevented (Alt-F4 cannot dismiss), and they are destroyed only by the timer (`close_lock_overlays`) — 必须用 `destroy()` 而非 `close()`：`close()` 会被窗口自身的 prevent_close 拦截。遮罩窗口创建是幂等的（已存在的 `lock-i` 跳过）；显示器枚举经主窗口（仅隐藏不销毁），枚举为空（如 test mock runtime）则整体跳过。 Do NOT add `.resizable(false)` — on GTK-Wayland it clamps min=max and deadlocks the fullscreen configure handshake (window never maps). Main window `CloseRequested` hides to tray instead of exiting. 托盘标题经 `update_tray_status` 同步剩余时间（`tray_title` 纯函数生成文本；按相位变化/分钟边界节流，`run_on_main_thread` 派发；Windows 不支持 title 静默忽略，GNOME AppIndicator 扩展可能不渲染）。

## Key Directories

- `src/` — Vue frontend: `App.vue` (window-label dispatcher), `components/TimerPanel.vue` (main timer UI), `components/LockScreen.vue` (fullscreen break overlay), `components/AnimatedClock.vue` (`@number-flow/vue` 数字滚动时钟，两个界面共用), `types.ts` (`PhaseStatus`；`formatClock` 目前无组件使用), `main.ts` (entry), `vite-env.d.ts`.
- `src-tauri/src/` — Rust backend: `lib.rs` (app builder + commands), `main.rs` (entry).
- `src-tauri/capabilities/` — Tauri v2 permission files (`default.json`).
- `src-tauri/gen/`, `src-tauri/icons/` — generated output; never hand-edit (`gen/schemas/` regenerates from capabilities).
- `public/` — static assets copied verbatim into the bundle.

## Development Commands

Package manager: **pnpm only** (lockfile: `pnpm-lock.yaml`).

```sh
pnpm install
pnpm dev            # Vite dev server on http://localhost:1420 (strictPort)
pnpm build          # vue-tsc --noEmit && vite build → dist/
pnpm test           # vitest run（jsdom 环境，覆盖 src/stats.ts 统计逻辑）
pnpm preview
pnpm tauri dev      # full desktop app (wires pnpm dev → devUrl :1420)
pnpm tauri build    # release bundle, targets "all"
```

Rust tooling (run inside `src-tauri/`): `cargo fmt`, `cargo clippy`, `cargo test` — default config, no custom rustfmt/clippy settings.

**Port 1420 is contractual**: `vite.config.ts` `strictPort` must match `tauri.conf.json` `build.devUrl`. Never change one without the other.

## Code Conventions & Common Patterns

- **Vue**: `<script setup lang="ts">`, `ref()` for local state, camelCase identifiers, double quotes; forms via `@submit.prevent` + async handler wrapping `invoke`.
- **Styling**: plain CSS only (no Tailwind) — `<style scoped>` per component plus a global `<style>` block with `prefers-color-scheme` dark-mode support (see `src/App.vue`).
- **Rust commands**: snake_case names; keep them in `lib.rs` and register each in `generate_handler!`. Template commands return plain values; adopt `Result<T, E>` when real error handling is needed (current code only `.expect()`s at startup).
- **Rust naming**: package `eye-guard` (kebab), lib `eye_guard_lib` (snake, set in `Cargo.toml [lib]`) — keep in sync with the `use eye_guard_lib::...` in `main.rs`.
- **TS strictness**: `strict`, `noUnusedLocals`, `noUnusedParameters`, `isolatedModules` — dead/unused code fails `pnpm build`.
- **localStorage 键**：统一 `eye-guard.` 前缀 — `workMin` / `breakMin` / `longBreakMin` / `cyclesPerLongBreak`（设置持久化，`cyclesPerLongBreak` 为 `0` 表示禁用长休息——UI 由它反推勾选态）、`stats`（每日完成轮数，`src/stats.ts` 管理 30 天滚动窗口；旧键 `todayStats` 首次读取自动迁移）、`lockMessage`（LockScreen 自定义文案接入点：设置该键即覆盖锁屏默认提示）。
- **诊断日志**：Rust 侧统一 `eprintln!("[eg] ...")`，无日志框架。

## Important Files

- `src/App.vue` — window-label dispatcher (`main` → TimerPanel, `lock-*` → LockScreen) + global styles.
- `src-tauri/src/lib.rs` — timer state machine, worker thread, overlay/tray management, plugins (`tauri_plugin_single_instance` — must register first, 支持 `--break` argv 转发, `tauri_plugin_autostart` — tray 开机自启 toggle, `tauri_plugin_global_shortcut` — `break_shortcut()` = Alt+Shift+B 触发立即休息, Linux-Wayland 下不可用需桌面快捷键 + `--break`, `tauri_plugin_opener`, `tauri_plugin_notification`), command registry, `#[cfg(test)]` unit tests.
- `src-tauri/tauri.conf.json` — identity (`com.zhuchentong.eye-guard`), single 800×600 window (label `main`), bundling; `csp` currently `null`.
- `src-tauri/Cargo.toml` — deps: `tauri 2` (`tray-icon` feature), `tauri-plugin-opener`, `tauri-plugin-notification`, `parking_lot`, `serde`/`serde_json`; Linux-gated (`cfg(target_os = "linux")`): `gtk`/`gdk` 0.18 + `gtk-layer-shell` 0.8 (`v0_5` feature, for Wayland per-monitor lock overlays); dev-dep `tauri` with `test` feature (mock runtime); hardened release profile (lto, `panic="abort"`, strip).
- `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json` — build/typecheck config.
- `package.json` — scripts and dependency versions.

## Runtime/Tooling Preferences

- Node side: pnpm, ESM (`"type": "module"`); never npm/yarn (lockfile drift). Tauri CLI via `pnpm tauri`.
- pnpm 12 的设置与 overrides 唯一读取位置是 `pnpm-workspace.yaml`（package.json 的 `pnpm` 字段已废弃不再读取）。仓库显式声明 `minimumReleaseAge: 1440`（拒绝发布不足 24 h 的包版本，CI 同策略）；`tldts`/`tldts-core` 钉 7.4.16 是为绕开 2026-10-07 双发的过新版本，老化后可移除。
- Rust: edition 2021.
- `vite.config.ts` ignores `src-tauri/**` in its watcher — backend changes need a `pnpm tauri dev` restart.
- Do not edit: `pnpm-lock.yaml`, `src-tauri/gen/`, `src-tauri/icons/`, `src-tauri/target/`.
- Recommended VS Code extensions (`.vscode/extensions.json`): Volar, tauri-vscode, rust-analyzer.

## Testing & QA

- **Rust unit tests exist** in `src-tauri/src/lib.rs` (`#[cfg(test)] mod tests`, 10 tests): 两条 `pace_tick` 网格测试（秒级）+ zero-duration rejection、`end_break_early` guard、idle→break worker spawn + auto-cycle、running-timer break takeover、pause 冻结/恢复 + break 相位拒绝、`tray_title` 纯函数（相位/paused/补零格式）。4 条时序测试跑真实 1 s tick（配置已缩短至 work 4s / break 2s 量级）— 整套实测约 7 s，且 `idle_break_spawns_worker_and_auto_cycles` 会触发真实 dbus 通知。单个测试：`cargo test <name>`。
- **Frontend tests** in `src/stats.test.ts` — vitest run（jsdom，14 条）覆盖 `src/stats.ts` 统计逻辑（跨日累加、30 天裁剪、legacy 迁移、容错）。仍无 JS linter/formatter setup。
- QA gates: `pnpm test`（vitest）、`vue-tsc --noEmit` inside `pnpm build`；`cargo clippy --all-targets` (zero warnings expected; repo rule: use `parking_lot::Mutex`, never `.lock().unwrap()`).