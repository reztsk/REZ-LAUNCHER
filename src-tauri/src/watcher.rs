//! Launch games and measure exact playtime.
//!
//! Safety model (anti-ban): REZ launcher only starts the executable through the OS
//! (`std::process::Command`, or the Windows shell for shortcuts / UAC) and then
//! *observes* process lifetimes. It never opens a game process handle for
//! writing, never reads/writes its memory, never touches game files.
//!
//! Tracking: we poll the spawned child PID. Many games use a bootstrapper that
//! exits right away and starts the real game, so when the child is gone we
//! also look for any running process whose executable lives inside the game's
//! install directory (read-only process list via `sysinfo`).
//!
//! Window behaviour: until the game shows its first window (read-only list of
//! desktop windows, like Alt+Tab: no process handle is opened) the UI plays the
//! launch animation; then REZ launcher minimizes itself, and comes back when
//! the game closes.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{Category, Database, Game};
use crate::error::{AppError, AppResult};

/// Polling cadence of the session watcher.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub poll_every: Duration,
    pub heartbeat_every: Duration,
    /// Bootstrappers may need a moment before the real game process shows up.
    pub startup_grace: Duration,
    /// Consecutive "nothing alive" polls before we close the session.
    pub misses_to_stop: u32,
    /// Give up waiting for a game window after this long ("ready" anyway).
    pub ready_timeout: Duration,
}

pub const DEFAULT_TIMING: Timing = Timing {
    poll_every: Duration::from_secs(2),
    heartbeat_every: Duration::from_secs(15),
    startup_grace: Duration::from_secs(30),
    misses_to_stop: 2,
    ready_timeout: Duration::from_secs(25),
};

/// Delay between "game window is up" and minimizing, so the end of the
/// launch animation is visible.
const MINIMIZE_DELAY: Duration = Duration::from_millis(900);

#[derive(Debug, Clone, Serialize)]
pub struct RunningGame {
    pub game_id: i64,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GameStoppedPayload {
    pub game: Game,
    pub session_seconds: i64,
}

/// Emitted once the game shows a window (or after `ready_timeout`).
#[derive(Debug, Clone, Serialize)]
pub struct GameReadyPayload {
    pub game_id: i64,
    /// false when we stopped waiting without seeing a window.
    pub window: bool,
}

#[derive(Default)]
pub struct Tracker {
    running: Mutex<HashMap<i64, RunningGame>>,
}

impl Tracker {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<i64, RunningGame>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn list(&self) -> Vec<RunningGame> {
        self.lock().values().cloned().collect()
    }

    fn insert(&self, rg: RunningGame) -> bool {
        let mut map = self.lock();
        if map.contains_key(&rg.game_id) {
            return false;
        }
        map.insert(rg.game_id, rg);
        true
    }

