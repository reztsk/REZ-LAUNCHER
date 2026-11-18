//! Known PC game launchers: official download pages + read-only install detection.
//!
//! Detection order (all read-only): the launcher's own registry keys, then the
//! Windows "Apps & features" entry, then usual folders on every drive and in
//! the user's AppData.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::sysreg::{self, Hive, UninstallEntry};

/// A registry value pointing at the launcher: its exe, or its install folder.
pub struct RegHint {
    pub hive: Hive,
    pub path: &'static str,
    pub value: &'static str,
    /// The value is a folder (exe resolved with `exe_rel`), not the exe itself.
    pub is_dir: bool,
}

const fn reg(hive: Hive, path: &'static str, value: &'static str, is_dir: bool) -> RegHint {
    RegHint {
        hive,
        path,
        value,
        is_dir,
    }
}

pub struct LauncherDef {
    pub id: &'static str,
    pub name: &'static str,
    pub publisher: &'static str,
    pub download_url: &'static str,
    /// Folder name we recommend inside `<Drive>:\Jeux\`.
    pub recommended_folder: &'static str,
    /// Install folder names commonly used (relative to a root such as Program Files).
    pub folders: &'static [&'static str],
    /// Executable path relative to the install folder.
    pub exe_rel: &'static [&'static str],
    /// Registry values written by the launcher's installer.
    pub reg: &'static [RegHint],
    /// "Apps & features" display names (lowercase, exact match).
    pub uninstall_names: &'static [&'static str],
}

pub const LAUNCHERS: &[LauncherDef] = &[
    LauncherDef {
        id: "steam",
        name: "Steam",
        publisher: "Valve",
        download_url: "https://store.steampowered.com/about/",
        recommended_folder: "Steam",
        folders: &["Steam"],
        exe_rel: &["steam.exe"],
        reg: &[
            reg(
                Hive::CurrentUser,
                r"Software\Valve\Steam",
                "SteamExe",
                false,
            ),
            reg(
                Hive::CurrentUser,
                r"Software\Valve\Steam",
                "SteamPath",
                true,
            ),
            reg(
                Hive::LocalMachine,
                r"SOFTWARE\WOW6432Node\Valve\Steam",
                "InstallPath",
                true,
            ),
            reg(
                Hive::LocalMachine,
                r"SOFTWARE\Valve\Steam",
                "InstallPath",
                true,
            ),
        ],
        uninstall_names: &["steam"],
    },
    LauncherDef {
        id: "epic",
        name: "Epic Games",
        publisher: "Epic Games",
        download_url: "https://store.epicgames.com/download",
        recommended_folder: "EpicGames",
        folders: &["Epic Games", "EpicGames"],
        exe_rel: &[
            r"Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe",
            r"Launcher\Portal\Binaries\Win32\EpicGamesLauncher.exe",
        ],
        reg: &[],
        uninstall_names: &["epic games launcher"],
    },
    LauncherDef {
        id: "battlenet",
        name: "Battle.net",
        publisher: "Blizzard",
        download_url: "https://www.blizzard.com/download/",
        recommended_folder: "BattleNet",
        folders: &["Battle.net", "BattleNet"],
        exe_rel: &["Battle.net Launcher.exe", "Battle.net.exe"],
        reg: &[reg(
            Hive::LocalMachine,
            r"SOFTWARE\WOW6432Node\Blizzard Entertainment\Battle.net\Capabilities",
            "ApplicationIcon",
            false,
        )],
        uninstall_names: &["battle.net"],
    },
    LauncherDef {
        id: "ubisoft",
        name: "Ubisoft Connect",
        publisher: "Ubisoft",
        download_url: "https://ubisoftconnect.com/",
        recommended_folder: "UbisoftConnect",
        folders: &[
            r"Ubisoft\Ubisoft Game Launcher",
            "Ubisoft Game Launcher",
            "UbisoftConnect",
            "Ubisoft Connect",
        ],
        exe_rel: &["UbisoftConnect.exe", "upc.exe"],
        reg: &[
            reg(
                Hive::LocalMachine,
                r"SOFTWARE\WOW6432Node\Ubisoft\Launcher",
                "InstallDir",
                true,
            ),
            reg(
                Hive::LocalMachine,
                r"SOFTWARE\Ubisoft\Launcher",
                "InstallDir",
                true,
            ),
        ],
        uninstall_names: &["ubisoft connect", "uplay"],
    },
    LauncherDef {
        id: "gog",
        name: "GOG Galaxy",
        publisher: "GOG",
        download_url: "https://www.gog.com/galaxy",
        recommended_folder: "GOGGalaxy",
        folders: &["GOG Galaxy", "GOGGalaxy"],
        exe_rel: &["GalaxyClient.exe"],
        reg: &[
            reg(
                Hive::LocalMachine,
                r"SOFTWARE\WOW6432Node\GOG.com\GalaxyClient\paths",
                "client",
                true,
            ),
            reg(
                Hive::LocalMachine,
                r"SOFTWARE\GOG.com\GalaxyClient\paths",
                "client",
                true,
            ),
        ],
        uninstall_names: &["gog galaxy"],
    },
    LauncherDef {
        id: "ea",
        name: "EA app",
        publisher: "Electronic Arts",
        download_url: "https://www.ea.com/ea-app",
        recommended_folder: "EAapp",
        folders: &[
            r"Electronic Arts\EA Desktop\EA Desktop",
            r"EA Desktop\EA Desktop",
            r"EAapp\EA Desktop",
        ],
        exe_rel: &["EADesktop.exe", r"EA Desktop\EADesktop.exe"],
        reg: &[
            reg(
                Hive::LocalMachine,
                r"SOFTWARE\Electronic Arts\EA Desktop",
                "DesktopAppPath",
                false,
            ),
            reg(
                Hive::LocalMachine,
                r"SOFTWARE\Electronic Arts\EA Desktop",
                "InstallLocation",
                true,
            ),
            reg(
                Hive::LocalMachine,
                r"SOFTWARE\WOW6432Node\Electronic Arts\EA Desktop",
                "InstallLocation",
                true,
            ),
        ],
        uninstall_names: &["ea app", "ea"],
    },
    LauncherDef {
        id: "rockstar",
        name: "Rockstar Games",
        publisher: "Rockstar Games",
        download_url: "https://www.rockstargames.com/downloads",
        recommended_folder: "RockstarGames",
        folders: &[
            r"Rockstar Games\Launcher",
            r"RockstarGames\Launcher",
            "RockstarGames",
        ],
        exe_rel: &["Launcher.exe", "LauncherPatcher.exe"],
        reg: &[
            reg(
                Hive::LocalMachine,
                r"SOFTWARE\WOW6432Node\Rockstar Games\Launcher",
                "InstallFolder",
                true,
            ),
            reg(
                Hive::LocalMachine,
                r"SOFTWARE\Rockstar Games\Launcher",
                "InstallFolder",
                true,
            ),
        ],
        uninstall_names: &["rockstar games launcher"],
    },
];

