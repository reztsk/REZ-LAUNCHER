//! Read-only access to the Windows registry: "Apps & features" uninstall
//! entries and launcher install keys. Nothing is ever written.

use std::path::PathBuf;

/// Registry root.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hive {
    LocalMachine,
    CurrentUser,
}

/// One program listed in Windows "Apps & features".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UninstallEntry {
    pub display_name: String,
    pub install_location: String,
    pub display_icon: String,
    pub uninstall_string: String,
}

/// Read a string value (`None` if the key or value is missing).
#[cfg(windows)]
pub fn read_string(hive: Hive, path: &str, value: &str) -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    let root = RegKey::predef(match hive {
        Hive::LocalMachine => HKEY_LOCAL_MACHINE,
        Hive::CurrentUser => HKEY_CURRENT_USER,
    });
    let v: String = root.open_subkey(path).ok()?.get_value(value).ok()?;
    let v = v.trim().to_string();
    (!v.is_empty()).then_some(v)
}

#[cfg(not(windows))]
pub fn read_string(_hive: Hive, _path: &str, _value: &str) -> Option<String> {
    None
}

/// Every uninstall entry (64-bit, 32-bit and per-user views).
#[cfg(windows)]
pub fn uninstall_entries() -> Vec<UninstallEntry> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    const PATHS: &[(bool, &str)] = &[
        (true, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (
            true,
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            false,
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
    ];
    let mut out = Vec::new();
    for (hklm, path) in PATHS {
        let root = RegKey::predef(if *hklm {
            HKEY_LOCAL_MACHINE
        } else {
            HKEY_CURRENT_USER
        });
        let Ok(list) = root.open_subkey(path) else {
            continue;
        };
        for name in list.enum_keys().flatten() {
            let Ok(k) = list.open_subkey(&name) else {
                continue;
            };
            let get = |v: &str| k.get_value::<String, _>(v).unwrap_or_default();
            let e = UninstallEntry {
                display_name: get("DisplayName").trim().to_string(),
                install_location: get("InstallLocation").trim().to_string(),
                display_icon: get("DisplayIcon").trim().to_string(),
                uninstall_string: get("UninstallString").trim().to_string(),
            };
            if !e.display_name.is_empty() {
                out.push(e);
            }
        }
    }
    out
}

#[cfg(not(windows))]
pub fn uninstall_entries() -> Vec<UninstallEntry> {
    Vec::new()
}

/// `"C:\App\app.exe",0` -> `C:\App\app.exe` (only when it names an .exe).
pub fn exe_from_icon(icon: &str) -> Option<PathBuf> {
    let s = icon.trim();
    let s = match s.rfind(',') {
        Some(i) if s[i + 1..].trim().parse::<i32>().is_ok() => &s[..i],
        _ => s,
    };
    let s = s.trim().trim_matches('"').trim();
    s.to_ascii_lowercase()
        .ends_with(".exe")
        .then(|| PathBuf::from(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_display_icons() {
        assert_eq!(
            exe_from_icon(r#""C:\Program Files\Steam\steam.exe",0"#),
            Some(PathBuf::from(r"C:\Program Files\Steam\steam.exe"))
        );
        assert_eq!(
            exe_from_icon(r"D:\Jeux\Game\game.exe"),
            Some(PathBuf::from(r"D:\Jeux\Game\game.exe"))
        );
        assert_eq!(exe_from_icon(r"C:\x\icon.ico"), None);
        assert_eq!(exe_from_icon(""), None);
    }

    #[test]
    fn registry_reads_do_not_panic() {
        let _ = uninstall_entries();
        let _ = read_string(Hive::CurrentUser, r"Software\Nope\Nope", "x");
    }
}