    fn remove(&self, game_id: i64) {
        self.lock().remove(&game_id);
    }
}

/// Folder names too generic to be used as a "this game is still running" signal:
/// matching on them would count every other game/app in that folder.
const GENERIC_DIRS: &[&str] = &[
    "common",
    "steamapps",
    "steamlibrary",
    "steam",
    "games",
    "jeux",
    "game",
    "program files",
    "program files (x86)",
    "programdata",
    "epic games",
    "gog galaxy",
    "ubisoft",
    "ubisoft game launcher",
    "battle.net",
    "ea games",
    "origin games",
    "xboxgames",
    "windowsapps",
    "windows",
    "system32",
    "users",
    "desktop",
    "bureau",
    "downloads",
    "téléchargements",
    "documents",
    "appdata",
    "local",
    "roaming",
];

/// A directory is safe for process matching if it is absolute, at least two
/// levels below the drive root (e.g. `D:\Jeux\MyGame`) and not a generic folder.
pub fn is_safe_watch_dir(dir: &Path) -> bool {
    if !dir.is_absolute() {
        return false;
    }
    let depth = dir
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count();
    if depth < 2 {
        return false;
    }
    let last = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    !GENERIC_DIRS.contains(&last.as_str())
}

/// Pick the directory used for process matching.
pub fn watch_dir_for(game: &Game) -> Option<PathBuf> {
    let candidates = [
        PathBuf::from(&game.install_dir),
        Path::new(&game.executable_path)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default(),
    ];
    candidates
        .into_iter()
        .find(|p| !p.as_os_str().is_empty() && is_safe_watch_dir(p))
}

fn normalize(p: &Path) -> String {
    let s = p.to_string_lossy().replace('/', "\\");
    let s = s.trim_end_matches('\\');
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// True when `exe` is located inside `dir` (component-wise, case-insensitive on Windows).
pub fn path_is_inside(exe: &Path, dir: &Path) -> bool {
    let exe = normalize(exe);
    let dir = normalize(dir);
    exe.len() > dir.len() && exe.starts_with(&dir) && exe.as_bytes()[dir.len()] == b'\\'
}

fn is_ignored_helper(exe: &Path) -> bool {
    let name = exe
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    name.contains("crash") || name.contains("unins") || name.contains("reporter")
}

/// PIDs of the processes running from `dir` (read-only process list).
fn pids_inside(sys: &mut System, dir: &Path) -> Vec<u32> {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );
    let own_pid = std::process::id();
    sys.processes()
        .values()
        .filter(|p| {
            p.pid().as_u32() != own_pid
                && p.exe()
                    .is_some_and(|exe| path_is_inside(exe, dir) && !is_ignored_helper(exe))
        })
        .map(|p| p.pid().as_u32())
        .collect()
}

/// Read-only check of the desktop window list (EnumWindows, like Alt+Tab):
/// does one of `pids` own a visible, non-tool window of a real size?
#[cfg(windows)]
pub fn has_visible_window(pids: &[u32]) -> bool {
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible,
        GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };

    struct Search<'a> {
        pids: &'a [u32],
        found: bool,
    }

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: `lparam` is the `&mut Search` passed below, alive for the whole call.
        let search = unsafe { &mut *(lparam as *mut Search) };
        let mut pid = 0u32;
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        // SAFETY: plain queries on a window handle given by EnumWindows.
        let candidate = unsafe {
            GetWindowThreadProcessId(hwnd, &mut pid);
            search.pids.contains(&pid)
                && IsWindowVisible(hwnd) != 0
                && (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW) == 0
                && GetWindowRect(hwnd, &mut rect) != 0
        };
        if candidate && rect.right - rect.left >= 64 && rect.bottom - rect.top >= 64 {
            search.found = true;
            return 0; // stop enumerating
        }
        1
    }

    if pids.is_empty() {
        return false;
    }
    let mut search = Search { pids, found: false };
    // SAFETY: the callback only reads window properties; `search` outlives the call.
    unsafe {
        EnumWindows(Some(visit), &mut search as *mut Search as LPARAM);
    }
    search.found
}

#[cfg(not(windows))]
pub fn has_visible_window(_pids: &[u32]) -> bool {
    false
}

pub fn minimize_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }
}

pub fn restore_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Start the executable through the OS. Returns the child when we have one.
fn spawn(game: &Game) -> AppResult<Option<Child>> {
    let exe = Path::new(&game.executable_path);
    let ext = exe
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let work_dir = if Path::new(&game.install_dir).is_dir() {
        PathBuf::from(&game.install_dir)
    } else {
        exe.parent().map(Path::to_path_buf).unwrap_or_default()
    };

    // Shortcuts (.lnk / .url) need the Windows shell.
    if cfg!(windows) && matches!(ext.as_str(), "lnk" | "url") {
        shell_open(exe)?;
        return Ok(None);
    }

    let mut cmd = Command::new(exe);
    if work_dir.is_dir() {
        cmd.current_dir(&work_dir);
    }
    match cmd.spawn() {
        Ok(child) => Ok(Some(child)),
        // ERROR_ELEVATION_REQUIRED: let the shell show the UAC prompt.
        Err(e) if cfg!(windows) && e.raw_os_error() == Some(740) => {
            shell_open(exe)?;
            Ok(None)
        }
        Err(e) => Err(AppError::Other(format!(
            "Impossible de lancer le jeu : {e}"
        ))),
    }
}

/// Open a file with the OS shell (ShellExecute on Windows: handles shortcuts and
/// the UAC prompt; no `cmd.exe`, so no argument injection).
pub fn shell_open(path: &Path) -> AppResult<()> {
    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|e| AppError::Other(format!("Ouverture impossible : {e}")))
}

