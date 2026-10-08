use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

/// 全局快捷键：立即休息（Alt+Shift+B）。
/// 注意：Linux 全局快捷键依赖 X11 抓取，Wayland 合成器（如 sway）不转发；
/// Wayland 用户可改用桌面快捷键执行 `eye-guard --break`——参数会经单实例
/// 通道转发给运行中的实例（见 single-instance 回调）。
fn break_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyB)
}

#[derive(Clone, Debug, serde::Serialize)]
struct PhaseStatus {
    running: bool,
    /// "idle" | "work" | "break"
    phase: String,
    remaining_secs: u64,
    cycle: u64,
    /// phase == "break" 时：本次是否为长休息
    long_break: bool,
    /// 暂停中：倒计时冻结，相位保持不变
    paused: bool,
}

/// 计时配置，start_pomodoro 时写入
#[derive(Clone, Copy)]
struct TimerConfig {
    work_secs: u64,
    break_secs: u64,
    long_break_secs: u64,
    /// 每 N 轮工作后进入一次长休息
    cycles_per_long_break: u64,
}

struct TimerState {
    running: Arc<AtomicBool>,
    handle: Mutex<Option<JoinHandle<()>>>,
    status: Mutex<PhaseStatus>,
    config: Mutex<TimerConfig>,
}

impl Default for TimerState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            handle: Mutex::new(None),
            status: Mutex::new(PhaseStatus {
                running: false,
                phase: "idle".to_string(),
                remaining_secs: 0,
                cycle: 0,
                long_break: false,
                paused: false,
            }),
            config: Mutex::new(TimerConfig {
                work_secs: 1500,
                break_secs: 300,
                long_break_secs: 900,
                cycles_per_long_break: 4,
            }),
        }
    }
}

fn status_snapshot(state: &TimerState) -> PhaseStatus {
    state.status.lock().clone()
}

/// 停掉当前工作线程：置 running=false 后 join（上界约 1s）。
fn kill_worker(state: &TimerState) {
    state.running.store(false, Ordering::Relaxed);
    if let Some(handle) = state.handle.lock().take() {
        let _ = handle.join();
    }
}

fn send_break_notice<R: tauri::Runtime>(app: &AppHandle<R>) {
    let _ = app
        .notification()
        .builder()
        .title("eye-guard")
        .body("30 秒后休息")
        .show();
}

/// 休息结束的统一转换（自然到期与 end_break_early 共用）：
/// 撤遮罩 → cycle+1 → 回到 work。线程循环与命令都经 status 锁串行化。
fn finish_break<R: tauri::Runtime>(state: &TimerState, app: &AppHandle<R>) {
    let mut status = state.status.lock();
    if status.phase != "break" {
        return;
    }
    close_lock_overlays(app);
    status.cycle += 1;
    status.phase = "work".to_string();
    status.remaining_secs = state.config.lock().work_secs;
    status.long_break = false;
    status.paused = false;
    let _ = app.emit("phase-changed", status.clone());
}

// 以单调时钟锚定节拍：每 tick 落在精确的 1s 网格上，消除
// sleep(1s) + 处理耗时的累计漂移。Instant 基于 CLOCK_MONOTONIC，
// 不统计挂起时长——系统休眠时倒计时停在暂停点（产品决策），
// 唤醒后节拍自然续走，不追补真实时间。
fn pace_tick(next_tick: &mut Instant) {
    *next_tick += Duration::from_secs(1);
    let now = Instant::now();
    if *next_tick > now {
        thread::sleep(*next_tick - now);
    }
}

