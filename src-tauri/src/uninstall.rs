//! Safe uninstall: run the game's OFFICIAL uninstaller, wait for it, then
//! remove the game from the library.
//!
//! REZ launcher never deletes game files itself. It only starts what the game's
//! installer registered (Windows "Apps & features" entry, Steam's own uninstall
//! page, or the `unins000.exe` shipped next to the game), with
//! `std::process::Command`, and watches the process list (read-only).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::db::Game;
use crate::detect::{self, key_for};
use crate::error::{AppError, AppResult};
use crate::launchers::LAUNCHERS;
use crate::sysreg::{self, UninstallEntry};

/// How a game gets uninstalled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Method {
    /// Steam's own uninstall dialog (`steam://uninstall/<appid>`).
    Steam(u32),
    /// Registered uninstaller: program + raw argument string.
    Command { program: PathBuf, args: String },
}

/// What the UI shows before confirming.
#[derive(Debug, Clone, Serialize)]
pub struct UninstallPlan {
    /// "steam" | "registry" | "inno"
    pub via: String,
    /// Human readable command / page that will be opened.
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UninstallFinished {
    pub game_id: i64,
    pub title: String,
    /// The game is gone from disk and was removed from the library.
    pub removed: bool,
}

fn alnum(s: &str) -> String {
    s.chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_lowercase()
}

/// Split a registered command line into program + raw arguments.
/// `"C:\a b\unins.exe" /SILENT` · `C:\x\uninstall.exe /S` · `MsiExec.exe /I{GUID}`
pub fn split_command(cmd: &str) -> Option<(PathBuf, String)> {
    let s = cmd.trim();
    if s.is_empty() {
        return None;
    }
    let (prog, rest) = if let Some(r) = s.strip_prefix('"') {
        let end = r.find('"')?;
        (&r[..end], &r[end + 1..])
    } else if let Some(i) = s.to_ascii_lowercase().find(".exe") {
        (&s[..i + 4], &s[i + 4..])
    } else {
        match s.find(char::is_whitespace) {
            Some(i) => (&s[..i], &s[i..]),
            None => (s, ""),
        }
    };
    let prog = prog.trim();
    if prog.is_empty() {
        return None;
    }
    let mut args = rest.trim().to_string();
    let is_msi = Path::new(prog).file_name().is_some_and(|f| {
        f.eq_ignore_ascii_case("msiexec.exe") || f.eq_ignore_ascii_case("msiexec")
    });
    if is_msi {
        // "/I{GUID}" opens the repair dialog; "/X{GUID}" uninstalls.
        args = args.replacen("/I{", "/X{", 1).replacen("/i{", "/X{", 1);
    }
    Some((PathBuf::from(prog), args))
}

/// Resolve a bare system program name (MsiExec.exe, RunDll32.exe) to System32.
fn resolve_program(p: &Path) -> Option<PathBuf> {
    if p.is_absolute() {
        return p.is_file().then(|| p.to_path_buf());
    }
    let name = p.file_name()?.to_string_lossy().to_lowercase();
    let name = if name.ends_with(".exe") {
        name
    } else {
        format!("{name}.exe")
    };
    if !["msiexec.exe", "rundll32.exe"].contains(&name.as_str()) {
        return None;
    }
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let full = root.join("System32").join(name);
    full.is_file().then_some(full)
}

/// Is this entry a launcher itself (never run a launcher's uninstaller for a game)?
fn is_launcher_entry(e: &UninstallEntry) -> bool {
    let n = e.display_name.to_lowercase();
    LAUNCHERS
        .iter()
        .any(|l| l.uninstall_names.contains(&n.as_str()))
}

/// The "Apps & features" entry of a game: same install folder, same exe as its
/// icon, or same name. Launchers' own entries are never matched.
pub fn matching_entry<'a>(
    game: &Game,
    entries: &'a [UninstallEntry],
) -> Option<&'a UninstallEntry> {
    let dirs: HashSet<String> = [
        Some(game.install_dir.as_str())
            .filter(|d| !d.is_empty())
            .map(|d| key_for(Path::new(d))),
        Path::new(&game.executable_path)
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(key_for),
    ]
    .into_iter()
    .flatten()
    .collect();
    let exe = game.executable_path.to_lowercase();
    let title = alnum(&game.title);
    let usable = |e: &&UninstallEntry| !e.uninstall_string.is_empty() && !is_launcher_entry(e);
    let by_dir = entries.iter().filter(usable).find(|e| {
        !e.install_location.is_empty()
            && dirs.contains(&key_for(Path::new(e.install_location.trim_matches('"'))))
    });
    let by_icon = || {
        entries.iter().filter(usable).find(|e| {
            !exe.is_empty()
                && sysreg::exe_from_icon(&e.display_icon)
                    .is_some_and(|p| p.to_string_lossy().to_lowercase() == exe)
        })
    };
    let by_name = || {
        entries
            .iter()
            .filter(usable)
            .find(|e| title.len() >= 3 && alnum(&e.display_name) == title)
    };
    by_dir.or_else(by_icon).or_else(by_name)
}

