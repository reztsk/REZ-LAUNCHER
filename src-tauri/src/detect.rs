//! Detection of installed games — strictly READ-ONLY.
//!
//! Sources (nothing is ever written, moved or executed):
//! - Steam: `libraryfolders.vdf` + `appmanifest_*.acf` (text files, read only)
//! - Epic Games: `ProgramData\Epic\EpicGamesLauncher\Data\Manifests\*.item` (JSON, read only)
//! - GOG Galaxy: `HKLM\SOFTWARE\WOW6432Node\GOG.com\Games` (registry, read only)
//! - User folders (e.g. `D:\Jeux`): one sub-folder = one game, main `.exe` picked by heuristic
//!
//! Only directory listings, file sizes and those manifest files are read.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::db::Detected;

/// Identity of a detection: lowercase install folder without trailing separator.
pub fn key_for(dir: &Path) -> String {
    let s = dir.to_string_lossy().replace('/', "\\");
    s.trim_end_matches('\\').to_lowercase()
}

/// Launcher clients themselves are not games.
const LAUNCHER_EXES: &[&str] = &[
    "steam.exe",
    "epicgameslauncher.exe",
    "battle.net.exe",
    "battle.net launcher.exe",
    "ubisoftconnect.exe",
    "upc.exe",
    "galaxyclient.exe",
    "eadesktop.exe",
    "origin.exe",
    "rez-launcher.exe",
];

/// Folders crossed (not proposed) when scanning user folders.
const CONTAINER_DIRS: &[&str] = &[
    "steam",
    "steamlibrary",
    "steamapps",
    "common",
    "epicgames",
    "epic games",
    "goggalaxy",
    "gog galaxy",
    "gog games",
    "battlenet",
    "battle.net",
    "ubisoftconnect",
    "ubisoft",
    "ubisoft game launcher",
    "eaapp",
    "ea games",
    "games",
    "jeux",
    "launchers",
    "xboxgames",
];

/// Sub-folders never searched for the main executable.
const SKIP_DIRS: &[&str] = &[
    "_commonredist",
    "commonredist",
    "redist",
    "redistributables",
    "directx",
    "vcredist",
    "dotnet",
    "support",
    "__installer",
    "installer",
    "installers",
    "easyanticheat",
    "battleye",
    "prereqs",
    "prerequisites",
    "monobleedingedge",
    "crashreporter",
    "engine",
    "tools",
    "logs",
    "saves",
    "cache",
    "shadercache",
    "screenshots",
    "mods",
];

/// Executables that are never "the game".
const EXE_BLACKLIST: &[&str] = &[
    "unins",
    "setup",
    "install",
    "redist",
    "vc_",
    "dxsetup",
    "dxwebsetup",
    "crash",
    "report",
    "helper",
    "update",
    "patch",
    "dotnet",
    "prereq",
    "easyanticheat",
    "beservice",
    "battleye",
    "cefprocess",
    "subprocess",
    "touchup",
    "cleanup",
    "physx",
    "notification",
    "overlay",
];

fn is_candidate_exe(name: &str) -> bool {
    let n = name.to_lowercase();
    n.ends_with(".exe")
        && !EXE_BLACKLIST.iter().any(|b| n.contains(b))
        && !LAUNCHER_EXES.contains(&n.as_str())
}

fn alnum(s: &str) -> String {
    s.chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_lowercase()
}

/// Secondary executables: kept only when nothing better exists.
const EXE_SECONDARY: &[&str] = &[
    "launcher",
    "console",
    "editor",
    "server",
    "benchmark",
    "tool",
    "config",
    "settings",
];

/// "Counter-Strike 2" -> "cs2", "Grand Theft Auto V" -> "gtav".
fn acronym(s: &str) -> String {
    s.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| {
            if w.chars().all(|c| c.is_ascii_digit()) {
                w.to_string()
            } else {
                w[..1].to_string()
            }
        })
        .collect::<String>()
        .to_lowercase()
}