/// 计时工作线程：每秒一 tick，始终以共享 status 为准（本地不缓存可变副本，
/// 这样 start_break_now 在运行中改写 status 也能被接管）。
fn run_cycles<R: tauri::Runtime>(
    app: AppHandle<R>,
    running: Arc<AtomicBool>,
    config: TimerConfig,
    initial_phase: &str,
) {
    let Some(state) = app.try_state::<TimerState>() else {
        return;
    };
    {
        let mut status = state.status.lock();
        status.phase = initial_phase.to_string();
        status.remaining_secs = if initial_phase == "break" {
            config.break_secs
        } else {
            config.work_secs
        };
        status.running = true;
        status.long_break = false;
        status.paused = false; // 新线程从干净状态起步（当前 spawn 点均已清，防御性收敛不变量）
    }

    let mut last_phase = String::new();
    let mut next_tick = Instant::now();
    loop {
        pace_tick(&mut next_tick);
        if !running.load(Ordering::Relaxed) {
            return;
        }
        let (phase, remaining, paused) = {
            let mut status = state.status.lock();
            // 暂停时冻结递减；tick 仍按 1s 网格推进，恢复无需重新锚定 next_tick
            if !status.paused {
                status.remaining_secs = status.remaining_secs.saturating_sub(1);
            }
            let _ = app.emit("timer-tick", status.clone());
            (status.phase.clone(), status.remaining_secs, status.paused)
        };
        let phase_started = phase != last_phase;
        last_phase.clone_from(&phase);

        if paused {
            continue; // 暂停中不做相位转换（remaining 冻结，转换条件本也不成立）
        }
        if phase == "work" {
            if remaining == 0 {
                show_lock_overlays(&app);
                let mut status = state.status.lock();
                // 期间 status 可能被并发改写（如 start_break_now），仅在仍是 work/0 时转换
                if status.phase == "work" && status.remaining_secs == 0 {
                    // 每 N 轮工作进入一次长休息（cycle 即当前轮次）
                    let is_long = config.cycles_per_long_break > 0
                        && status.cycle % config.cycles_per_long_break == 0;
                    status.phase = "break".to_string();
                    status.long_break = is_long;
                    status.paused = false; // 相位转换重置暂停态（覆盖转换窗口内的竞态）
                    status.remaining_secs = if is_long {
                        config.long_break_secs
                    } else {
                        config.break_secs
                    };
                    let _ = app.emit("phase-changed", status.clone());
                }
            } else if (phase_started && config.work_secs <= 30) || remaining == 30 {
                send_break_notice(&app);
            }
        } else if phase == "break" && remaining == 0 {
            finish_break(&state, &app);
        }
    }
}

// —— Wayland：layer-shell 按显示器锚定（仅 Linux 编译）——

#[cfg(target_os = "linux")]
fn layer_shell_available() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some() && gtk_layer_shell::is_supported()
}

#[cfg(not(target_os = "linux"))]
fn layer_shell_available() -> bool {
    false
}

// 将窗口初始化为覆盖指定显示器的 layer-surface（Overlay 层、四边锚定、独占整屏）。
// 返回 true 表示已锚定并映射；false 由调用方回退到 fullscreen + set_position 常规路径。
#[cfg(target_os = "linux")]
fn attach_layer_monitor<R: tauri::Runtime>(
    wx: &tauri::WebviewWindow<R>,
    pos: (i32, i32),
    fallback_index: usize,
) -> bool {
    use gtk::prelude::*;
    use gtk_layer_shell::LayerShell as _;

    let Ok(gw) = wx.gtk_window() else {
        return false;
    };
    let display = gw.display();
    // tauri/tao 与 GDK 的枚举顺序不保证一致：按显示器左上角几何匹配，索引兜底
    let mut target = None;
    for mi in 0..display.n_monitors() {
        if let Some(gm) = display.monitor(mi) {
            let g = gm.geometry();
            if (g.x(), g.y()) == pos {
                target = Some(gm);
                break;
            }
        }
    }
    let Some(gm) = target.or_else(|| display.monitor(fallback_index as i32)) else {
        return false;
    };

    gw.init_layer_shell();
    gw.set_layer(gtk_layer_shell::Layer::Overlay);
    for edge in [
        gtk_layer_shell::Edge::Top,
        gtk_layer_shell::Edge::Bottom,
        gtk_layer_shell::Edge::Left,
        gtk_layer_shell::Edge::Right,
    ] {
        gw.set_anchor(edge, true);
    }
    gw.set_monitor(&gm);
    // -1：覆盖整块显示器，不为任何面板留位
    gw.set_exclusive_zone(-1);
    // Tauri 的 show() 经事件队列异步派发，而 layer 初始化必须在映射前完成；
    // 用 GTK 同步 show 立即映射窗口
    gw.show_all();
    gw.window().is_some()
}

