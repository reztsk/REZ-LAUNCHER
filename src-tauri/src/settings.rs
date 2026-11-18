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

/// How the library is displayed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LibraryView {
    /// Cover grid (click = play).
    #[default]
    Grid,
    /// Cover grid, click opens an interactive 3D game box.
    Box3d,
    /// Horizontal 3D carousel of game boxes.
    Carousel,
}

/// Accent colour duo / gradient of the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    Steel,
    Cyan,
    Neon,
    Carbon,
    Ember,
    Glacier,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    // Appearance
    pub card_size: CardSize,
    pub animations: bool,
    pub tilt: bool,
    pub ambient: bool,
    pub theme: Theme,
    /// Frosted "Apple glass" on the sidebar and category tabs.
    pub glass: bool,
    pub library_view: LibraryView,
    // Game launch
    /// Full-screen box-opening animation + loading bar until the game window shows.
    pub launch_animation: bool,
    /// Minimize REZ launcher once the game is up.
    pub minimize_on_launch: bool,
    /// Bring REZ launcher back when the game closes.
    pub restore_on_exit: bool,
    // Updates
    pub check_updates_on_start: bool,
    // Game detection (read-only scan of launcher manifests + these folders)
    pub detect_new_games: bool,
    pub search_paths: Vec<String>,
    // Startup
    pub start_view: StartView,
    /// Mirrors the OS autostart entry (source of truth: the OS).
    pub launch_at_startup: bool,
    // Friends
    /// Presence + profiles on the local network (opt-in).
    pub social_enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            card_size: CardSize::Normal,
            animations: true,
            tilt: true,
            ambient: true,
            theme: Theme::Steel,
            glass: true,
            library_view: LibraryView::Grid,
            launch_animation: true,
            minimize_on_launch: true,
            restore_on_exit: true,
            check_updates_on_start: true,
            detect_new_games: true,
            search_paths: Vec::new(),
            start_view: StartView::Library,
            launch_at_startup: false,
            social_enabled: false,
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
        assert!(s.minimize_on_launch && s.restore_on_exit);
        assert_eq!(s.library_view, LibraryView::Grid);
    }

    #[test]
    fn view_modes_and_themes_serialize_lowercase() {
        let s = Settings {
            library_view: LibraryView::Box3d,
            theme: Theme::Glacier,
            ..Settings::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains(r#""library_view":"box3d""#));
        assert!(json.contains(r#""theme":"glacier""#));
        let back: Settings =
            serde_json::from_str(r#"{"library_view":"carousel","theme":"cyan"}"#).unwrap();
        assert_eq!(back.library_view, LibraryView::Carousel);
        assert_eq!(back.theme, Theme::Cyan);
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
