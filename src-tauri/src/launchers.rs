//! Known PC game launchers: official download pages + read-only install detection.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};

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
    },
    LauncherDef {
        id: "battlenet",
        name: "Battle.net",
        publisher: "Blizzard",
        download_url: "https://www.blizzard.com/download/",
        recommended_folder: "BattleNet",
        folders: &["Battle.net", "BattleNet"],
        exe_rel: &["Battle.net Launcher.exe", "Battle.net.exe"],
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
    },
    LauncherDef {
        id: "gog",
        name: "GOG Galaxy",
        publisher: "GOG",
        download_url: "https://www.gog.com/galaxy",
        recommended_folder: "GOGGalaxy",
        folders: &["GOG Galaxy", "GOGGalaxy"],
        exe_rel: &["GalaxyClient.exe"],
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
        exe_rel: &["EADesktop.exe"],
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

pub fn candidate_paths(def: &LauncherDef, drives: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for drive in drives {
        for root in roots_for_drive(drive) {
            for folder in def.folders {
                for exe in def.exe_rel {
                    out.push(root.join(folder).join(exe));
                }
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

pub fn detect_all() -> Vec<LauncherInfo> {
    let drives = local_drives();
    LAUNCHERS
        .iter()
        .map(|def| LauncherInfo {
            id: def.id.into(),
            name: def.name.into(),
            publisher: def.publisher.into(),
            download_url: def.download_url.into(),
            recommended_folder: def.recommended_folder.into(),
            detected_exe: candidate_paths(def, &drives)
                .into_iter()
                .find(|p| p.is_file())
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
    fn detection_runs() {
        assert_eq!(detect_all().len(), LAUNCHERS.len());
    }
}