/// Launch a game and track its session in the background.
pub fn launch(
    app: AppHandle,
    db: Arc<Database>,
    tracker: Arc<Tracker>,
    game: Game,
) -> AppResult<RunningGame> {
    if game.category == Category::NotInstalled {
        return Err(AppError::Invalid(
            "Ce jeu est marqué « non installé ».".into(),
        ));
    }
    if game.executable_path.is_empty() || !Path::new(&game.executable_path).is_file() {
        return Err(AppError::Invalid(format!(
            "Exécutable introuvable : {}",
            game.executable_path
        )));
    }

    // Launchers (Steam, Epic…) live in the tray forever: launch, don't time.
    if game.category == Category::Launcher {
        spawn(&game)?;
        return Ok(RunningGame {
            game_id: game.id,
            started_at: crate::db::now_rfc3339(),
        });
    }

    let prefs = crate::settings::Settings::load(&db);
    let started_wall = chrono::Utc::now();
    let started_at = started_wall.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let running = RunningGame {
        game_id: game.id,
        started_at: started_at.clone(),
    };
    if !tracker.insert(running.clone()) {
        return Err(AppError::Invalid(format!(
            "{} est déjà en cours.",
            game.title
        )));
    }

    let child = match spawn(&game) {
        Ok(c) => c,
        Err(e) => {
            tracker.remove(game.id);
            return Err(e);
        }
    };
    let session_id = match db.start_session(game.id, &started_at) {
        Ok(id) => id,
        Err(e) => {
            tracker.remove(game.id);
            return Err(e);
        }
    };
    let _ = app.emit("game-started", &running);

    let game_id = game.id;
    // Without the launch animation there is nothing to wait for: step aside now.
    if prefs.minimize_on_launch && !prefs.launch_animation {
        minimize_main(&app);
    }
    let ready_app = app.clone();
    let on_ready: ReadyCallback = Box::new(move |window| {
        let _ = ready_app.emit("game-ready", GameReadyPayload { game_id, window });
        if prefs.minimize_on_launch && prefs.launch_animation {
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(MINIMIZE_DELAY).await;
                minimize_main(&ready_app);
            });
        }
    });

    let watch_dir = watch_dir_for(&game);
    tauri::async_runtime::spawn(async move {
        let session_seconds = watch_session(
            child,
            watch_dir,
            &db,
            session_id,
            started_wall,
            DEFAULT_TIMING,
            Some(on_ready),
        )
        .await;
        let ended = started_wall + chrono::Duration::seconds(session_seconds);
        let ended_at = ended.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        tracker.remove(game_id);
        match db.finish_session(session_id, &ended_at, session_seconds) {
            Ok(game) => {
                let _ = app.emit(
                    "game-stopped",
                    GameStoppedPayload {
                        game,
                        session_seconds,
                    },
                );
                if crate::settings::Settings::load(&db).restore_on_exit && tracker.list().is_empty()
                {
                    restore_main(&app);
                }
            }
            Err(e) => eprintln!("[rez] finish_session failed: {e}"),
        }
    });

    Ok(running)
}

/// Called once with `true` when a game window shows up, or `false` on timeout.
pub type ReadyCallback = Box<dyn FnOnce(bool) + Send>;