/// How well an exe stem matches one of the names (folder, game title).
fn similarity(stem: &str, names: &[(String, String)]) -> u8 {
    if stem.is_empty() {
        return 0;
    }
    let mut best = 0;
    for (full, acro) in names {
        let s = if !full.is_empty() && (full.contains(stem) || stem.contains(full.as_str())) {
            3
        } else if acro.len() >= 2 && stem == acro {
            2
        } else if stem.len() >= 3 && full.starts_with(&stem[..3]) {
            1
        } else {
            0
        };
        best = best.max(s);
    }
    best
}

/// Pick the most likely main executable of a game folder (depth ≤ 3).
/// Ranking: not a secondary tool, name close to the folder name or the game
/// title (`hint`), then shallowest, then biggest.
pub fn main_exe(dir: &Path) -> Option<PathBuf> {
    main_exe_named(dir, None)
}

pub fn main_exe_named(dir: &Path, hint: Option<&str>) -> Option<PathBuf> {
    let folder_raw = dir.file_name()?.to_string_lossy().into_owned();
    let mut names = vec![(alnum(&folder_raw), acronym(&folder_raw))];
    if let Some(h) = hint {
        names.push((alnum(h), acronym(h)));
    }
    let mut best: Option<((bool, u8, i32, u64), PathBuf)> = None;
    let mut stack = vec![(dir.to_path_buf(), 0i32)];
    let mut budget = 4000usize; // bounded work, whatever the folder size
    while let Some((d, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            budget = budget.saturating_sub(1);
            if budget == 0 {
                return best.map(|b| b.1);
            }
            let Ok(ft) = e.file_type() else { continue };
            let name = e.file_name().to_string_lossy().into_owned();
            if ft.is_dir() {
                if depth < 3 && !SKIP_DIRS.contains(&name.to_lowercase().as_str()) {
                    stack.push((e.path(), depth + 1));
                }
            } else if ft.is_file() && is_candidate_exe(&name) {
                let stem = alnum(name.trim_end_matches(".exe").trim_end_matches(".EXE"));
                let primary = !EXE_SECONDARY.iter().any(|s| stem.contains(s));
                let sim = similarity(&stem, &names);
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                let score = (primary, sim, -depth, size);
                if best.as_ref().is_none_or(|(s, _)| score > *s) {
                    best = Some((score, e.path()));
                }
            }
        }
    }
    best.map(|b| b.1)
}

fn detected(title: &str, exe: &Path, dir: &Path, source: &str) -> Detected {
    Detected {
        key: key_for(dir),
        title: title.trim().to_string(),
        executable_path: exe.to_string_lossy().into_owned(),
        install_dir: dir.to_string_lossy().into_owned(),
        source: source.into(),
    }
}

// ------------------------------------------------------------------ Steam

/// Value of a `"key"  "value"` line in Valve's KeyValues text format.
fn vdf_value<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let mut parts = line.split('"').filter(|p| !p.trim().is_empty());
    if parts.next()?.eq_ignore_ascii_case(key) {
        parts.next()
    } else {
        None
    }
}

pub fn parse_library_folders(vdf: &str) -> Vec<PathBuf> {
    vdf.lines()
        .filter_map(|l| vdf_value(l.trim(), "path"))
        .map(|p| PathBuf::from(p.replace("\\\\", "\\")))
        .collect()
}

/// (name, installdir, fully installed?)
pub fn parse_app_manifest(acf: &str) -> Option<(String, String, bool)> {
    let mut name = None;
    let mut dir = None;
    let mut flags = 4u32;
    for l in acf.lines().map(str::trim) {
        if let Some(v) = vdf_value(l, "name") {
            name.get_or_insert_with(|| v.to_string());
        } else if let Some(v) = vdf_value(l, "installdir") {
            dir.get_or_insert_with(|| v.to_string());
        } else if let Some(v) = vdf_value(l, "StateFlags") {
            flags = v.parse().unwrap_or(4);
        }
    }
    Some((name?, dir?, flags & 4 == 4))
}

