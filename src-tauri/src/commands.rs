//! Tauri commands exposed to the frontend.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::db::{Database, Game, GameInput};
use crate::error::{AppError, AppResult};
use crate::exe_info::{self, ScannedExe};
use crate::launchers::{self, LauncherInfo};
use crate::watcher::{self, RunningGame, Tracker};

pub struct AppState {
    pub db: Arc<Database>,
    pub tracker: Arc<Tracker>,
    pub covers_dir: PathBuf,
}

#[tauri::command]
pub fn list_games(state: State<'_, AppState>) -> AppResult<Vec<Game>> {
    state.db.list_games()
}

#[tauri::command]
pub fn add_game(state: State<'_, AppState>, input: GameInput) -> AppResult<Game> {
    state.db.insert_game(input)
}

#[tauri::command]
pub fn update_game(state: State<'_, AppState>, id: i64, input: GameInput) -> AppResult<Game> {
    state.db.update_game(id, input)
}

#[tauri::command]
pub fn delete_game(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    if state.tracker.list().iter().any(|r| r.game_id == id) {
        return Err(AppError::Invalid(
            "Impossible de supprimer un jeu en cours.".into(),
        ));
    }
    let game = state.db.get_game(id)?;
    state.db.delete_game(id)?;
    // Remove the cover only if GameREZ owns it (copied into its covers folder).
    let cover = Path::new(&game.cover_image_url);
    if cover.starts_with(&state.covers_dir) {
        let _ = std::fs::remove_file(cover);
    }
    Ok(())
}

#[tauri::command]
pub fn launch_game(app: AppHandle, state: State<'_, AppState>, id: i64) -> AppResult<RunningGame> {
    let game = state.db.get_game(id)?;
    watcher::launch(app, state.db.clone(), state.tracker.clone(), game)
}

#[tauri::command]
pub fn running_games(state: State<'_, AppState>) -> Vec<RunningGame> {
    state.tracker.list()
}

/// Open the native file explorer on a folder (or reveal a file inside it).
#[tauri::command]
pub fn open_folder(app: AppHandle, path: String) -> AppResult<()> {
    let p = PathBuf::from(path.trim().trim_matches('"'));
    let opener = app.opener();
    let res = if p.is_dir() {
        opener.open_path(p.to_string_lossy(), None::<&str>)
    } else if p.is_file() {
        opener.reveal_item_in_dir(&p)
    } else {
        return Err(AppError::Invalid(format!(
            "Dossier introuvable : {}",
            p.display()
        )));
    };
    res.map_err(|e| AppError::Other(format!("Ouverture impossible : {e}")))
}

/// Import a game from its executable. Without `path`, opens the native file picker.
/// Returns `None` if the user cancels.
#[tauri::command]
pub async fn scan_executable(
    app: AppHandle,
    path: Option<String>,
) -> AppResult<Option<ScannedExe>> {
    let path = match path {
        Some(p) => PathBuf::from(p.trim().trim_matches('"')),
        None => {
            let picked = app
                .dialog()
                .file()
                .set_title("Choisir l'exécutable du jeu")
                .add_filter("Exécutable", &["exe", "lnk", "url", "bat", "cmd"])
                .blocking_pick_file();
            match picked {
                Some(fp) => fp.into_path().map_err(|e| AppError::Other(e.to_string()))?,
                None => return Ok(None),
            }
        }
    };
    if !path.is_file() {
        return Err(AppError::Invalid(format!(
            "Fichier introuvable : {}",
            path.display()
        )));
    }
    if !crate::db::is_executable_name(&path.to_string_lossy()) {
        return Err(AppError::Invalid(
            "Ce fichier n'est pas un exécutable.".into(),
        ));
    }
    let scanned = tauri::async_runtime::spawn_blocking(move || exe_info::scan(&path))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(Some(scanned))
}