/// Poll until neither the child nor any process from the install dir is alive.
/// Returns the session length in seconds (up to the last time it was seen alive).
async fn watch_session(
    mut child: Option<Child>,
    watch_dir: Option<PathBuf>,
    db: &Database,
    session_id: i64,
    started_wall: chrono::DateTime<chrono::Utc>,
    t: Timing,
    mut on_ready: Option<ReadyCallback>,
) -> i64 {
    let start = Instant::now();
    let mut last_alive = start;
    let mut last_heartbeat = start;
    let mut misses = 0u32;
    let mut sys = System::new();

    loop {
        tokio::time::sleep(t.poll_every).await;

        let mut alive = false;
        let mut pids = Vec::new();
        if let Some(c) = child.as_mut() {
            match c.try_wait() {
                Ok(None) => {
                    alive = true;
                    pids.push(c.id());
                }
                _ => child = None,
            }
        }
        // While waiting for the game window, also list the install-dir processes
        // (the window often belongs to the real game, not the bootstrapper).
        if !alive || on_ready.is_some() {
            if let Some(dir) = &watch_dir {
                let inside = pids_inside(&mut sys, dir);
                alive |= !inside.is_empty();
                pids.extend(inside);
            }
        }

        let now = Instant::now();
        if on_ready.is_some() {
            let window = alive && has_visible_window(&pids);
            if window || now.duration_since(start) >= t.ready_timeout {
                if let Some(cb) = on_ready.take() {
                    cb(window);
                }
            }
        }
        if alive {
            last_alive = now;
            misses = 0;
        } else {
            misses += 1;
            if now.duration_since(start) >= t.startup_grace && misses >= t.misses_to_stop {
                break;
            }
        }

        if now.duration_since(last_heartbeat) >= t.heartbeat_every {
            last_heartbeat = now;
            let secs = last_alive.duration_since(start).as_secs() as i64;
            let at = (started_wall + chrono::Duration::seconds(secs))
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            if let Err(e) = db.heartbeat_session(session_id, &at, secs) {
                eprintln!("[rez] heartbeat failed: {e}");
            }
        }
    }

    last_alive.duration_since(start).as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn watch_dir_safety() {
        assert!(is_safe_watch_dir(Path::new(r"D:\Jeux\Hollow Knight")));
        assert!(is_safe_watch_dir(Path::new(
            r"C:\Program Files (x86)\Steam\steamapps\common\Celeste"
        )));
        assert!(!is_safe_watch_dir(Path::new(r"D:\")));
        assert!(!is_safe_watch_dir(Path::new(r"D:\Jeux")));
        assert!(!is_safe_watch_dir(Path::new(
            r"C:\Program Files (x86)\Steam\steamapps\common"
        )));
        assert!(!is_safe_watch_dir(Path::new(
            r"C:\Program Files\Epic Games"
        )));
        assert!(!is_safe_watch_dir(Path::new(r"relative\dir")));
    }

    #[cfg(windows)]
    #[test]
    fn inside_matching_is_component_wise() {
        let dir = Path::new(r"D:\Jeux\Game");
        assert!(path_is_inside(Path::new(r"d:\jeux\game\bin\Game.exe"), dir));
        assert!(path_is_inside(
            Path::new(r"D:\Jeux\Game\Game.exe"),
            Path::new(r"D:\Jeux\Game\")
        ));
        assert!(!path_is_inside(Path::new(r"D:\Jeux\Game2\Game.exe"), dir));
        assert!(!path_is_inside(Path::new(r"D:\Jeux\Game"), dir));
    }

    #[test]
    fn helpers_are_ignored() {
        assert!(is_ignored_helper(Path::new("UnityCrashHandler64.exe")));
        assert!(is_ignored_helper(Path::new("unins000.exe")));
        assert!(!is_ignored_helper(Path::new("Game.exe")));
    }

    #[cfg(windows)]
    #[test]
    fn launcher_watch_dir_falls_back_to_exe_parent() {
        let g = Game {
            id: 1,
            title: "T".into(),
            executable_path: r"D:\Jeux\Hero\bin\hero.exe".into(),
            install_dir: r"D:\Jeux".into(), // too generic -> rejected
            cover_image_url: String::new(),
            version: String::new(),
            playtime_minutes: 0,
            category: Category::Installed,
            added_at: String::new(),
            last_played_at: None,
            session_count: 0,
            exe_missing: false,
            description: String::new(),
            cover_zoom: 1.0,
            cover_x: 50.0,
            cover_y: 50.0,
            kind: crate::db::Kind::Game,
            collection: String::new(),
            platform: "pc".into(),
            sort_order: 0,
        };
        assert_eq!(watch_dir_for(&g), Some(PathBuf::from(r"D:\Jeux\Hero\bin")));
    }

    #[cfg(windows)]
    fn fast_timing() -> Timing {
        Timing {
            poll_every: Duration::from_millis(250),
            heartbeat_every: Duration::from_millis(500),
            startup_grace: Duration::from_millis(1500),
            misses_to_stop: 2,
            ready_timeout: Duration::from_millis(1200),
        }
    }

    #[cfg(windows)]
    fn setup_db() -> (Database, i64, i64, chrono::DateTime<chrono::Utc>) {
        let db = Database::open_in_memory().unwrap();
        let g = db
            .insert_game(crate::db::GameInput {
                title: "T".into(),
                executable_path: r"C:		.exe".into(),
                install_dir: String::new(),
                cover_image_url: String::new(),
                version: String::new(),
                category: Category::Installed,
                description: String::new(),
                cover_zoom: 1.0,
                cover_x: 50.0,
                cover_y: 50.0,
                kind: Default::default(),
                collection: String::new(),
            })
            .unwrap();
        let start = chrono::Utc::now();
        let sid = db.start_session(g.id, &crate::db::now_rfc3339()).unwrap();
        (db, g.id, sid, start)
    }

    /// Real process: the session lasts as long as the child PID lives.
    #[cfg(windows)]
    #[tokio::test]
    async fn tracks_real_child_process() {
        let (db, gid, sid, start) = setup_db();
        // ping -n 4 waits ~3 s.
        let child = Command::new("ping")
            .args(["-n", "4", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        // A console tool never shows a window: "ready" fires on timeout, once.
        let calls = Arc::new(Mutex::new(Vec::new()));
        let c2 = calls.clone();
        let on_ready: ReadyCallback = Box::new(move |w| c2.lock().unwrap().push(w));
        let secs = watch_session(
            Some(child),
            None,
            &db,
            sid,
            start,
            fast_timing(),
            Some(on_ready),
        )
        .await;
        assert!((2..=5).contains(&secs), "session lasted {secs}s");
        assert_eq!(*calls.lock().unwrap(), vec![false]);
        db.finish_session(sid, &crate::db::now_rfc3339(), secs)
            .unwrap();
        assert_eq!(db.total_session_seconds(gid).unwrap(), secs);
    }

    /// Bootstrapper: the spawned process exits at once, the real game keeps
    /// running from the install dir and must still be timed.
    #[cfg(windows)]
    #[tokio::test]
    async fn follows_game_started_by_a_bootstrapper() {
        let (db, _gid, sid, start) = setup_db();
        let dir = tempfile::tempdir().unwrap();
        let game_dir = dir.path().join("MyGame");
        std::fs::create_dir_all(&game_dir).unwrap();
        let windir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:Windows".into());
        let fake_game = game_dir.join("fakegame.exe");
        std::fs::copy(
            Path::new(&windir).join("System32").join("PING.EXE"),
            &fake_game,
        )
        .unwrap();

        // cmd exits immediately after detaching the "game" (~4 s).
        let mut boot = Command::new("cmd");
        boot.args(["/C", "start", "", "/B"])
            .arg(&fake_game)
            .args(["-n", "5", "127.0.0.1"]);
        boot.stdout(std::process::Stdio::null());
        let child = boot.spawn().unwrap();

        let secs = watch_session(
            Some(child),
            Some(game_dir.clone()),
            &db,
            sid,
            start,
            fast_timing(),
            None,
        )
        .await;
        assert!(
            (3..=7).contains(&secs),
            "session lasted {secs}s (bootstrapper not followed?)"
        );
    }

    /// A real top-level window of this process is seen; tool-less PIDs are not.
    #[cfg(windows)]
    #[test]
    fn sees_visible_windows_of_given_pids() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
        };
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        // SAFETY: standard window creation with a system class; destroyed below.
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                class.as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                0,
                0,
                320,
                240,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        assert!(!hwnd.is_null());
        assert!(has_visible_window(&[std::process::id()]));
        assert!(!has_visible_window(&[u32::MAX - 7]));
        assert!(!has_visible_window(&[]));
        // SAFETY: window created above on this thread.
        unsafe { DestroyWindow(hwnd) };
    }

    #[test]
    fn tracker_rejects_double_launch() {
        let t = Tracker::default();
        assert!(t.insert(RunningGame {
            game_id: 7,
            started_at: "x".into()
        }));
        assert!(!t.insert(RunningGame {
            game_id: 7,
            started_at: "y".into()
        }));
        t.remove(7);
        assert!(t.list().is_empty());
    }
}