fn is_steam_tool(name: &str) -> bool {
    let n = name.to_lowercase();
    [
        "redistributable",
        "proton",
        "steam linux runtime",
        "steamworks",
        "dedicated server",
        "sdk",
    ]
    .iter()
    .any(|t| n.contains(t))
}

fn steam_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        use winreg::RegKey;
        if let Ok(k) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Valve\Steam") {
            if let Ok(p) = k.get_value::<String, _>("SteamPath") {
                roots.push(PathBuf::from(p.replace('/', "\\")));
            }
        }
        if let Ok(k) =
            RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\WOW6432Node\Valve\Steam")
        {
            if let Ok(p) = k.get_value::<String, _>("InstallPath") {
                roots.push(PathBuf::from(p));
            }
        }
    }
    roots
}

fn steam_games(skip: &HashSet<String>) -> Vec<Detected> {
    let mut libs: Vec<PathBuf> = Vec::new();
    for root in steam_roots() {
        libs.push(root.clone());
        if let Ok(vdf) = std::fs::read_to_string(root.join(r"steamapps\libraryfolders.vdf")) {
            libs.extend(parse_library_folders(&vdf));
        }
    }
    let mut seen = HashSet::new();
    libs.retain(|l| seen.insert(key_for(l)));

    let mut out = Vec::new();
    for lib in libs {
        let apps = lib.join("steamapps");
        let Ok(entries) = std::fs::read_dir(&apps) else {
            continue;
        };
        for e in entries.flatten() {
            let fname = e.file_name().to_string_lossy().to_lowercase();
            if !(fname.starts_with("appmanifest_") && fname.ends_with(".acf")) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(e.path()) else {
                continue;
            };
            let Some((name, installdir, complete)) = parse_app_manifest(&text) else {
                continue;
            };
            if !complete || is_steam_tool(&name) {
                continue;
            }
            let dir = apps.join("common").join(&installdir);
            if skip.contains(&key_for(&dir)) || !dir.is_dir() {
                continue;
            }
            if let Some(exe) = main_exe_named(&dir, Some(&name)) {
                out.push(detected(&name, &exe, &dir, "steam"));
            }
        }
    }
    out
}

// ------------------------------------------------------------------- Epic

pub fn parse_epic_manifest(json: &str) -> Option<(String, PathBuf, PathBuf)> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    if v.get("bIsIncompleteInstall").and_then(|b| b.as_bool()) == Some(true) {
        return None;
    }
    let is_game = v
        .get("AppCategories")
        .and_then(|c| c.as_array())
        .is_none_or(|cats| cats.iter().any(|c| c.as_str() == Some("games")));
    if !is_game {
        return None;
    }
    let name = v.get("DisplayName")?.as_str()?.to_string();
    let dir = PathBuf::from(v.get("InstallLocation")?.as_str()?);
    let exe = dir.join(v.get("LaunchExecutable")?.as_str()?);
    Some((name, dir, exe))
}

fn epic_games(skip: &HashSet<String>) -> Vec<Detected> {
    let base = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    let dir = base.join(r"Epic\EpicGamesLauncher\Data\Manifests");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| {
            e.path()
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("item"))
        })
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|t| parse_epic_manifest(&t))
        .filter(|(_, dir, exe)| !skip.contains(&key_for(dir)) && exe.is_file())
        .map(|(name, dir, exe)| detected(&name, &exe, &dir, "epic"))
        .collect()
}

// -------------------------------------------------------------------- GOG

