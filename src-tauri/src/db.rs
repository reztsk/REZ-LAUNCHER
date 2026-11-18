//! Local SQLite storage: games library + play sessions.
//!
//! `playtime_minutes` is always derived from the `sessions` table (sum of exact
//! durations in seconds), so it never drifts through rounding. Sessions are
//! heart-beaten while a game runs, which makes playtime crash-safe: if REZ launcher
//! or the PC dies mid-session, the time up to the last heartbeat is kept.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Installed,
    NotInstalled,
    Launcher,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Category::Installed => "installed",
            Category::NotInstalled => "not_installed",
            Category::Launcher => "launcher",
        }
    }

    pub fn parse(s: &str) -> AppResult<Self> {
        match s {
            "installed" => Ok(Category::Installed),
            "not_installed" => Ok(Category::NotInstalled),
            "launcher" => Ok(Category::Launcher),
            other => Err(AppError::Invalid(format!("Catégorie inconnue : {other}"))),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Game {
    pub id: i64,
    pub title: String,
    pub executable_path: String,
    pub install_dir: String,
    pub cover_image_url: String,
    pub version: String,
    pub playtime_minutes: i64,
    pub category: Category,
    pub added_at: String,
    pub last_played_at: Option<String>,
    /// Number of recorded play sessions for this game.
    pub session_count: i64,
    /// Computed at read time: the executable is set but not found on disk.
    pub exe_missing: bool,
    /// Free text shown on the back of the 3D game box.
    pub description: String,
    /// Cover framing set in the cover editor: zoom (1..=4) around a focal point
    /// given in % of the image (0..=100). Display-only, the image file is untouched.
    pub cover_zoom: f64,
    pub cover_x: f64,
    pub cover_y: f64,
}

/// Payload used to create or update a game.
#[derive(Debug, Clone, Deserialize)]
pub struct GameInput {
    pub title: String,
    #[serde(default)]
    pub executable_path: String,
    #[serde(default)]
    pub install_dir: String,
    #[serde(default)]
    pub cover_image_url: String,
    #[serde(default)]
    pub version: String,
    pub category: Category,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_zoom")]
    pub cover_zoom: f64,
    #[serde(default = "default_center")]
    pub cover_x: f64,
    #[serde(default = "default_center")]
    pub cover_y: f64,
}

fn default_zoom() -> f64 {
    1.0
}
fn default_center() -> f64 {
    50.0
}

/// Keep a cover framing value finite and inside `min..=max`.
fn clamp_or(v: f64, min: f64, max: f64, fallback: f64) -> f64 {
    if v.is_finite() {
        v.clamp(min, max)
    } else {
        fallback
    }
}

impl GameInput {
    /// Trim fields, fill `install_dir` from the exe, and validate.
    pub fn normalized(mut self) -> AppResult<Self> {
        self.title = self.title.trim().to_string();
        self.executable_path = self.executable_path.trim().trim_matches('"').to_string();
        self.install_dir = self.install_dir.trim().trim_matches('"').to_string();
        self.cover_image_url = self.cover_image_url.trim().to_string();
        self.version = self.version.trim().to_string();
        self.description = self.description.trim().to_string();
        self.cover_zoom = clamp_or(self.cover_zoom, 1.0, 4.0, 1.0);
        self.cover_x = clamp_or(self.cover_x, 0.0, 100.0, 50.0);
        self.cover_y = clamp_or(self.cover_y, 0.0, 100.0, 50.0);
        if self.description.chars().count() > 4000 {
            return Err(AppError::Invalid(
                "Description trop longue (4000 caractères max).".into(),
            ));
        }

        if self.title.is_empty() {
            return Err(AppError::Invalid("Le titre est obligatoire.".into()));
        }
        if self.title.chars().count() > 200 {
            return Err(AppError::Invalid(
                "Titre trop long (200 caractères max).".into(),
            ));
        }
        if self.category != Category::NotInstalled && self.executable_path.is_empty() {
            return Err(AppError::Invalid(
                "Un exécutable est requis pour un jeu installé ou un launcher.".into(),
            ));
        }
        if !self.executable_path.is_empty() && !is_executable_name(&self.executable_path) {
            return Err(AppError::Invalid(
                "Le fichier doit être un exécutable (.exe, .bat, .cmd, .lnk, .url).".into(),
            ));
        }
        if self.install_dir.is_empty() && !self.executable_path.is_empty() {
            if let Some(parent) = Path::new(&self.executable_path).parent() {
                self.install_dir = parent.to_string_lossy().into_owned();
            }
        }
        Ok(self)
    }
}

pub fn is_executable_name(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if cfg!(windows) {
        matches!(ext.as_str(), "exe" | "bat" | "cmd" | "lnk" | "url")
    } else {
        // Linux/macOS binaries usually have no extension.
        true
    }
}

pub struct Database {
    conn: Mutex<Connection>,
}

const GAME_COLUMNS: &str = "id, title, executable_path, install_dir, cover_image_url, version, \
                            playtime_minutes, category, added_at, last_played_at, \
                            (SELECT COUNT(*) FROM sessions s WHERE s.game_id = games.id \
                             AND s.duration_seconds > 0) AS session_count, \
                            description, cover_zoom, cover_x, cover_y";

fn row_to_game(row: &Row<'_>) -> rusqlite::Result<Game> {
    let category: String = row.get(7)?;
    let executable_path: String = row.get(2)?;
    let exe_missing = !executable_path.is_empty() && !Path::new(&executable_path).exists();
    Ok(Game {
        id: row.get(0)?,
        title: row.get(1)?,
        executable_path,
        install_dir: row.get(3)?,
        cover_image_url: row.get(4)?,
        version: row.get(5)?,
        playtime_minutes: row.get(6)?,
        category: Category::parse(&category).unwrap_or(Category::NotInstalled),
        added_at: row.get(8)?,
        last_played_at: row.get(9)?,
        session_count: row.get(10)?,
        exe_missing,
        description: row.get(11)?,
        cover_zoom: row.get(12)?,
        cover_x: row.get(13)?,
        cover_y: row.get(14)?,
    })
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

impl Database {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> AppResult<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> AppResult<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;

             CREATE TABLE IF NOT EXISTS games (
                 id               INTEGER PRIMARY KEY AUTOINCREMENT,
                 title            TEXT    NOT NULL,
                 executable_path  TEXT    NOT NULL DEFAULT '',
                 install_dir      TEXT    NOT NULL DEFAULT '',
                 cover_image_url  TEXT    NOT NULL DEFAULT '',
                 version          TEXT    NOT NULL DEFAULT '',
                 playtime_minutes INTEGER NOT NULL DEFAULT 0,
                 category         TEXT    NOT NULL DEFAULT 'installed'
                                  CHECK (category IN ('installed', 'not_installed', 'launcher')),
                 added_at         TEXT    NOT NULL,
                 last_played_at   TEXT
             );

             CREATE TABLE IF NOT EXISTS sessions (
                 id               INTEGER PRIMARY KEY AUTOINCREMENT,
                 game_id          INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                 started_at       TEXT    NOT NULL,
                 ended_at         TEXT    NOT NULL,
                 duration_seconds INTEGER NOT NULL DEFAULT 0,
                 active           INTEGER NOT NULL DEFAULT 1
             );
             CREATE INDEX IF NOT EXISTS idx_sessions_game ON sessions(game_id);

             CREATE TABLE IF NOT EXISTS settings (
                 key   TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );

             -- Games found on disk by the (read-only) detector and the user's
             -- answer: 'pending' | 'seen' | 'ignored' | 'added'.
             CREATE TABLE IF NOT EXISTS detections (
                 key             TEXT PRIMARY KEY,
                 title           TEXT NOT NULL,
                 executable_path TEXT NOT NULL,
                 install_dir     TEXT NOT NULL,
                 source          TEXT NOT NULL,
                 status          TEXT NOT NULL,
                 first_seen      TEXT NOT NULL
             );",
        )?;
        // v0.3.0 columns (older databases are upgraded in place).
        let existing: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('games')")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        for (col, ddl) in [
            ("description", "TEXT NOT NULL DEFAULT ''"),
            ("cover_zoom", "REAL NOT NULL DEFAULT 1"),
            ("cover_x", "REAL NOT NULL DEFAULT 50"),
            ("cover_y", "REAL NOT NULL DEFAULT 50"),
        ] {
            if !existing.iter().any(|c| c == col) {
                conn.execute_batch(&format!("ALTER TABLE games ADD COLUMN {col} {ddl};"))?;
            }
        }
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // A poisoned lock only means another thread panicked mid-query; the
        // connection itself is still usable.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn list_games(&self) -> AppResult<Vec<Game>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {GAME_COLUMNS} FROM games ORDER BY title COLLATE NOCASE"
        ))?;
        let games = stmt
            .query_map([], row_to_game)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(games)
    }

    pub fn get_game(&self, id: i64) -> AppResult<Game> {
        self.conn()
            .query_row(
                &format!("SELECT {GAME_COLUMNS} FROM games WHERE id = ?1"),
                [id],
                row_to_game,
            )
            .optional()?
            .ok_or(AppError::GameNotFound(id))
    }

    pub fn insert_game(&self, input: GameInput) -> AppResult<Game> {
        let g = input.normalized()?;
        let id = {
            let conn = self.conn();
            conn.execute(
                "INSERT INTO games (title, executable_path, install_dir, cover_image_url, version, category,
                                    added_at, description, cover_zoom, cover_x, cover_y)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    g.title,
                    g.executable_path,
                    g.install_dir,
                    g.cover_image_url,
                    g.version,
                    g.category.as_str(),
                    now_rfc3339(),
                    g.description,
                    g.cover_zoom,
                    g.cover_x,
                    g.cover_y
                ],
            )?;
            conn.last_insert_rowid()
        };
        self.get_game(id)
    }

    pub fn update_game(&self, id: i64, input: GameInput) -> AppResult<Game> {
        let g = input.normalized()?;
        let changed = self.conn().execute(
            "UPDATE games SET title = ?1, executable_path = ?2, install_dir = ?3,
                    cover_image_url = ?4, version = ?5, category = ?6,
                    description = ?7, cover_zoom = ?8, cover_x = ?9, cover_y = ?10
             WHERE id = ?11",
            params![
                g.title,
                g.executable_path,
                g.install_dir,
                g.cover_image_url,
                g.version,
                g.category.as_str(),
                g.description,
                g.cover_zoom,
                g.cover_x,
                g.cover_y,
                id
            ],
        )?;
        if changed == 0 {
            return Err(AppError::GameNotFound(id));
        }
        self.get_game(id)
    }

    /// Set a cover only if the game has none yet (automatic covers never
    /// override the user's choice). Returns true when it was set.
    pub fn set_cover_if_empty(&self, id: i64, url: &str) -> AppResult<bool> {
        Ok(self.conn().execute(
            "UPDATE games SET cover_image_url = ?1 WHERE id = ?2 AND cover_image_url = ''",
            params![url, id],
        )? > 0)
    }

    pub fn delete_game(&self, id: i64) -> AppResult<()> {
        let changed = self
            .conn()
            .execute("DELETE FROM games WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(AppError::GameNotFound(id));
        }
        Ok(())
    }

    /// Open a new play session. Returns the session id.
    pub fn start_session(&self, game_id: i64, started_at: &str) -> AppResult<i64> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO sessions (game_id, started_at, ended_at, duration_seconds, active)
             VALUES (?1, ?2, ?2, 0, 1)",
            params![game_id, started_at],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Persist progress of a running session (crash safety).
    pub fn heartbeat_session(
        &self,
        session_id: i64,
        now: &str,
        duration_seconds: i64,
    ) -> AppResult<()> {
        self.conn().execute(
            "UPDATE sessions SET ended_at = ?1, duration_seconds = ?2 WHERE id = ?3",
            params![now, duration_seconds.max(0), session_id],
        )?;
        Ok(())
    }

    /// Close a session, recompute the game's total playtime and return the updated game.
    pub fn finish_session(
        &self,
        session_id: i64,
        ended_at: &str,
        duration_seconds: i64,
    ) -> AppResult<Game> {
        let game_id: i64 = {
            let conn = self.conn();
            conn.execute(
                "UPDATE sessions SET ended_at = ?1, duration_seconds = ?2, active = 0 WHERE id = ?3",
                params![ended_at, duration_seconds.max(0), session_id],
            )?;
            let game_id = conn.query_row(
                "SELECT game_id FROM sessions WHERE id = ?1",
                [session_id],
                |r| r.get(0),
            )?;
            conn.execute(
                "UPDATE games SET last_played_at = ?1 WHERE id = ?2",
                params![ended_at, game_id],
            )?;
            game_id
        };
        self.recompute_playtime(Some(game_id))?;
        self.get_game(game_id)
    }

    /// Recompute `playtime_minutes` from sessions (one game, or all when `None`).
    pub fn recompute_playtime(&self, game_id: Option<i64>) -> AppResult<()> {
        let sql = "UPDATE games SET playtime_minutes = (
                       SELECT COALESCE(SUM(duration_seconds), 0) / 60
                       FROM sessions WHERE sessions.game_id = games.id)";
        let conn = self.conn();
        match game_id {
            Some(id) => conn.execute(&format!("{sql} WHERE id = ?1"), [id])?,
            None => conn.execute(sql, [])?,
        };
        Ok(())
    }

    /// Called at startup: sessions left `active` by a crash are closed at their
    /// last heartbeat. Returns how many sessions were recovered.
    pub fn recover_sessions(&self) -> AppResult<usize> {
        let recovered = {
            let conn = self.conn();
            let n = conn.execute("UPDATE sessions SET active = 0 WHERE active = 1", [])?;
            conn.execute(
                "UPDATE games SET last_played_at = (
                     SELECT MAX(ended_at) FROM sessions WHERE sessions.game_id = games.id)
                 WHERE EXISTS (SELECT 1 FROM sessions WHERE sessions.game_id = games.id)",
                [],
            )?;
            n
        };
        self.recompute_playtime(None)?;
        Ok(recovered)
    }

    pub fn total_session_seconds(&self, game_id: i64) -> AppResult<i64> {
        Ok(self.conn().query_row(
            "SELECT COALESCE(SUM(duration_seconds), 0) FROM sessions WHERE game_id = ?1",
            [game_id],
            |r| r.get(0),
        )?)
    }

    // ------------------------------------------------------------ settings

    pub fn get_setting(&self, key: &str) -> AppResult<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> AppResult<()> {
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    // ---------------------------------------------------------- detections

    /// `key -> status` for every game the detector has already seen.
    pub fn detection_statuses(&self) -> AppResult<HashMap<String, String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT key, status FROM detections")?;
        let map = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<HashMap<_, _>, _>>()?;
        Ok(map)
    }

    /// Record newly found games. Never overrides an existing answer.
    pub fn insert_detections(&self, found: &[Detected], status: &str) -> AppResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO detections
                     (key, title, executable_path, install_dir, source, status, first_seen)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            let now = now_rfc3339();
            for d in found {
                stmt.execute(params![
                    d.key,
                    d.title,
                    d.executable_path,
                    d.install_dir,
                    d.source,
                    status,
                    now
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn detections_with_status(&self, statuses: &[&str]) -> AppResult<Vec<Detected>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT key, title, executable_path, install_dir, source, status
             FROM detections ORDER BY title COLLATE NOCASE",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((row_to_detected(r)?, r.get::<_, String>(5)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .filter(|(_, st)| statuses.contains(&st.as_str()))
            .map(|(d, _)| d)
            .collect())
    }

    pub fn get_detection(&self, key: &str) -> AppResult<Option<Detected>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT key, title, executable_path, install_dir, source
                 FROM detections WHERE key = ?1",
                [key],
                row_to_detected,
            )
            .optional()?)
    }

    pub fn set_detection_status(&self, keys: &[String], status: &str) -> AppResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for k in keys {
            tx.execute(
                "UPDATE detections SET status = ?1 WHERE key = ?2",
                params![status, k],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// "Ignored" games become proposable again. Returns how many were reset.
    pub fn reset_ignored_detections(&self) -> AppResult<usize> {
        Ok(self.conn().execute(
            "UPDATE detections SET status = 'seen' WHERE status = 'ignored'",
            [],
        )?)
    }

    /// Every local cover path still referenced by a game.
    pub fn cover_paths(&self) -> AppResult<Vec<String>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT cover_image_url FROM games WHERE cover_image_url <> ''")?;
        let v = stmt
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(v)
    }
}