/// Inno Setup uninstaller shipped in the game folder (`unins000.exe`).
fn inno_uninstaller(game: &Game) -> Option<PathBuf> {
    let dir = if game.install_dir.is_empty() {
        Path::new(&game.executable_path).parent()?.to_path_buf()
    } else {
        PathBuf::from(&game.install_dir)
    };
    (0..10)
        .map(|i| dir.join(format!("unins{i:03}.exe")))
        .find(|p| p.is_file())
}

/// Find how to uninstall a game (`None`: no official uninstaller found).
pub fn find(game: &Game, entries: &[UninstallEntry]) -> Option<(Method, UninstallPlan)> {
    let steam = [game.install_dir.as_str(), game.executable_path.as_str()]
        .iter()
        .filter(|p| !p.is_empty())
        .find_map(|p| detect::steam_app_id(Path::new(p)));
    if let Some(id) = steam {
        return Some((
            Method::Steam(id),
            UninstallPlan {
                via: "steam".into(),
                detail: "Fenêtre de désinstallation de Steam".into(),
            },
        ));
    }
    if let Some(e) = matching_entry(game, entries) {
        if let Some((prog, args)) = split_command(&e.uninstall_string) {
            if let Some(program) = resolve_program(&prog) {
                return Some((
                    Method::Command { program, args },
                    UninstallPlan {
                        via: "registry".into(),
                        detail: e.uninstall_string.clone(),
                    },
                ));
            }
        }
    }
    inno_uninstaller(game).map(|p| {
        (
            Method::Command {
                program: p.clone(),
                args: String::new(),
            },
            UninstallPlan {
                via: "inno".into(),
                detail: p.to_string_lossy().into_owned(),
            },
        )
    })
}

/// Start the uninstaller. Returns its process id.
pub fn start(program: &Path, args: &str) -> AppResult<u32> {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if !args.is_empty() {
            cmd.raw_arg(args);
        }
    }
    #[cfg(not(windows))]
    if !args.is_empty() {
        cmd.args(args.split_whitespace());
    }
    if let Some(dir) = program.parent() {
        cmd.current_dir(dir);
    }
    match cmd.spawn() {
        Ok(child) => Ok(child.id()),
        // ERROR_ELEVATION_REQUIRED: the uninstaller asks for admin rights.
        #[cfg(windows)]
        Err(e) if e.raw_os_error() == Some(740) => start_elevated(program, args),
        Err(e) => Err(AppError::Other(format!(
            "Désinstallateur impossible à lancer : {e}"
        ))),
    }
}

/// Same, through the Windows UAC prompt (ShellExecuteEx "runas").
#[cfg(windows)]
fn start_elevated(program: &Path, args: &str) -> AppResult<u32> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::GetProcessId;
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    let wide = |s: &std::ffi::OsStr| s.encode_wide().chain([0]).collect::<Vec<u16>>();
    let verb = wide("runas".as_ref());
    let file = wide(program.as_os_str());
    let params = wide(args.as_ref());
    let dir = wide(program.parent().unwrap_or(Path::new("")).as_os_str());
    // SAFETY: zeroed is a valid SHELLEXECUTEINFOW; every pointer outlives the call.
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = params.as_ptr();
    info.lpDirectory = dir.as_ptr();
    info.nShow = 1; // SW_SHOWNORMAL
                    // SAFETY: `info` is fully initialised above.
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err(AppError::Invalid(
            "Désinstallation annulée (droits administrateur refusés).".into(),
        ));
    }
    // SAFETY: hProcess is a valid handle (SEE_MASK_NOCLOSEPROCESS), closed once.
    let pid = unsafe { GetProcessId(info.hProcess) };
    unsafe { CloseHandle(info.hProcess) };
    Ok(pid)
}

/// Wait for an uninstaller and every process it started (Inno Setup copies
/// itself to %TEMP% and exits at once). Read-only process list.
pub fn wait_process_tree(root_pid: u32, limit: Duration) {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let started = Instant::now();
    let mut tree: HashSet<Pid> = [Pid::from_u32(root_pid)].into();
    let mut sys = System::new();
    loop {
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        let procs = sys.processes();
        // Adopt children of tracked processes (until nothing new shows up).
        loop {
            let before = tree.len();
            for (pid, p) in procs {
                if p.parent().is_some_and(|pp| tree.contains(&pp)) {
                    tree.insert(*pid);
                }
            }
            if tree.len() == before {
                break;
            }
        }
        let alive = tree.iter().any(|p| procs.contains_key(p));
        if !alive || started.elapsed() > limit {
            return;
        }
        std::thread::sleep(Duration::from_millis(1500));
    }
}