/// 为每个显示器建一个 frameless 全屏遮罩窗口。
/// Linux + Wayland（合成器支持 layer-shell）：每窗口锚定到对应显示器（Overlay 层）；
/// 其余平台及回退路径：fullscreen + set_position 逐屏覆盖。
fn show_lock_overlays<R: tauri::Runtime>(app: &AppHandle<R>) {
    // 经主窗口枚举显示器（主窗口仅隐藏不销毁，枚举不受关窗隐藏影响；
    // AppHandle 级 available_monitors 在 tauri test mock runtime 上未实现）
    let monitors = app
        .get_webview_window("main")
        .and_then(|w| w.available_monitors().ok())
        .unwrap_or_default();
    if monitors.is_empty() {
        return; // 如 test mock runtime：无显示器枚举，跳过后续一切 GTK 探测
    }
    // GTK/Wayland 表面必须在主线程创建（计时器线程直接 build 无法映射）
    let app2 = app.clone();
    let result = app.run_on_main_thread(move || {
        // 仅 Wayland 且合成器支持 layer-shell 时走锚定路径
        let use_layer = layer_shell_available();
        for (i, m) in monitors.iter().enumerate() {
            let label = format!("lock-{i}");
            if app2.get_webview_window(&label).is_some() {
                continue; // 幂等
            }
            let url = WebviewUrl::App("index.html".into());
            let build = WebviewWindowBuilder::new(&app2, label.clone(), url)
                .decorations(false)
                // 注意：不可在此设 resizable(false)——GTK-Wayland 将其实现为 min=max 钳制，
                // 与 fullscreen 的 configure 握手互相等待，初始 commit 永不发生（窗口无法映射）。
                // 全屏无边框窗口本身不可被用户调整大小。
                .maximizable(false)
                .minimizable(false)
                .skip_taskbar(true)
                // layer 路径：先隐藏建窗，初始化 layer-shell 后同步映射；
                // 四边锚定即覆盖显示器，不走 fullscreen 的 configure 握手
                .visible(!use_layer)
                .fullscreen(!cfg!(target_os = "macos") && !use_layer)
                .always_on_top(!use_layer)
                .build();
            match build {
                Ok(w) => {
                    #[allow(unused_mut)]
                    let mut anchored = false;
                    #[cfg(target_os = "linux")]
                    if use_layer {
                        anchored = attach_layer_monitor(&w, (m.position().x, m.position().y), i);
                    }
                    if anchored {
                        eprintln!("[eg] {label} anchored via layer-shell");
                    } else {
                        let _ = w.set_position(*m.position());
                        #[cfg(target_os = "macos")]
                        {
                            let _ = w.set_size(*m.size());
                        }
                        let _ = w.show();
                    }
                    if i == 0 {
                        let _ = w.set_focus();
                    }
                    // 拦截用户关闭（Alt-F4），遮罩只由计时器控制生命周期
                    w.on_window_event(|e| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                            api.prevent_close();
                        }
                    });
                }
                Err(e) => eprintln!("[eg] build {label} failed: {e}"),
            }
        }
    });
    if let Err(e) = result {
        eprintln!("[eg] run_on_main_thread failed: {e}");
    }
}

fn close_lock_overlays<R: tauri::Runtime>(app: &AppHandle<R>) {
    for (label, w) in app.webview_windows() {
        if label.starts_with("lock-") {
            // close() 会被窗口自身的 prevent_close 拦截，必须 destroy()
            let _ = w.destroy();
        }
    }
}

/// 「立即休息」统一入口（命令与托盘共用）。
/// 计时器空闲时必须 spawn 工作线程，否则 status 只是数字、倒计时不会走。
fn trigger_break_now<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let Some(state) = app.try_state::<TimerState>() else {
        return Err("app state unavailable".into());
    };
    if state.status.lock().phase == "break" {
        return Ok(()); // 幂等
    }
    let was_running = state.running.load(Ordering::Relaxed);
    let config = *state.config.lock();
    {
        let mut status = state.status.lock();
        status.running = true;
        status.phase = "break".to_string();
        status.remaining_secs = config.break_secs;
        status.long_break = false;
        status.paused = false; // 接管时必须清 paused，否则工作线程冻结递减
    }
    if !was_running {
        state.running.store(true, Ordering::Relaxed);
        let running = state.running.clone();
        let app_for_thread = app.clone();
        *state.handle.lock() = Some(thread::spawn(move || {
            run_cycles(app_for_thread, running, config, "break");
        }));
    }
    show_lock_overlays(app);
    let _ = app.emit("phase-changed", status_snapshot(&state));
    Ok(())
}