/// Pick a local cover image; it is copied into GameREZ's covers folder.
#[tauri::command]
pub async fn pick_cover(app: AppHandle, state: State<'_, AppState>) -> AppResult<Option<String>> {
    let picked = app
        .dialog()
        .file()
        .set_title("Choisir une jaquette")
        .add_filter("Image", &["png", "jpg", "jpeg", "webp", "gif", "avif"])
        .blocking_pick_file();
    let Some(fp) = picked else { return Ok(None) };
    let src = fp.into_path().map_err(|e| AppError::Other(e.to_string()))?;
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_else(|| "png".into());
    let size = std::fs::metadata(&src)?.len();
    if size > 20 * 1024 * 1024 {
        return Err(AppError::Invalid("Image trop lourde (20 Mo max).".into()));
    }
    std::fs::create_dir_all(&state.covers_dir)?;
    let name = format!("cover-{}.{ext}", chrono::Utc::now().timestamp_millis());
    let dest = state.covers_dir.join(name);
    std::fs::copy(&src, &dest)?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn list_launchers() -> AppResult<Vec<LauncherInfo>> {
    tauri::async_runtime::spawn_blocking(launchers::detect_all)
        .await
        .map_err(|e| AppError::Other(e.to_string()))
}

/// Open the official download page of a known launcher (allow-listed URLs only).
#[tauri::command]
pub fn open_launcher_download(app: AppHandle, id: String) -> AppResult<()> {
    let def = launchers::find(&id)?;
    app.opener()
        .open_url(def.download_url, None::<&str>)
        .map_err(|e| AppError::Other(format!("Navigateur indisponible : {e}")))
}

#[derive(Debug, Serialize)]
pub struct DriveInfo {
    pub mount: String,
    pub name: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub removable: bool,
}

#[tauri::command]
pub async fn list_drives() -> AppResult<Vec<DriveInfo>> {
    tauri::async_runtime::spawn_blocking(|| {
        let disks = sysinfo::Disks::new_with_refreshed_list();
        let mut out: Vec<DriveInfo> = disks
            .list()
            .iter()
            .map(|d| DriveInfo {
                mount: d.mount_point().to_string_lossy().into_owned(),
                name: d.name().to_string_lossy().into_owned(),
                total_bytes: d.total_space(),
                available_bytes: d.available_space(),
                removable: d.is_removable(),
            })
            .filter(|d| d.total_bytes > 0)
            .collect();
        out.sort_by(|a, b| a.mount.cmp(&b.mount));
        out.dedup_by(|a, b| a.mount == b.mount);
        out
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))
}

/// Validate a folder path for the "create it for me" helper.
pub fn validate_new_folder(path: &str) -> AppResult<PathBuf> {
    let p = PathBuf::from(path.trim().trim_matches('"'));
    if !p.is_absolute() {
        return Err(AppError::Invalid(
            "Le chemin doit être absolu (ex : D:\\Jeux).".into(),
        ));
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::Invalid("Chemin invalide.".into()));
    }
    let depth = p
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count();
    if depth == 0 {
        return Err(AppError::Invalid(
            "Choisis un sous-dossier, pas la racine du disque.".into(),
        ));
    }
    let lower = p.to_string_lossy().to_lowercase();
    if lower.contains("\\windows") || lower.contains("\\program files") {
        return Err(AppError::Invalid(
            "Crée plutôt tes dossiers hors de Windows / Program Files.".into(),
        ));
    }
    Ok(p)
}

/// Create a folder (e.g. `D:\Jeux\BattleNet`) for the tidy-PC assistant and open it.
#[tauri::command]
pub fn create_folder(app: AppHandle, path: String) -> AppResult<String> {
    let p = validate_new_folder(&path)?;
    std::fs::create_dir_all(&p)?;
    let _ = app.opener().open_path(p.to_string_lossy(), None::<&str>);
    Ok(p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn folder_validation() {
        assert!(validate_new_folder(r"D:\Jeux\BattleNet").is_ok());
        assert!(validate_new_folder(r"D:\").is_err());
        assert!(validate_new_folder(r"Jeux\Steam").is_err());
        assert!(validate_new_folder(r"D:\Jeux\..\Windows").is_err());
        assert!(validate_new_folder(r"C:\Windows\Jeux").is_err());
        assert!(validate_new_folder(r"C:\Program Files\Jeux").is_err());
    }
}
