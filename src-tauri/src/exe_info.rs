//! Read-only metadata of an executable (title + version), the same info
//! Windows Explorer shows in "Properties > Details". The file is never modified.

use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct ScannedExe {
    pub title: String,
    pub executable_path: String,
    pub install_dir: String,
    pub version: String,
}

/// Turn `hollow_knight-x64.exe` into `Hollow Knight`.
pub fn title_from_file_name(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut s = stem.replace(['_', '-', '.'], " ");
    // Strip build suffixes repeatedly ("Game-Win64-Shipping" -> "Game").
    'strip: loop {
        let lower = s.trim_end().to_lowercase();
        for suffix in [" x64", " x86", " win64", " win32", " shipping", " launcher"] {
            if lower.ends_with(suffix) && lower.len() == s.trim_end().len() {
                let cut = lower.len() - suffix.len();
                if s.is_char_boundary(cut) {
                    s.truncate(cut);
                    continue 'strip;
                }
            }
        }
        break;
    }
    s.split_whitespace()
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn scan(path: &Path) -> ScannedExe {
    let meta = version_info::read(path);
    let generic = ["", "bootstrapper", "launcher", "game", "application"];
    let title = meta
        .product_name
        .filter(|t| !generic.contains(&t.trim().to_lowercase().as_str()))
        .or(meta
            .file_description
            .filter(|t| !generic.contains(&t.trim().to_lowercase().as_str())))
        .map(|t| t.trim().to_string())
        .unwrap_or_else(|| title_from_file_name(path));
    ScannedExe {
        title,
        executable_path: path.to_string_lossy().into_owned(),
        install_dir: path
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        version: meta.version.unwrap_or_default(),
    }
}

#[derive(Default)]
struct VersionMeta {
    product_name: Option<String>,
    file_description: Option<String>,
    version: Option<String>,
}

#[cfg(windows)]
mod version_info {
    use super::VersionMeta;
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn query(block: &[u8], sub: &str) -> Option<(*const c_void, u32)> {
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let mut len: u32 = 0;
        let ok = VerQueryValueW(
            block.as_ptr().cast(),
            wide(sub).as_ptr(),
            &mut ptr,
            &mut len,
        );
        (ok != 0 && !ptr.is_null() && len > 0).then_some((ptr as *const c_void, len))
    }

    unsafe fn query_string(block: &[u8], sub: &str) -> Option<String> {
        let (ptr, len) = query(block, sub)?;
        let slice = std::slice::from_raw_parts(ptr as *const u16, len as usize);
        let end = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
        let s = String::from_utf16_lossy(&slice[..end]).trim().to_string();
        (!s.is_empty()).then_some(s)
    }

    pub(super) fn read(path: &Path) -> VersionMeta {
        let wpath: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            let size = GetFileVersionInfoSizeW(wpath.as_ptr(), std::ptr::null_mut());
            if size == 0 {
                return VersionMeta::default();
            }
            let mut block = vec![0u8; size as usize];
            if GetFileVersionInfoW(wpath.as_ptr(), 0, size, block.as_mut_ptr().cast()) == 0 {
                return VersionMeta::default();
            }

            // Language/codepage pairs; fall back to the usual en-US/Unicode one.
            let mut langs: Vec<String> = Vec::new();
            if let Some((ptr, len)) = query(&block, r"\VarFileInfo\Translation") {
                let pairs = std::slice::from_raw_parts(ptr as *const u16, (len / 2) as usize);
                for p in pairs.chunks_exact(2) {
                    langs.push(format!("{:04x}{:04x}", p[0], p[1]));
                }
            }
            langs.extend(["040904b0".into(), "040904e4".into(), "000004b0".into()]);

            let get = |key: &str| {
                langs
                    .iter()
                    .find_map(|l| query_string(&block, &format!(r"\StringFileInfo\{l}\{key}")))
            };

            let fixed_version = query(&block, r"\").and_then(|(ptr, len)| {
                if (len as usize) < std::mem::size_of::<VS_FIXEDFILEINFO>() {
                    return None;
                }
                let f = &*(ptr as *const VS_FIXEDFILEINFO);
                if f.dwSignature != 0xFEEF04BD {
                    return None;
                }
                let (ms, ls) = (f.dwProductVersionMS, f.dwProductVersionLS);
                Some(format!(
                    "{}.{}.{}.{}",
                    ms >> 16,
                    ms & 0xffff,
                    ls >> 16,
                    ls & 0xffff
                ))
            });

            VersionMeta {
                product_name: get("ProductName"),
                file_description: get("FileDescription"),
                version: get("ProductVersion")
                    .or_else(|| get("FileVersion"))
                    .or(fixed_version),
            }
        }
    }
}

#[cfg(not(windows))]
mod version_info {
    use super::VersionMeta;
    pub(super) fn read(_: &std::path::Path) -> VersionMeta {
        VersionMeta::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_from_file_names() {
        assert_eq!(
            title_from_file_name(Path::new("hollow_knight.exe")),
            "Hollow Knight"
        );
        assert_eq!(
            title_from_file_name(Path::new("MyGame-Win64-Shipping.exe")),
            "MyGame"
        );
        assert_eq!(title_from_file_name(Path::new("celeste.exe")), "Celeste");
    }

    #[cfg(windows)]
    #[test]
    fn reads_version_of_a_system_exe() {
        let windir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into());
        let notepad = Path::new(&windir).join("System32").join("notepad.exe");
        if notepad.exists() {
            let s = scan(&notepad);
            assert!(!s.title.is_empty());
            assert!(
                !s.version.is_empty(),
                "version should be read from the PE resource"
            );
        }
    }
}