fn toggle_main_window<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

#[tauri::command]
fn start_pomodoro<R: tauri::Runtime>(
    work_secs: u64,
    break_secs: u64,
    long_break_secs: u64,
    cycles_per_long_break: u64,
    state: State<'_, TimerState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    if work_secs == 0 || break_secs == 0 {
        return Err("工作与休息时长必须大于 0 秒".into());
    }
    // cycles_per_long_break 为 0 表示禁用长休息
    if cycles_per_long_break > 0 && long_break_secs == 0 {
        return Err("长休息时长必须大于 0 秒".into());
    }
    kill_worker(&state);
    close_lock_overlays(&app); // 休息中被重新开始时撤掉旧遮罩
    *state.config.lock() = TimerConfig {
        work_secs,
        break_secs,
        long_break_secs,
        cycles_per_long_break,
    };
    {
        let mut status = state.status.lock();
        status.running = true;
        status.phase = "work".to_string();
        status.remaining_secs = work_secs;
        status.cycle = 1;
        status.long_break = false;
        status.paused = false;
    }
    state.running.store(true, Ordering::Relaxed);
    let _ = app.emit("phase-changed", status_snapshot(&state));
    let config = *state.config.lock();
    let running = state.running.clone();
    *state.handle.lock() = Some(thread::spawn(move || {
        run_cycles(app, running, config, "work");
    }));
    Ok(())
}

#[tauri::command]
fn stop_pomodoro<R: tauri::Runtime>(
    state: State<'_, TimerState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    kill_worker(&state);
    // 中途停止也要撤掉遮罩
    close_lock_overlays(&app);
    let mut status = state.status.lock();
    status.running = false;
    status.phase = "idle".to_string();
    status.remaining_secs = 0;
    status.cycle = 0;
    status.paused = false;
    Ok(())
}

#[tauri::command]
fn get_status(state: State<'_, TimerState>) -> Result<PhaseStatus, String> {
    Ok(status_snapshot(&state))
}

#[tauri::command]
fn end_break_early<R: tauri::Runtime>(
    state: State<'_, TimerState>,
    app: AppHandle<R>,
) -> Result<PhaseStatus, String> {
    if state.status.lock().phase != "break" {
        return Err("not in break".into());
    }
    finish_break(&state, &app);
    Ok(status_snapshot(&state))
}

#[tauri::command]
fn start_break_now<R: tauri::Runtime>(app: AppHandle<R>) -> Result<(), String> {
    trigger_break_now(&app)
}

/// 暂停：仅工作相位可用（break 由锁屏接管，冻结会让遮罩停在满值）。
/// 相位不变，倒计时冻结。重复暂停幂等。
#[tauri::command]
fn pause_pomodoro<R: tauri::Runtime>(
    state: State<'_, TimerState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    {
        let mut status = state.status.lock();
        if status.phase != "work" {
            return Err("pause only allowed during work".into());
        }
        if status.paused {
            return Ok(());
        }
        status.paused = true;
    }
    let _ = app.emit("phase-changed", status_snapshot(&state));
    Ok(())
}

