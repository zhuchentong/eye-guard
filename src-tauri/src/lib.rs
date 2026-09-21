use std::sync::atomic::{AtomicBool, Ordering};
use parking_lot::Mutex;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

#[derive(Clone, Debug, serde::Serialize)]
struct PhaseStatus {
    running: bool,
    /// "idle" | "work" | "break"
    phase: String,
    remaining_secs: u64,
    cycle: u64,
}

struct TimerState {
    running: Arc<AtomicBool>,
    handle: Mutex<Option<JoinHandle<()>>>,
    status: Mutex<PhaseStatus>,
    /// (work_secs, break_secs)，start_pomodoro 时写入
    config: Mutex<(u64, u64)>,
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
            }),
            config: Mutex::new((1500, 300)),
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
    status.remaining_secs = state.config.lock().0;
    let _ = app.emit("phase-changed", status.clone());
}

/// 计时工作线程：每秒一 tick，始终以共享 status 为准（本地不缓存可变副本，
/// 这样 start_break_now 在运行中改写 status 也能被接管）。
fn run_cycles<R: tauri::Runtime>(
    app: AppHandle<R>,
    running: Arc<AtomicBool>,
    work_secs: u64,
    break_secs: u64,
    initial_phase: &str,
) {
    let Some(state) = app.try_state::<TimerState>() else {
        return;
    };
    {
        let mut status = state.status.lock();
        status.phase = initial_phase.to_string();
        status.remaining_secs = if initial_phase == "break" {
            break_secs
        } else {
            work_secs
        };
        status.running = true;
    }

    let mut last_phase = String::new();
    loop {
        thread::sleep(Duration::from_secs(1));
        if !running.load(Ordering::Relaxed) {
            return;
        }
        let (phase, remaining) = {
            let mut status = state.status.lock();
            status.remaining_secs = status.remaining_secs.saturating_sub(1);
            let _ = app.emit("timer-tick", status.clone());
            (status.phase.clone(), status.remaining_secs)
        };
        let phase_started = phase != last_phase;
        last_phase.clone_from(&phase);

        if phase == "work" {
            if remaining == 0 {
                show_lock_overlays(&app);
                let mut status = state.status.lock();
                // 期间 status 可能被并发改写（如 start_break_now），仅在仍是 work/0 时转换
                if status.phase == "work" && status.remaining_secs == 0 {
                    status.phase = "break".to_string();
                    status.remaining_secs = break_secs;
                    let _ = app.emit("phase-changed", status.clone());
                }
            } else if (phase_started && work_secs <= 30) || remaining == 30 {
                send_break_notice(&app);
            }
        } else if phase == "break" && remaining == 0 {
            finish_break(&state, &app);
        }
    }
}

/// 为每个显示器建一个 frameless 全屏遮罩窗口。
/// Wayland：忽略逐屏定位，落在焦点输出（已接受）；X11/Windows/macOS 逐屏覆盖。
fn show_lock_overlays<R: tauri::Runtime>(app: &AppHandle<R>) {
    // 经主窗口枚举显示器（主窗口仅隐藏不销毁，枚举不受关窗隐藏影响；
    // AppHandle 级 available_monitors 在 tauri test mock runtime 上未实现）
    let monitors = app
        .get_webview_window("main")
        .and_then(|w| w.available_monitors().ok())
        .unwrap_or_default();
    // GTK/Wayland 表面必须在主线程创建（计时器线程直接 build 无法映射）
    let app2 = app.clone();
    let result = app.run_on_main_thread(move || {
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
                // macOS 原生 fullscreen 会创建独立 Space 且切换慢，改用 bounds + 置顶
                .fullscreen(!cfg!(target_os = "macos"))
                .always_on_top(true)
                .build();
            match build {
                Ok(w) => {
                    let _ = w.set_position(*m.position());
                    #[cfg(target_os = "macos")]
                    {
                        let _ = w.set_size(*m.size());
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
    let (work_secs, break_secs) = *state.config.lock();
    {
        let mut status = state.status.lock();
        status.running = true;
        status.phase = "break".to_string();
        status.remaining_secs = break_secs;
    }
    if !was_running {
        state.running.store(true, Ordering::Relaxed);
        let running = state.running.clone();
        let app_for_thread = app.clone();
        *state.handle.lock() = Some(thread::spawn(move || {
            run_cycles(app_for_thread, running, work_secs, break_secs, "break");
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
    state: State<'_, TimerState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    if work_secs == 0 || break_secs == 0 {
        return Err("工作与休息时长必须大于 0 秒".into());
    }
    kill_worker(&state);
    close_lock_overlays(&app); // 休息中被重新开始时撤掉旧遮罩
    *state.config.lock() = (work_secs, break_secs);
    {
        let mut status = state.status.lock();
        status.running = true;
        status.phase = "work".to_string();
        status.remaining_secs = work_secs;
        status.cycle = 1;
    }
    state.running.store(true, Ordering::Relaxed);
    let _ = app.emit("phase-changed", status_snapshot(&state));
    let running = state.running.clone();
    *state.handle.lock() = Some(thread::spawn(move || {
        run_cycles(app, running, work_secs, break_secs, "work");
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(TimerState::default())
        .invoke_handler(tauri::generate_handler![
            start_pomodoro,
            stop_pomodoro,
            get_status,
            end_break_early,
            start_break_now
        ])
        .setup(|app| {
            let show_item = MenuItem::with_id(app, "show", "显示/隐藏窗口", true, None::<&str>)?;
            let break_item = MenuItem::with_id(app, "break", "立即休息", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &break_item, &quit_item])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => toggle_main_window(app),
                    "break" => {
                        let _ = trigger_break_now(app);
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

    fn app_with_state() -> (AppHandle<tauri::test::MockRuntime>, App<tauri::test::MockRuntime>) {
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
        let err = start_pomodoro(0, 60, state, app.clone()).unwrap_err();
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
            *state.config.lock() = (4, 2); // work 4s / break 2s，缩短测试时长
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
        start_pomodoro(60, 5, app.state(), app.clone()).expect("start failed");
        // 工作相位开始 1 tick 后仍在 work
        wait_for(&app, |s| s.phase == "work" && s.remaining_secs < 60);
        start_break_now(app.clone()).expect("start_break_now failed");
        wait_for(&app, |s| s.phase == "break" && s.remaining_secs < 5);
        // 休息结束自动循环回工作，cycle 递增
        wait_for(&app, |s| s.phase == "work" && s.cycle == 2);
        stop_pomodoro(app.state(), app.clone()).expect("stop failed");
    }
}
