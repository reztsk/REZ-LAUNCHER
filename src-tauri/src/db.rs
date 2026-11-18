//! Local SQLite storage: games library + play sessions.
//!
//! `playtime_minutes` is always derived from the `sessions` table (sum of exact
//! durations in seconds), so it never drifts through rounding. Sessions are
//! heart-beaten while a game runs, which makes playtime crash-safe: if GameREZ
//! or the PC dies mid-session, the time up to the last heartbeat is kept.

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
    /// Computed at read time: the executable is set but not found on disk.
    pub exe_missing: bool,
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
}

impl GameInput {
    /// Trim fields, fill `install_dir` from the exe, and validate.
    pub fn normalized(mut self) -> AppResult<Self> {
        self.title = self.title.trim().to_string();
        self.executable_path = self.executable_path.trim().trim_matches('"').to_string();
        self.install_dir = self.install_dir.trim().trim_matches('"').to_string();
        self.cover_image_url = self.cover_image_url.trim().to_string();
        self.version = self.version.trim().to_string();

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
                            playtime_minutes, category, added_at, last_played_at";

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
        exe_missing,
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
             CREATE INDEX IF NOT EXISTS idx_sessions_game ON sessions(game_id);",
        )?;
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
                "INSERT INTO games (title, executable_path, install_dir, cover_image_url, version, category, added_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    g.title,
                    g.executable_path,
                    g.install_dir,
                    g.cover_image_url,
                    g.version,
                    g.category.as_str(),
                    now_rfc3339()
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
                    cover_image_url = ?4, version = ?5, category = ?6
             WHERE id = ?7",
            params![
                g.title,
                g.executable_path,
                g.install_dir,
                g.cover_image_url,
                g.version,
                g.category.as_str(),
                id
            ],
        )?;
        if changed == 0 {
            return Err(AppError::GameNotFound(id));
        }
        self.get_game(id)
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
}

/// Default database location inside the OS app-data directory.
pub fn db_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("gamerez.sqlite3")
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
        }
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