/// A game found on disk by the detector (see `detect.rs`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Detected {
    /// Normalized install folder: identity of the detection.
    pub key: String,
    pub title: String,
    pub executable_path: String,
    pub install_dir: String,
    /// "steam" | "epic" | "gog" | "folder"
    pub source: String,
}

fn row_to_detected(r: &Row<'_>) -> rusqlite::Result<Detected> {
    Ok(Detected {
        key: r.get(0)?,
        title: r.get(1)?,
        executable_path: r.get(2)?,
        install_dir: r.get(3)?,
        source: r.get(4)?,
    })
}

/// One-time import of the data stored under the app's former name (GameREZ,
/// `io.github.gamerez`): consistent copy of the database + local covers.
/// The old folder is left untouched. Returns true if something was migrated.
pub fn migrate_legacy(old_dir: &Path, new_dir: &Path) -> AppResult<bool> {
    let old_db = old_dir.join("gamerez.sqlite3");
    let new_db = db_path(new_dir);
    if new_db.exists() || !old_db.is_file() {
        return Ok(false);
    }
    std::fs::create_dir_all(new_dir)?;
    Connection::open(&old_db)?.execute("VACUUM INTO ?1", [new_db.to_string_lossy()])?;
    let old_covers = old_dir.join("covers");
    let new_covers = new_dir.join("covers");
    if old_covers.is_dir() {
        std::fs::create_dir_all(&new_covers)?;
        for entry in std::fs::read_dir(&old_covers)?.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_file()) {
                std::fs::copy(entry.path(), new_covers.join(entry.file_name()))?;
            }
        }
        Connection::open(&new_db)?.execute(
            "UPDATE games SET cover_image_url = replace(cover_image_url, ?1, ?2)",
            params![old_covers.to_string_lossy(), new_covers.to_string_lossy()],
        )?;
    }
    Ok(true)
}