#[derive(Debug, Clone, Serialize)]
pub struct LauncherInfo {
    pub id: String,
    pub name: String,
    pub publisher: String,
    pub download_url: String,
    pub recommended_folder: String,
    /// Detected executable, if the launcher is installed in a known place.
    pub detected_exe: Option<String>,
}

pub fn find(id: &str) -> AppResult<&'static LauncherDef> {
    LAUNCHERS
        .iter()
        .find(|l| l.id == id)
        .ok_or_else(|| AppError::Invalid(format!("Launcher inconnu : {id}")))
}

/// Candidate roots on one drive where launchers usually end up.
fn roots_for_drive(drive: &Path) -> Vec<PathBuf> {
    [
        "Program Files (x86)",
        "Program Files",
        "",
        "Jeux",
        "Games",
        r"Jeux\Launchers",
        r"Games\Launchers",
    ]
    .iter()
    .map(|r| {
        if r.is_empty() {
            drive.to_path_buf()
        } else {
            drive.join(r)
        }
    })
    .collect()
}

/// Per-user and machine-wide app folders (AppData, ProgramData).
fn env_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for var in ["LOCALAPPDATA", "APPDATA", "ProgramData"] {
        if let Some(v) = std::env::var_os(var) {
            let p = PathBuf::from(v);
            out.push(p.join("Programs"));
            out.push(p);
        }
    }
    out
}

pub fn candidate_paths(def: &LauncherDef, drives: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let roots = drives
        .iter()
        .flat_map(|d| roots_for_drive(d))
        .chain(env_roots());
    for root in roots {
        for folder in def.folders {
            for exe in def.exe_rel {
                out.push(root.join(folder).join(exe));
            }
        }
    }
    out
}

/// Fixed drives present on this machine (C: first).
pub fn local_drives() -> Vec<PathBuf> {
    if cfg!(windows) {
        (b'C'..=b'Z')
            .map(|l| PathBuf::from(format!("{}:\\", l as char)))
            .filter(|p| p.is_dir())
            .collect()
    } else {
        vec![PathBuf::from("/")]
    }
}

/// Exe of a launcher from a folder or a file path found in the registry.
fn exe_in(def: &LauncherDef, path: &Path, is_dir: bool) -> Option<PathBuf> {
    if !is_dir {
        return Some(path.to_path_buf()).filter(|p| p.is_file());
    }
    def.exe_rel
        .iter()
        .map(|rel| path.join(rel))
        .find(|p| p.is_file())
}

