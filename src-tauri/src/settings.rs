//! User preferences, stored as one JSON document in the `settings` table.

use std::path::{Component, PathBuf};

use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{AppError, AppResult};

const KEY: &str = "app";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CardSize {
    Compact,
    #[default]
    Normal,
    Large,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum StartView {
    #[default]
    Library,
    Launchers,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    // Appearance
    pub card_size: CardSize,
    pub animations: bool,
    pub tilt: bool,
    pub ambient: bool,
    // Updates
    pub check_updates_on_start: bool,
    // Game detection (read-only scan of launcher manifests + these folders)
    pub detect_new_games: bool,
    pub search_paths: Vec<String>,
    // Startup
    pub start_view: StartView,
    /// Mirrors the OS autostart entry (source of truth: the OS).
    pub launch_at_startup: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            card_size: CardSize::Normal,
            animations: true,
            tilt: true,
            ambient: true,
            check_updates_on_start: true,
            detect_new_games: true,
            search_paths: Vec::new(),
            start_view: StartView::Library,
            launch_at_startup: false,
        }
    }
}

/// Folders scanned by default the first time: `X:\Jeux` and `X:\Games` when they exist.
pub fn default_search_paths() -> Vec<String> {
    crate::launchers::local_drives()
        .into_iter()
        .flat_map(|d| [d.join("Jeux"), d.join("Games")])
        .filter(|p| p.is_dir())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

impl Settings {
    pub fn load(db: &Database) -> Settings {
        match db.get_setting(KEY) {
            Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_default(),
            _ => Settings {
                search_paths: default_search_paths(),
                ..Settings::default()
            },
        }
    }

    pub fn save(&self, db: &Database) -> AppResult<()> {
        let json = serde_json::to_string(self).map_err(|e| AppError::Other(e.to_string()))?;
        db.set_setting(KEY, &json)
    }

    /// Trim, dedupe and validate search folders (absolute, no `..`, max 32).
    pub fn normalized(mut self) -> AppResult<Settings> {
        let mut out: Vec<String> = Vec::new();
        for raw in &self.search_paths {
            let p = raw.trim().trim_matches('"').trim_end_matches(['\\', '/']);
            if p.is_empty() {
                continue;
            }
            let pb = PathBuf::from(p);
            let p = if pb.parent().is_none() {
                format!("{p}\\") // "D:" -> "D:\"
            } else {
                p.to_string()
            };
            let pb = PathBuf::from(&p);
            if !pb.is_absolute() || pb.components().any(|c| matches!(c, Component::ParentDir)) {
                return Err(AppError::Invalid(format!("Dossier invalide : {raw}")));
            }
            if !out.iter().any(|o| o.eq_ignore_ascii_case(&p)) {
                out.push(p);
            }
        }
        if out.len() > 32 {
            return Err(AppError::Invalid(
                "32 dossiers de recherche maximum.".into(),
            ));
        }
        self.search_paths = out;
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_or_partial_json_falls_back_to_defaults() {
        let db = Database::open_in_memory().unwrap();
        db.set_setting(KEY, r#"{"tilt":false,"card_size":"huge"}"#)
            .unwrap();
        // Invalid enum value -> whole document rejected -> defaults.
        assert!(Settings::load(&db).tilt);
        db.set_setting(KEY, r#"{"tilt":false}"#).unwrap();
        let s = Settings::load(&db);
        assert!(!s.tilt);
        assert!(s.animations);
    }

    #[test]
    fn roundtrip() {
        let db = Database::open_in_memory().unwrap();
        let s = Settings {
            card_size: CardSize::Large,
            search_paths: vec![r"D:\Jeux".into()],
            ..Settings::default()
        };
        s.save(&db).unwrap();
        assert_eq!(Settings::load(&db), s);
    }

    #[cfg(windows)]
    #[test]
    fn search_paths_are_validated() {
        let s = Settings {
            search_paths: vec![
                r" D:\Jeux\ ".into(),
                r"d:\jeux".into(),
                "".into(),
                "E:".into(),
            ],
            ..Settings::default()
        };
        let s = s.normalized().unwrap();
        assert_eq!(
            s.search_paths,
            vec![r"D:\Jeux".to_string(), r"E:\".to_string()]
        );
        let bad = Settings {
            search_paths: vec![r"Jeux\Steam".into()],
            ..Settings::default()
        };
        assert!(bad.normalized().is_err());
        let bad = Settings {
            search_paths: vec![r"D:\Jeux\..\Windows".into()],
            ..Settings::default()
        };
        assert!(bad.normalized().is_err());
    }
}