/// Default database location inside the OS app-data directory.
pub fn db_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("rez-launcher.sqlite3")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(title: &str, exe: &str, cat: Category) -> GameInput {
        GameInput {
            title: title.into(),
            executable_path: exe.into(),
            install_dir: String::new(),
            cover_image_url: String::new(),
            version: "1.0".into(),
            category: cat,
            description: String::new(),
            cover_zoom: 1.0,
            cover_x: 50.0,
            cover_y: 50.0,
        }
    }

    #[test]
    fn cover_framing_is_clamped_and_saved() {
        let db = Database::open_in_memory().unwrap();
        let mut i = input("Framed", r"D:\Jeux\F\f.exe", Category::Installed);
        i.cover_zoom = 9.0;
        i.cover_x = -5.0;
        i.cover_y = f64::NAN;
        i.description = "  Un jeu.  ".into();
        let g = db.insert_game(i).unwrap();
        assert_eq!((g.cover_zoom, g.cover_x, g.cover_y), (4.0, 0.0, 50.0));
        assert_eq!(g.description, "Un jeu.");
        assert!(db.set_cover_if_empty(g.id, "https://x/c.jpg").unwrap());
        assert!(!db.set_cover_if_empty(g.id, "https://x/other.jpg").unwrap());
        assert_eq!(
            db.get_game(g.id).unwrap().cover_image_url,
            "https://x/c.jpg"
        );
    }

    #[test]
    fn old_databases_get_new_columns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.sqlite3");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
                   executable_path TEXT NOT NULL DEFAULT '', install_dir TEXT NOT NULL DEFAULT '',
                   cover_image_url TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '',
                   playtime_minutes INTEGER NOT NULL DEFAULT 0, category TEXT NOT NULL DEFAULT 'installed',
                   added_at TEXT NOT NULL, last_played_at TEXT);
                 INSERT INTO games (title, added_at, category) VALUES ('Legacy', '2025-01-01T00:00:00Z', 'not_installed');",
            )
            .unwrap();
        }
        let db = Database::open(&path).unwrap();
        let g = &db.list_games().unwrap()[0];
        assert_eq!(g.title, "Legacy");
        assert_eq!((g.cover_zoom, g.cover_x, g.cover_y), (1.0, 50.0, 50.0));
        assert_eq!(g.description, "");
    }

    #[test]
    fn insert_list_update_delete() {
        let db = Database::open_in_memory().unwrap();
        let g = db
            .insert_game(input(
                "  Zelda-like ",
                r"D:\Jeux\Hero\hero.exe",
                Category::Installed,
            ))
            .unwrap();
        assert_eq!(g.title, "Zelda-like");
        assert_eq!(g.playtime_minutes, 0);
        if cfg!(windows) {
            assert_eq!(g.install_dir, r"D:\Jeux\Hero");
        }
        db.insert_game(input("Alpha", "", Category::NotInstalled))
            .unwrap();

        let all = db.list_games().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].title, "Alpha"); // sorted by title

        let mut upd = input("Hero", r"D:\Jeux\Hero\hero.exe", Category::Installed);
        upd.version = "2.1.0".into();
        let g2 = db.update_game(g.id, upd).unwrap();
        assert_eq!(g2.version, "2.1.0");

        db.delete_game(g.id).unwrap();
        assert!(matches!(db.get_game(g.id), Err(AppError::GameNotFound(_))));
        assert!(matches!(
            db.delete_game(g.id),
            Err(AppError::GameNotFound(_))
        ));
    }

    #[test]
    fn validation() {
        let db = Database::open_in_memory().unwrap();
        assert!(db
            .insert_game(input("   ", "a.exe", Category::Installed))
            .is_err());
        assert!(db
            .insert_game(input("No exe", "", Category::Installed))
            .is_err());
        assert!(db
            .insert_game(input("Wishlist", "", Category::NotInstalled))
            .is_ok());
        if cfg!(windows) {
            assert!(db
                .insert_game(input("Doc", r"C:\x\readme.txt", Category::Installed))
                .is_err());
        }
    }

    #[test]
    fn sessions_accumulate_exact_playtime() {
        let db = Database::open_in_memory().unwrap();
        let g = db
            .insert_game(input("Game", r"C:\g\g.exe", Category::Installed))
            .unwrap();

        // 90 s + 45 s = 135 s -> 2 minutes (floor), no per-session rounding loss.
        let s1 = db.start_session(g.id, "2026-01-01T10:00:00Z").unwrap();
        db.heartbeat_session(s1, "2026-01-01T10:00:30Z", 30)
            .unwrap();
        let after1 = db.finish_session(s1, "2026-01-01T10:01:30Z", 90).unwrap();
        assert_eq!(after1.playtime_minutes, 1);
        assert_eq!(
            after1.last_played_at.as_deref(),
            Some("2026-01-01T10:01:30Z")
        );

        let s2 = db.start_session(g.id, "2026-01-02T10:00:00Z").unwrap();
        let after2 = db.finish_session(s2, "2026-01-02T10:00:45Z", 45).unwrap();
        assert_eq!(after2.playtime_minutes, 2);
        assert_eq!(db.total_session_seconds(g.id).unwrap(), 135);
    }

    #[test]
    fn crash_recovery_keeps_heartbeat_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = db_path(dir.path());
        let gid;
        {
            let db = Database::open(&path).unwrap();
            gid = db
                .insert_game(input("Game", r"C:\g\g.exe", Category::Installed))
                .unwrap()
                .id;
            let s = db.start_session(gid, "2026-01-01T10:00:00Z").unwrap();
            db.heartbeat_session(s, "2026-01-01T11:00:00Z", 3600)
                .unwrap();
            // App "crashes" here: no finish_session.
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(db.recover_sessions().unwrap(), 1);
        let g = db.get_game(gid).unwrap();
        assert_eq!(g.playtime_minutes, 60);
        assert_eq!(g.last_played_at.as_deref(), Some("2026-01-01T11:00:00Z"));
        assert_eq!(db.recover_sessions().unwrap(), 0);
    }

    #[test]
    fn settings_roundtrip() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.get_setting("k").unwrap(), None);
        db.set_setting("k", "1").unwrap();
        db.set_setting("k", "2").unwrap();
        assert_eq!(db.get_setting("k").unwrap().as_deref(), Some("2"));
    }

    #[test]
    fn detections_lifecycle() {
        let db = Database::open_in_memory().unwrap();
        let d = |k: &str| Detected {
            key: k.into(),
            title: k.to_uppercase(),
            executable_path: format!(r"D:\Jeux\{k}\{k}.exe"),
            install_dir: format!(r"D:\Jeux\{k}"),
            source: "folder".into(),
        };
        db.insert_detections(&[d("a"), d("b")], "pending").unwrap();
        db.set_detection_status(&["a".into()], "ignored").unwrap();
        // Re-detection never overrides the user's answer.
        db.insert_detections(&[d("a")], "pending").unwrap();
        let st = db.detection_statuses().unwrap();
        assert_eq!(st["a"], "ignored");
        assert_eq!(st["b"], "pending");
        assert_eq!(
            db.detections_with_status(&["pending"]).unwrap(),
            vec![d("b")]
        );
        assert_eq!(db.reset_ignored_detections().unwrap(), 1);
        assert_eq!(db.detection_statuses().unwrap()["a"], "seen");
        assert_eq!(db.get_detection("b").unwrap(), Some(d("b")));
    }

    #[test]
    fn session_count_ignores_empty_sessions() {
        let db = Database::open_in_memory().unwrap();
        let g = db
            .insert_game(input("G", r"D:\Jeux\G\g.exe", Category::Installed))
            .unwrap();
        let s1 = db.start_session(g.id, "2026-01-01T10:00:00Z").unwrap();
        db.finish_session(s1, "2026-01-01T11:00:00Z", 3600).unwrap();
        let s2 = db.start_session(g.id, "2026-01-02T10:00:00Z").unwrap();
        let g = db.finish_session(s2, "2026-01-02T10:00:00Z", 0).unwrap();
        assert_eq!(g.session_count, 1);
        assert_eq!(g.playtime_minutes, 60);
    }

    #[test]
    fn migrates_legacy_gamerez_data() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("io.github.gamerez");
        let new = tmp.path().join("io.github.rezlauncher");
        std::fs::create_dir_all(old.join("covers")).unwrap();
        std::fs::write(old.join("covers").join("cover-1.png"), b"png").unwrap();
        {
            let legacy = Database::open(&old.join("gamerez.sqlite3")).unwrap();
            let mut i = input("Old", r"D:\Jeux\Old\old.exe", Category::Installed);
            i.cover_image_url = old
                .join("covers")
                .join("cover-1.png")
                .to_string_lossy()
                .into_owned();
            legacy.insert_game(i).unwrap();
        }
        assert!(migrate_legacy(&old, &new).unwrap());
        assert!(!migrate_legacy(&old, &new).unwrap()); // only once
        let db = Database::open(&db_path(&new)).unwrap();
        let games = db.list_games().unwrap();
        assert_eq!(games.len(), 1);
        let cover = PathBuf::from(&games[0].cover_image_url);
        assert!(cover.starts_with(new.join("covers")));
        assert!(cover.is_file());
        assert!(old.join("gamerez.sqlite3").is_file()); // old data untouched
    }

    #[test]
    fn deleting_game_cascades_sessions() {
        let db = Database::open_in_memory().unwrap();
        let g = db
            .insert_game(input("Game", r"C:\g\g.exe", Category::Installed))
            .unwrap();
        let s = db.start_session(g.id, "2026-01-01T10:00:00Z").unwrap();
        db.finish_session(s, "2026-01-01T10:10:00Z", 600).unwrap();
        db.delete_game(g.id).unwrap();
        assert_eq!(db.total_session_seconds(g.id).unwrap(), 0);
    }
}