/// After the uninstaller: is the game gone from disk?
pub fn is_gone(game: &Game) -> bool {
    let exe_gone = !game.executable_path.is_empty() && !Path::new(&game.executable_path).exists();
    let dir_gone = !game.install_dir.is_empty() && !Path::new(&game.install_dir).exists();
    exe_gone || dir_gone
}

/// Steam: wait until Steam removed the game (or give up after `limit`).
pub fn wait_until_gone(game: &Game, limit: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < limit {
        if is_gone(game) {
            return true;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    is_gone(game)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Category, Kind};

    fn game(title: &str, dir: &str, exe: &str) -> Game {
        Game {
            id: 1,
            title: title.into(),
            executable_path: exe.into(),
            install_dir: dir.into(),
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
            kind: Kind::Game,
            collection: String::new(),
            platform: "pc".into(),
            sort_order: 0,
        }
    }

    fn entry(name: &str, loc: &str, icon: &str, cmd: &str) -> UninstallEntry {
        UninstallEntry {
            display_name: name.into(),
            install_location: loc.into(),
            display_icon: icon.into(),
            uninstall_string: cmd.into(),
        }
    }

    #[test]
    fn splits_registered_command_lines() {
        assert_eq!(
            split_command(r#""C:\Jeux\My Game\unins000.exe" /SILENT"#),
            Some((
                PathBuf::from(r"C:\Jeux\My Game\unins000.exe"),
                "/SILENT".into()
            ))
        );
        assert_eq!(
            split_command(r"C:\Program Files\Game\uninstall.exe /S"),
            Some((
                PathBuf::from(r"C:\Program Files\Game\uninstall.exe"),
                "/S".into()
            ))
        );
        assert_eq!(
            split_command("MsiExec.exe /I{1234-ABCD}"),
            Some((PathBuf::from("MsiExec.exe"), "/X{1234-ABCD}".into()))
        );
        assert_eq!(split_command("   "), None);
        assert_eq!(split_command(r#""unterminated"#), None);
    }

    #[test]
    fn matches_the_right_entry_and_never_a_launcher() {
        let g = game(
            "Hollow Depths",
            r"D:\Jeux\Hollow Depths",
            r"D:\Jeux\Hollow Depths\hd.exe",
        );
        let entries = vec![
            // A launcher installed in a parent folder: must never be picked.
            entry(
                "Epic Games Launcher",
                r"D:\Jeux",
                "",
                "MsiExec.exe /X{EPIC}",
            ),
            entry(
                "Other",
                r"D:\Jeux\Other",
                "",
                r#""D:\Jeux\Other\unins000.exe""#,
            ),
            entry(
                "Hollow Depths",
                r"D:\Jeux\Hollow Depths\",
                "",
                r#""D:\Jeux\Hollow Depths\unins000.exe""#,
            ),
        ];
        assert_eq!(
            matching_entry(&g, &entries).unwrap().display_name,
            "Hollow Depths"
        );

        let by_icon = vec![entry(
            "HD v1.2",
            "",
            r#""D:\Jeux\Hollow Depths\hd.exe",0"#,
            "x.exe",
        )];
        assert_eq!(
            matching_entry(&g, &by_icon).unwrap().display_name,
            "HD v1.2"
        );

        let by_name = vec![entry("Hollow-Depths", "", "", "x.exe")];
        assert!(matching_entry(&g, &by_name).is_some());

        let nothing = vec![entry(
            "Steam",
            r"D:\Jeux\Hollow Depths",
            "",
            "steam.exe /uninstall",
        )];
        assert!(matching_entry(&g, &nothing).is_none());
    }

    #[test]
    fn finds_inno_uninstaller_in_game_folder() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("Neon");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("neon.exe"), b"x").unwrap();
        let g = game(
            "Neon",
            &dir.to_string_lossy(),
            &dir.join("neon.exe").to_string_lossy(),
        );
        assert!(find(&g, &[]).is_none());
        std::fs::write(dir.join("unins000.exe"), b"x").unwrap();
        let (m, plan) = find(&g, &[]).unwrap();
        assert_eq!(plan.via, "inno");
        assert_eq!(
            m,
            Method::Command {
                program: dir.join("unins000.exe"),
                args: String::new()
            }
        );
        assert!(!is_gone(&g));
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(is_gone(&g));
    }

    #[test]
    fn waits_for_a_real_process() {
        // Short-lived child: the wait returns as soon as it exits.
        let exe = if cfg!(windows) { "cmd" } else { "sh" };
        let arg = if cfg!(windows) { "/C" } else { "-c" };
        let mut child = std::process::Command::new(exe)
            .args([arg, "exit"])
            .spawn()
            .unwrap();
        let t = Instant::now();
        wait_process_tree(child.id(), Duration::from_secs(20));
        let _ = child.wait();
        assert!(t.elapsed() < Duration::from_secs(15));
    }
}