/// 恢复：继续递减。仅工作相位；未暂停时幂等。
#[tauri::command]
fn resume_pomodoro<R: tauri::Runtime>(
    state: State<'_, TimerState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    {
        let mut status = state.status.lock();
        if status.phase != "work" {
            return Err("resume only allowed during work".into());
        }
        if !status.paused {
            return Ok(());
        }
        status.paused = false;
    }
    let _ = app.emit("phase-changed", status_snapshot(&state));
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例必须最先注册：二次启动时唤出主窗口后立即退出新进程。
        // argv 支持 --break：配合桌面快捷键在 Wayland 下触发立即休息
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if argv.iter().any(|a| a == "--break") {
                let _ = trigger_break_now(app);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if shortcut == &break_shortcut() && event.state() == ShortcutState::Pressed {
                        let _ = trigger_break_now(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(TimerState::default())
        .invoke_handler(tauri::generate_handler![
            start_pomodoro,
            stop_pomodoro,
            get_status,
            end_break_early,
            start_break_now,
            pause_pomodoro,
            resume_pomodoro
        ])
        .setup(|app| {
            // 注册失败不致命：Wayland 合成器多不支持 X11 全局抓取（见 break_shortcut 注释）
            if let Err(e) = app.global_shortcut().register(break_shortcut()) {
                eprintln!("[eg] global shortcut register failed: {e}");
            }
            // 冷启动带 --break：启动应用后立即进入休息
            if std::env::args().skip(1).any(|a| a == "--break") {
                let _ = trigger_break_now(app.handle());
            }

            let show_item = MenuItem::with_id(app, "show", "显示/隐藏窗口", true, None::<&str>)?;
            let break_item = MenuItem::with_id(app, "break", "立即休息", true, None::<&str>)?;
            let autostart_checked = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart_item = CheckMenuItem::with_id(
                app,
                "autostart",
                "开机自启",
                true,
                autostart_checked,
                None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&show_item, &break_item, &autostart_item, &quit_item])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => toggle_main_window(app),
                    "break" => {
                        let _ = trigger_break_now(app);
                    }
                    "autostart" => {
                        // 点击后 CheckMenuItem 已自行切换勾选态，按新状态应用
                        let launcher = app.autolaunch();
                        let want_enable = !launcher.is_enabled().unwrap_or(false);
                        if let Err(e) = if want_enable {
                            launcher.enable()
                        } else {
                            launcher.disable()
                        } {
                            eprintln!("[eg] autostart toggle failed: {e}");
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 主窗口关窗隐藏到托盘；lock-* 窗口的拦截在各窗口自身 on_window_event
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::{App, AppHandle};

    #[test]
    fn pace_tick_anchors_to_one_second_grid() {
        let mut next = Instant::now();
        let t0 = Instant::now();
        for _ in 0..3 {
            pace_tick(&mut next);
        }
        // 锚定后 3 tick 与 3s 网格偏差极小（修复前每 tick 累积处理耗时漂移）
        let elapsed = t0.elapsed();
        assert!(
            elapsed >= Duration::from_millis(2950),
            "too fast: {elapsed:?}"
        );
        assert!(
            elapsed <= Duration::from_millis(3150),
            "too slow: {elapsed:?}"
        );
    }

    #[test]
    fn pace_tick_skips_sleep_when_behind_schedule() {
        // 落后网格（如处理超时/挂起恢复）时立即补发 tick，不再额外睡眠
        let mut next = Instant::now() - Duration::from_secs(2);
        let t0 = Instant::now();
        pace_tick(&mut next);
        assert!(t0.elapsed() < Duration::from_millis(100));
    }

    fn app_with_state() -> (
        AppHandle<tauri::test::MockRuntime>,
        App<tauri::test::MockRuntime>,
    ) {
        let app = mock_builder()
            .plugin(tauri_plugin_notification::init())
            .manage(TimerState::default())
            .build(mock_context(noop_assets()))
            .expect("failed to build mock app");
        (app.handle().clone(), app)
    }

    fn wait_for(app: &AppHandle<tauri::test::MockRuntime>, pred: impl Fn(&PhaseStatus) -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            let s = app.state::<TimerState>();
            if pred(&status_snapshot(&s)) {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for condition, status={:?}",
                status_snapshot(&s)
            );
            thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    fn rejects_zero_durations() {
        let (app, _app) = app_with_state();
        let state = app.state::<TimerState>();
        let err = start_pomodoro(0, 60, 900, 4, state, app.clone()).unwrap_err();
        assert!(err.contains("大于 0"));
    }

    #[test]
    fn end_break_early_rejects_when_not_in_break() {
        let (app, _app) = app_with_state();
        let state = app.state::<TimerState>();
        assert_eq!(
            end_break_early(state, app.clone()).unwrap_err(),
            "not in break"
        );
    }

    /// 关键并发路径：空闲时「立即休息」必须 spawn 工作线程（遮罩倒计时不得冻结），
    /// 且休息结束后自动循环进入下一轮工作。
    #[test]
    fn idle_break_spawns_worker_and_auto_cycles() {
        let (app, _app) = app_with_state();
        {
            let state = app.state::<TimerState>();
            *state.config.lock() = TimerConfig {
                work_secs: 4,
                break_secs: 2,
                long_break_secs: 8,
                cycles_per_long_break: 2,
            }; // work 4s / break 2s，缩短测试时长
        }
        start_break_now(app.clone()).expect("start_break_now failed");
        {
            let s = status_snapshot(&app.state::<TimerState>());
            assert_eq!(s.phase, "break");
            assert_eq!(s.remaining_secs, 2);
        }
        // 休息自然走完 → 自动进入下一轮工作
        wait_for(&app, |s| s.phase == "work" && s.cycle == 1);
        // end_break_early 在 break 内才能成功：跳过这一轮工作直接进下一轮休息
        stop_pomodoro(app.state(), app.clone()).expect("stop failed");
        let s = status_snapshot(&app.state::<TimerState>());
        assert_eq!(s.phase, "idle");
        assert!(!s.running);
    }

    /// 运行中的计时器被 start_break_now 接管：工作线程每 tick 以 status 为准。
    #[test]
    fn running_timer_takes_over_break() {
        let (app, _app) = app_with_state();
        start_pomodoro(60, 5, 30, 2, app.state(), app.clone()).expect("start failed");
        // 工作相位开始 1 tick 后仍在 work
        wait_for(&app, |s| s.phase == "work" && s.remaining_secs < 60);
        start_break_now(app.clone()).expect("start_break_now failed");
        wait_for(&app, |s| s.phase == "break" && s.remaining_secs < 5);
        // 休息结束自动循环回工作，cycle 递增
        wait_for(&app, |s| s.phase == "work" && s.cycle == 2);
        stop_pomodoro(app.state(), app.clone()).expect("stop failed");
    }

    /// 暂停冻结倒计时，恢复后继续递减。
    #[test]
    fn pause_freezes_and_resume_continues() {
        let (app, _app) = app_with_state();
        start_pomodoro(60, 5, 30, 2, app.state(), app.clone()).expect("start failed");
        wait_for(&app, |s| s.phase == "work" && s.remaining_secs < 60);
        pause_pomodoro(app.state(), app.clone()).expect("pause failed");
        let frozen = status_snapshot(&app.state::<TimerState>()).remaining_secs;
        assert!(frozen > 0);
        thread::sleep(Duration::from_millis(2300));
        let still = status_snapshot(&app.state::<TimerState>());
        assert!(still.paused, "status must report paused");
        assert_eq!(still.remaining_secs, frozen, "paused countdown must freeze");
        resume_pomodoro(app.state(), app.clone()).expect("resume failed");
        wait_for(&app, |s| s.remaining_secs < frozen);
        stop_pomodoro(app.state(), app.clone()).expect("stop failed");
    }

    /// 关键并发路径：暂停中被 start_break_now 接管时必须清除 paused，
    /// 否则工作线程继续冻结递减，休息倒计时会永久停在满值。
    #[test]
    fn break_takeover_clears_pause() {
        let (app, _app) = app_with_state();
        start_pomodoro(60, 4, 30, 2, app.state(), app.clone()).expect("start failed");
        wait_for(&app, |s| s.phase == "work" && s.remaining_secs < 60);
        pause_pomodoro(app.state(), app.clone()).expect("pause failed");
        start_break_now(app.clone()).expect("start_break_now failed");
        wait_for(&app, |s| s.phase == "break" && s.remaining_secs < 4);
        stop_pomodoro(app.state(), app.clone()).expect("stop failed");
    }

    /// 暂停仅在工作相位可用：break 相位（锁屏接管中）必须拒绝，
    /// 否则主窗口「继续」按钮不可用（phase !== 'work' 禁用），遮罩倒计时冻结在满值。
    #[test]
    fn pause_rejects_when_not_in_work() {
        let (app, _app) = app_with_state();
        start_break_now(app.clone()).expect("start_break_now failed");
        let err = pause_pomodoro(app.state(), app.clone()).unwrap_err();
        assert!(err.contains("work"));
        resume_pomodoro(app.state(), app.clone()).expect_err("resume must reject too");
        stop_pomodoro(app.state(), app.clone()).expect("stop failed");
    }
}