fn gog_games(skip: &HashSet<String>) -> Vec<Detected> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        use winreg::RegKey;
        let Ok(root) =
            RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\WOW6432Node\GOG.com\Games")
        else {
            return out;
        };
        for id in root.enum_keys().flatten() {
            let Ok(k) = root.open_subkey(&id) else {
                continue;
            };
            let (Ok(name), Ok(exe), Ok(path)) = (
                k.get_value::<String, _>("gameName"),
                k.get_value::<String, _>("exe"),
                k.get_value::<String, _>("path"),
            ) else {
                continue;
            };
            let dir = PathBuf::from(path);
            let exe = PathBuf::from(exe);
            if !skip.contains(&key_for(&dir)) && exe.is_file() {
                out.push(detected(&name, &exe, &dir, "gog"));
            }
        }
    }
    let _ = skip;
    out
}

// ---------------------------------------------------------------- Folders

fn folder_games(root: &Path, depth: u32, skip: &HashSet<String>, out: &mut Vec<Detected>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for e in entries.flatten() {
        if !e.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let dir = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        let lower = name.to_lowercase();
        if lower.starts_with('.') || lower.starts_with('$') {
            continue;
        }
        if CONTAINER_DIRS.contains(&lower.as_str()) {
            if depth < 3 {
                folder_games(&dir, depth + 1, skip, out);
            }
            continue;
        }
        // A launcher install folder (steam.exe, GalaxyClient.exe…): look inside for
        // its game library, never propose the launcher itself.
        if LAUNCHER_EXES.iter().any(|x| dir.join(x).is_file()) {
            if depth < 3 {
                folder_games(&dir, depth + 1, skip, out);
            }
            continue;
        }
        if skip.contains(&key_for(&dir)) {
            continue;
        }
        if let Some(exe) = main_exe(&dir) {
            out.push(detected(&name, &exe, &dir, "folder"));
        }
    }
}