/// Find a launcher's exe. `reg` reads a registry value (injected for tests).
pub fn locate(
    def: &LauncherDef,
    reg: &dyn Fn(Hive, &str, &str) -> Option<String>,
    entries: &[UninstallEntry],
    drives: &[PathBuf],
) -> Option<PathBuf> {
    // 1. Keys written by the launcher's installer.
    for h in def.reg {
        let Some(v) = reg(h.hive, h.path, h.value) else {
            continue;
        };
        let p = if h.is_dir {
            Some(PathBuf::from(v.trim().trim_matches('"').replace('/', "\\")))
        } else {
            sysreg::exe_from_icon(&v.replace('/', "\\"))
        };
        if let Some(exe) = p.and_then(|p| exe_in(def, &p, h.is_dir)) {
            return Some(exe);
        }
    }
    // 2. "Apps & features" entry: its icon or install folder.
    let names: Vec<&str> = def
        .exe_rel
        .iter()
        .filter_map(|r| Path::new(r).file_name()?.to_str())
        .collect();
    for e in entries {
        if !def
            .uninstall_names
            .contains(&e.display_name.to_lowercase().as_str())
        {
            continue;
        }
        if let Some(exe) = sysreg::exe_from_icon(&e.display_icon) {
            let fname = exe.file_name().map(|f| f.to_string_lossy().to_lowercase());
            if fname.is_some_and(|f| names.iter().any(|n| n.eq_ignore_ascii_case(&f)))
                && exe.is_file()
            {
                return Some(exe);
            }
        }
        if !e.install_location.is_empty() {
            let dir = PathBuf::from(e.install_location.trim_matches('"'));
            let nested = def.folders.iter().map(|f| dir.join(f));
            if let Some(exe) = std::iter::once(dir.clone())
                .chain(nested)
                .find_map(|d| exe_in(def, &d, true))
            {
                return Some(exe);
            }
        }
    }
    // 3. Usual folders.
    candidate_paths(def, drives)
        .into_iter()
        .find(|p| p.is_file())
}

pub fn detect_all() -> Vec<LauncherInfo> {
    let drives = local_drives();
    let entries = sysreg::uninstall_entries();
    LAUNCHERS
        .iter()
        .map(|def| LauncherInfo {
            id: def.id.into(),
            name: def.name.into(),
            publisher: def.publisher.into(),
            download_url: def.download_url.into(),
            recommended_folder: def.recommended_folder.into(),
            detected_exe: locate(def, &sysreg::read_string, &entries, &drives)
                .map(|p| p.to_string_lossy().into_owned()),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_urls_are_https() {
        let mut ids: Vec<_> = LAUNCHERS.iter().map(|l| l.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), LAUNCHERS.len());
        assert!(LAUNCHERS
            .iter()
            .all(|l| l.download_url.starts_with("https://")));
    }

    #[test]
    fn find_rejects_unknown() {
        assert!(find("steam").is_ok());
        assert!(find("evil").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn candidates_cover_default_install() {
        let steam = find("steam").unwrap();
        let c = candidate_paths(steam, &[PathBuf::from(r"C:\")]);
        assert!(c.contains(&PathBuf::from(r"C:\Program Files (x86)\Steam\steam.exe")));
        assert!(c.contains(&PathBuf::from(r"C:\Jeux\Steam\steam.exe")));
    }

    #[test]
    fn finds_launchers_through_registry_and_uninstall_entries() {
        let t = tempfile::tempdir().unwrap();
        let steam_dir = t.path().join("Valve Steam");
        std::fs::create_dir_all(&steam_dir).unwrap();
        std::fs::write(steam_dir.join("steam.exe"), b"x").unwrap();
        let sd = steam_dir.to_string_lossy().into_owned();
        let reg = move |_: Hive, path: &str, value: &str| {
            (path.ends_with(r"Valve\Steam") && value == "SteamPath").then(|| sd.replace('\\', "/"))
        };
        let steam = find("steam").unwrap();
        assert_eq!(
            locate(steam, &reg, &[], &[]),
            Some(steam_dir.join("steam.exe"))
        );

        // EA app only known from "Apps & features".
        let ea_dir = t.path().join("Electronic Arts").join("EA Desktop");
        std::fs::create_dir_all(ea_dir.join("EA Desktop")).unwrap();
        std::fs::write(ea_dir.join(r"EA Desktop\EADesktop.exe"), b"x").unwrap();
        let entries = vec![UninstallEntry {
            display_name: "EA app".into(),
            install_location: ea_dir.to_string_lossy().into_owned(),
            ..Default::default()
        }];
        let none = |_: Hive, _: &str, _: &str| None;
        let ea = find("ea").unwrap();
        assert_eq!(
            locate(ea, &none, &entries, &[]),
            Some(ea_dir.join(r"EA Desktop\EADesktop.exe"))
        );
        // Another program's entry is never used.
        assert_eq!(locate(find("gog").unwrap(), &none, &entries, &[]), None);
    }

    #[test]
    fn detection_runs() {
        assert_eq!(detect_all().len(), LAUNCHERS.len());
    }
}
