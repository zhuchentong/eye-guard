# Repository Guidelines

## Project Overview

**eye-guard** (v0.1.0) is a cross-platform desktop app built with Tauri v2 + Vue 3 + TypeScript + Vite. Implemented feature: a pomodoro-style eye-rest timer — a Rust background thread counts work/break cycles, fires a system notification 30 s before break, pops frameless fullscreen **lock overlay windows** (one per monitor, label prefix `lock-*`) that cover the screen during breaks, and auto-loops to the next cycle. The app is tray-resident: closing the main window hides it, and the tray menu offers show/hide, "立即休息", and quit.

## Architecture & Data Flow

Two-process Tauri v2 app:

- **Frontend (webview)** — Vue 3 SFCs in `src/`, mounted by `src/main.ts` (`createApp(App).mount("#app")`). No router, no Pinia, no state library.
- **Backend (Rust)** — `src-tauri/src/main.rs` is a thin binary entry calling `eye_guard_lib::run()`; `src-tauri/src/lib.rs` builds the app via `tauri::Builder` and registers commands.
- **IPC bridge** — frontend calls Rust with `invoke("command_name", { camelCaseArgs })` from `@tauri-apps/api`; Rust exposes `#[tauri::command]` fns registered in `tauri::generate_handler![...]`. Commands: `start_pomodoro(work_secs, break_secs)`, `stop_pomodoro`, `get_status`, `end_break_early`, `start_break_now`.
- **Permissions** — frontend→backend access is gated by `src-tauri/capabilities/default.json` (`core:default` + `opener:default` on windows `main` **and `lock-*`** — the glob is required so overlay windows may `listen`/`invoke`). Any command/plugin needing non-default permissions requires a capability update.
- **State & events** — `TimerState` (managed in `lib.rs`) owns an `Arc<AtomicBool>` running flag, the worker `JoinHandle`, a `Mutex<PhaseStatus>` (`{running, phase: "idle"|"work"|"break", remaining_secs, cycle}`), and the `(work_secs, break_secs)` config. The clock lives in a **Rust std thread** (`run_cycles`, 1 s tick) — never move it to JS (throttled webview timers miss overlays). Backend emits `timer-tick` (every second) and `phase-changed` (phase transitions); frontends `listen` and render `PhaseStatus`. `App.vue` dispatches on `getCurrentWindow().label`: `main` → `TimerPanel`, `lock-*` → `LockScreen`.
- **Window management** — overlays are created on the **main thread** (`run_on_main_thread`) via `WebviewWindowBuilder`. On Linux + Wayland with a layer-shell-capable compositor (sway/wlroots, KWin), each overlay is initialized as a **layer surface** (`gtk-layer-shell`, Overlay layer, anchored to all edges of the matched `gdk::Monitor`) so dual-monitor setups get one lock window per output; the window is built `.visible(false)`, attached, then shown via GTK `show_all()` (Tauri's `show()` is event-loop-queued). All other platforms and the fallback path use `.fullscreen(true)` + `set_position` per monitor. Their `CloseRequested` is prevented (Alt-F4 cannot dismiss), and they are destroyed only by the timer (`close_lock_overlays`). Do NOT add `.resizable(false)` — on GTK-Wayland it clamps min=max and deadlocks the fullscreen configure handshake (window never maps). Main window `CloseRequested` hides to tray instead of exiting.

## Key Directories

- `src/` — Vue frontend: `App.vue` (window-label dispatcher), `components/TimerPanel.vue` (main timer UI), `components/LockScreen.vue` (fullscreen break overlay), `types.ts` (`PhaseStatus` + `formatClock`), `main.ts` (entry), `vite-env.d.ts`.
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

## Important Files

- `src/App.vue` — window-label dispatcher (`main` → TimerPanel, `lock-*` → LockScreen) + global styles.
- `src-tauri/src/lib.rs` — timer state machine, worker thread, overlay/tray management, plugins (`tauri_plugin_opener`, `tauri_plugin_notification`), command registry, `#[cfg(test)]` unit tests.
- `src-tauri/tauri.conf.json` — identity (`com.zhuchentong.eye-guard`), single 800×600 window (label `main`), bundling; `csp` currently `null`.
- `src-tauri/Cargo.toml` — deps: `tauri 2` (`tray-icon` feature), `tauri-plugin-opener`, `tauri-plugin-notification`, `parking_lot`, `serde`/`serde_json`; Linux-gated (`cfg(target_os = "linux")`): `gtk`/`gdk` 0.18 + `gtk-layer-shell` 0.8 (`v0_5` feature, for Wayland per-monitor lock overlays); dev-dep `tauri` with `test` feature (mock runtime); hardened release profile (lto, `panic="abort"`, strip).
- `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json` — build/typecheck config.
- `package.json` — scripts and dependency versions.

## Runtime/Tooling Preferences

- Node side: pnpm, ESM (`"type": "module"`); never npm/yarn (lockfile drift). Tauri CLI via `pnpm tauri`.
- Rust: edition 2021.
- `vite.config.ts` ignores `src-tauri/**` in its watcher — backend changes need a `pnpm tauri dev` restart.
- Do not edit: `pnpm-lock.yaml`, `src-tauri/gen/`, `src-tauri/icons/`, `src-tauri/target/`.
- Recommended VS Code extensions (`.vscode/extensions.json`): Volar, tauri-vscode, rust-analyzer.

## Testing & QA

- **Rust unit tests exist** in `src-tauri/src/lib.rs` (`#[cfg(test)] mod tests`, 4 tests): zero-duration rejection, `end_break_early` guard, idle→break worker spawn + auto-cycle, and running-timer break takeover. They use the `tauri::test` mock runtime (dev-dependency) and real 1 s ticks — expect ~15 s total runtime; one test triggers a real dbus notification.
- **No frontend tests** and no JS linter/formatter setup.
- QA gates: `vue-tsc --noEmit` inside `pnpm build`; `cargo clippy --all-targets` (zero warnings expected; repo rule: use `parking_lot::Mutex`, never `.lock().unwrap()`).
- Frontend tests would require adding devDeps `vitest`, `@vue/test-utils`, `jsdom` and a `"test": "vitest"` script (optionally a `test` block in `vite.config.ts` with `environment: "jsdom"`).