/// Scan every source. Folders whose key is in `skip` (already in the library or
/// already answered) are not inspected again, which keeps periodic scans cheap.
pub fn scan(search_paths: &[String], skip: &HashSet<String>) -> Vec<Detected> {
    let mut all = Vec::new();
    all.extend(steam_games(skip));
    all.extend(epic_games(skip));
    all.extend(gog_games(skip));
    for p in search_paths {
        folder_games(Path::new(p), 0, skip, &mut all);
    }
    // Same folder found by several sources: the first (launcher manifest) wins.
    let mut seen = HashSet::new();
    all.retain(|d| seen.insert(d.key.clone()));
    all
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(p: &Path, bytes: usize) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, vec![0u8; bytes]).unwrap();
    }

    #[test]
    fn parses_steam_files() {
        let vdf = r#""libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"label"		""
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
	}
}"#;
        assert_eq!(
            parse_library_folders(vdf),
            vec![
                PathBuf::from(r"C:\Program Files (x86)\Steam"),
                PathBuf::from(r"D:\SteamLibrary")
            ]
        );
        let acf = "\"AppState\"\n{\n\t\"appid\"\t\t\"620\"\n\t\"name\"\t\t\"Portal 2\"\n\t\"StateFlags\"\t\t\"4\"\n\t\"installdir\"\t\t\"Portal 2\"\n}";
        assert_eq!(
            parse_app_manifest(acf),
            Some(("Portal 2".into(), "Portal 2".into(), true))
        );
        let downloading = acf.replace("\"4\"", "\"1026\"");
        assert!(!parse_app_manifest(&downloading).unwrap().2);
        assert!(is_steam_tool("Steamworks Common Redistributables"));
        assert!(!is_steam_tool("Portal 2"));
    }

    #[test]
    fn parses_epic_manifest() {
        let ok = r#"{"DisplayName":"Hades","InstallLocation":"D:\\Jeux\\EpicGames\\Games\\Hades","LaunchExecutable":"x64\\Hades.exe","AppCategories":["public","games","applications"]}"#;
        let (name, dir, exe) = parse_epic_manifest(ok).unwrap();
        assert_eq!(name, "Hades");
        assert_eq!(dir, PathBuf::from(r"D:\Jeux\EpicGames\Games\Hades"));
        assert!(exe.ends_with(r"x64\Hades.exe"));
        let plugin = ok.replace(r#""games","#, "");
        assert!(parse_epic_manifest(&plugin).is_none());
        let partial = ok.replace('{', r#"{"bIsIncompleteInstall":true,"#);
        assert!(parse_epic_manifest(&partial).is_none());
    }

    #[test]
    fn picks_the_main_executable() {
        let t = tempfile::tempdir().unwrap();
        let g = t.path().join("Hollow Depths");
        touch(&g.join("unins000.exe"), 900);
        touch(&g.join("UnityCrashHandler64.exe"), 900);
        touch(&g.join(r"_CommonRedist\vcredist_x64.exe"), 9000);
        touch(&g.join("HollowDepths.exe"), 100);
        touch(&g.join(r"bin\tool.exe"), 5000);
        assert_eq!(main_exe(&g).unwrap(), g.join("HollowDepths.exe"));

        // No name match: shallowest, then biggest.
        let u = t.path().join("Some Game");
        touch(&u.join(r"Binaries\Win64\Shipping.exe"), 9000);
        touch(&u.join("start.exe"), 10);
        assert_eq!(main_exe(&u).unwrap(), u.join("start.exe"));

        let empty = t.path().join("Docs");
        fs::create_dir_all(&empty).unwrap();
        assert!(main_exe(&empty).is_none());

        // Real layouts seen in the wild: tools and launchers lose to the game,
        // and the Steam title's acronym identifies the exe (Counter-Strike 2 -> cs2).
        let cs = t.path().join("Counter-Strike Global Offensive");
        touch(&cs.join(r"game\bin\win64\vconsole2.exe"), 9000);
        touch(&cs.join(r"game\bin\win64\cs2.exe"), 100);
        assert_eq!(
            main_exe_named(&cs, Some("Counter-Strike 2")).unwrap(),
            cs.join(r"game\bin\win64\cs2.exe")
        );
        let cod = t.path().join("Call of Duty");
        touch(&cod.join("Call of Duty Launcher.exe"), 9000);
        touch(&cod.join(r"_retail_\cod.exe"), 100);
        assert_eq!(main_exe(&cod).unwrap(), cod.join(r"_retail_\cod.exe"));
        assert_eq!(acronym("Grand Theft Auto V"), "gtav");
    }

    #[test]
    fn scans_user_folders_through_launcher_layouts() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("Jeux");
        touch(&root.join(r"Neon Drift\NeonDrift.exe"), 10);
        touch(&root.join(r"EpicGames\Games\Circuit\Circuit.exe"), 10);
        // Launcher folders are crossed, never proposed.
        touch(&root.join(r"GOGGalaxy\GalaxyClient.exe"), 10);
        touch(&root.join(r"GOGGalaxy\Games\Hollow\hollow.exe"), 10);
        touch(&root.join(r"Known\known.exe"), 10);
        fs::create_dir_all(root.join("Empty")).unwrap();

        let skip: HashSet<String> = [key_for(&root.join("Known"))].into();
        let mut found = Vec::new();
        folder_games(&root, 0, &skip, &mut found);
        let mut titles: Vec<_> = found.iter().map(|d| d.title.as_str()).collect();
        titles.sort();
        assert_eq!(titles, vec!["Circuit", "Hollow", "Neon Drift"]);
        assert!(found.iter().all(|d| d.source == "folder"));
        assert_eq!(
            found.iter().find(|d| d.title == "Neon Drift").unwrap().key,
            key_for(&root.join("Neon Drift"))
        );
    }

    #[test]
    fn keys_are_case_and_separator_insensitive() {
        assert_eq!(
            key_for(Path::new(r"D:\Jeux\Game\")),
            key_for(Path::new("d:/jeux/game"))
        );
    }
}
