//! Tauri commands exposed to the frontend.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

use crate::db::{Category, Database, Detected, Game, GameInput};
use crate::detect;
use crate::error::{AppError, AppResult};
use crate::exe_info::{self, ScannedExe};
use crate::launchers::{self, LauncherInfo};
use crate::settings::Settings;
use crate::social::{self, Profile, PublicProfile, Social, SocialState};
use crate::sysreg;
use crate::uninstall::{self, UninstallFinished, UninstallPlan};
use crate::watcher::{self, RunningGame, Tracker};

pub const REPO_URL: &str = "https://github.com/reztsk/REZ-LAUNCHER";

pub struct AppState {
    pub db: Arc<Database>,
    pub tracker: Arc<Tracker>,
    pub data_dir: PathBuf,
    pub covers_dir: PathBuf,
    pub pending_update: Mutex<Option<tauri_plugin_updater::Update>>,
    pub social: Arc<Social>,
    /// Games whose official uninstaller is running.
    pub uninstalling: Arc<Mutex<HashSet<i64>>>,
}

#[tauri::command]
pub fn list_games(state: State<'_, AppState>) -> AppResult<Vec<Game>> {
    state.db.list_games()
}

#[tauri::command]
pub fn add_game(state: State<'_, AppState>, mut input: GameInput) -> AppResult<Game> {
    if input.cover_image_url.trim().is_empty() {
        if let Some(url) = detect::auto_cover(&input.install_dir, &input.executable_path) {
            input.cover_image_url = url;
        }
    }
    state.db.insert_game(input)
}

/// Give a cover to every game that has none and can get one automatically
/// (official Steam artwork, found from the read-only Steam manifests).
/// Returns the games that changed.
#[tauri::command]
pub async fn fill_missing_covers(state: State<'_, AppState>) -> AppResult<Vec<Game>> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut changed = Vec::new();
        for g in db.list_games()? {
            if !g.cover_image_url.is_empty() || g.category == Category::Launcher {
                continue;
            }
            if let Some(url) = detect::auto_cover(&g.install_dir, &g.executable_path) {
                if db.set_cover_if_empty(g.id, &url)? {
                    changed.push(db.get_game(g.id)?);
                }
            }
        }
        Ok(changed)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
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
    // Remove the cover only if REZ launcher owns it (copied into its covers folder).
    let cover = Path::new(&game.cover_image_url);
    if cover.starts_with(&state.covers_dir) {
        let _ = std::fs::remove_file(cover);
    }
    Ok(())
}

/// Save the manual order of the library (drag & drop).
#[tauri::command]
pub fn reorder_games(state: State<'_, AppState>, ids: Vec<i64>) -> AppResult<()> {
    if ids.len() > 10_000 {
        return Err(AppError::Invalid("Liste trop longue.".into()));
    }
    state.db.reorder_games(&ids)
}

// ================================================================ Uninstall

/// How a game would be uninstalled (`None`: no official uninstaller found).
#[tauri::command]
pub async fn uninstall_info(
    state: State<'_, AppState>,
    id: i64,
) -> AppResult<Option<UninstallPlan>> {
    let game = state.db.get_game(id)?;
    tauri::async_runtime::spawn_blocking(move || {
        uninstall::find(&game, &sysreg::uninstall_entries()).map(|(_, plan)| plan)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))
}

/// Run the game's official uninstaller in the background. When it is done and
/// the game is gone from disk, the game leaves the library; `game-uninstalled`
/// is emitted either way.
#[tauri::command]
pub fn uninstall_game(app: AppHandle, state: State<'_, AppState>, id: i64) -> AppResult<()> {
    if state.tracker.list().iter().any(|r| r.game_id == id) {
        return Err(AppError::Invalid(
            "Ferme le jeu avant de le désinstaller.".into(),
        ));
    }
    let game = state.db.get_game(id)?;
    let (method, _) = uninstall::find(&game, &sysreg::uninstall_entries()).ok_or_else(|| {
        AppError::Invalid(
            "Aucun désinstallateur officiel trouvé pour ce jeu. Désinstalle-le depuis son launcher ou les Paramètres Windows.".into(),
        )
    })?;
    if !state
        .uninstalling
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id)
    {
        return Err(AppError::Invalid("Désinstallation déjà en cours.".into()));
    }
    let busy = state.uninstalling.clone();
    let release = move || {
        busy.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    };
    let started = match &method {
        uninstall::Method::Steam(app_id) => app
            .opener()
            .open_url(format!("steam://uninstall/{app_id}"), None::<&str>)
            .map(|_| None)
            .map_err(|e| AppError::Other(format!("Steam indisponible : {e}"))),
        uninstall::Method::Command { program, args } => uninstall::start(program, args).map(Some),
    };
    let pid = match started {
        Ok(p) => p,
        Err(e) => {
            release();
            return Err(e);
        }
    };
    let db = state.db.clone();
    let covers_dir = state.covers_dir.clone();
    std::thread::spawn(move || {
        let removed = match pid {
            Some(pid) => {
                uninstall::wait_process_tree(pid, std::time::Duration::from_secs(2 * 3600));
                std::thread::sleep(std::time::Duration::from_secs(2));
                uninstall::is_gone(&game)
            }
            // Steam: the user confirms in Steam, then Steam deletes the files.
            None => uninstall::wait_until_gone(&game, std::time::Duration::from_secs(15 * 60)),
        };
        if removed && db.delete_game(game.id).is_ok() {
            let cover = Path::new(&game.cover_image_url);
            if cover.starts_with(&covers_dir) {
                let _ = std::fs::remove_file(cover);
            }
        }
        release();
        let _ = app.emit(
            "game-uninstalled",
            UninstallFinished {
                game_id: game.id,
                title: game.title.clone(),
                removed,
            },
        );
    });
    Ok(())
}

#[tauri::command]
pub fn uninstalling_games(state: State<'_, AppState>) -> Vec<i64> {
    state
        .uninstalling
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .copied()
        .collect()
}

// ================================================================ Profile & friends

#[tauri::command]
pub fn get_profile(state: State<'_, AppState>) -> Profile {
    Profile::load(&state.db)
}

#[tauri::command]
pub fn save_profile(state: State<'_, AppState>, profile: Profile) -> AppResult<Profile> {
    let current = Profile::load(&state.db);
    let mut p = profile.normalized()?;
    p.id = current.id; // the id never changes
    p.save(&state.db)?;
    Ok(p)
}

/// A local image imported into REZ launcher (covers folder only), as a data URL,
/// so the UI can render small framed thumbnails of the avatar and banner.
#[tauri::command]
pub fn image_data_url(state: State<'_, AppState>, path: String) -> AppResult<String> {
    let p = std::fs::canonicalize(path.trim())
        .map_err(|_| AppError::Invalid("Image introuvable.".into()))?;
    let root = std::fs::canonicalize(&state.covers_dir)
        .map_err(|_| AppError::Invalid("Image introuvable.".into()))?;
    if !p.starts_with(&root) {
        return Err(AppError::Invalid(
            "Image hors du dossier de REZ launcher.".into(),
        ));
    }
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        _ => {
            return Err(AppError::Invalid(
                "Format d'image non pris en charge.".into(),
            ))
        }
    };
    if std::fs::metadata(&p)?.len() > 20 * 1024 * 1024 {
        return Err(AppError::Invalid("Image trop lourde (20 Mo max).".into()));
    }
    Ok(format!(
        "data:{mime};base64,{}",
        social::base64(&std::fs::read(&p)?)
    ))
}

pub fn social_ctx(app: &AppHandle, state: &AppState) -> social::Ctx {
    let emitter = app.clone();
    social::Ctx {
        db: state.db.clone(),
        tracker: state.tracker.clone(),
        notify: Arc::new(move || {
            let _ = emitter.emit("social-updated", ());
        }),
    }
}

/// Start / stop the local network presence to match the settings.
pub fn sync_social(app: &AppHandle, state: &AppState, enabled: bool) {
    if enabled {
        state.social.start(social_ctx(app, state));
    } else {
        state.social.stop();
    }
    let _ = app.emit("social-updated", ());
}

#[tauri::command]
pub fn social_state(state: State<'_, AppState>) -> SocialState {
    state.social.state(&state.db)
}

fn online_addr(state: &AppState, id: &str) -> AppResult<std::net::SocketAddr> {
    if !state.social.is_on() {
        return Err(AppError::Invalid(
            "Active d'abord les amis (réseau local).".into(),
        ));
    }
    state.social.peer_addr(id).ok_or_else(|| {
        AppError::Invalid(
            "Cette personne n'est pas visible sur ton réseau local en ce moment.".into(),
        )
    })
}

/// Send a friend request to someone visible on the network (by id or friend code).
#[tauri::command]
pub async fn add_friend(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<String> {
    let id = social::parse_code(&id).ok_or_else(|| {
        AppError::Invalid("Code ami invalide (format REZ-XXXX-XXXX-XXXX).".into())
    })?;
    if id == Profile::load(&state.db).id {
        return Err(AppError::Invalid("C'est ton propre code ami.".into()));
    }
    let addr = online_addr(&state, &id)?;
    let db = state.db.clone();
    let body = social::identity(&db, "friend_req");
    let reply = tauri::async_runtime::spawn_blocking(move || social::request(addr, &body))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    if reply.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(AppError::Other(
            "Demande refusée par l'autre REZ launcher.".into(),
        ));
    }
    let final_state = if reply.get("state").and_then(|v| v.as_str()) == Some("friend") {
        "friend"
    } else {
        "outgoing"
    };
    let name = state
        .social
        .state(&db)
        .peers
        .iter()
        .find(|p| p.id == id)
        .map(|p| p.name.clone())
        .unwrap_or_else(|| "Ami".into());
    db.upsert_friend(&id, &name, "", final_state)?;
    let _ = app.emit("social-updated", ());
    Ok(final_state.into())
}

/// Accept or decline a request.
#[tauri::command]
pub async fn answer_friend(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    accept: bool,
) -> AppResult<()> {
    if !accept {
        state.db.remove_friend(&id)?;
        let _ = app.emit("social-updated", ());
        return Ok(());
    }
    if state.db.friend_state(&id)?.is_none() {
        return Err(AppError::Invalid("Demande introuvable.".into()));
    }
    let addr = online_addr(&state, &id)?;
    let body = social::identity(&state.db, "friend_ok");
    tauri::async_runtime::spawn_blocking(move || social::request(addr, &body))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    let name = state
        .db
        .list_friends()?
        .into_iter()
        .find(|f| f.id == id)
        .map(|f| f.name)
        .unwrap_or_default();
    state.db.upsert_friend(&id, &name, "", "friend")?;
    let _ = app.emit("social-updated", ());
    Ok(())
}

#[tauri::command]
pub async fn remove_friend(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    if let Some(addr) = state.social.peer_addr(&id) {
        let body = social::identity(&state.db, "unfriend");
        let _ = tauri::async_runtime::spawn_blocking(move || social::request(addr, &body)).await;
    }
    state.db.remove_friend(&id)?;
    let _ = app.emit("social-updated", ());
    Ok(())
}

/// Someone's profile, fetched live from their PC.
#[tauri::command]
pub async fn friend_profile(state: State<'_, AppState>, id: String) -> AppResult<PublicProfile> {
    let addr = online_addr(&state, &id)?;
    let db = state.db.clone();
    let p = tauri::async_runtime::spawn_blocking(move || social::fetch_profile(addr))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    if p.id != id {
        return Err(AppError::Other(
            "Profil reçu d'un autre REZ launcher.".into(),
        ));
    }
    let _ = db.refresh_friend(&id, &p.name, &p.avatar);
    Ok(p)
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

/// Pick a local cover image; it is copied into REZ launcher's covers folder.
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

// ================================================================ Settings

#[tauri::command]
pub fn get_settings(app: AppHandle, state: State<'_, AppState>) -> Settings {
    let mut s = Settings::load(&state.db);
    if let Ok(on) = app.autolaunch().is_enabled() {
        s.launch_at_startup = on;
    }
    s
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> AppResult<Settings> {
    let mut s = settings.normalized()?;
    let auto = app.autolaunch();
    if auto.is_enabled().ok() != Some(s.launch_at_startup) {
        let res = if s.launch_at_startup {
            auto.enable()
        } else {
            auto.disable()
        };
        if let Err(e) = res {
            s.launch_at_startup = !s.launch_at_startup;
            s.save(&state.db)?;
            return Err(AppError::Other(format!("Démarrage automatique : {e}")));
        }
    }
    s.save(&state.db)?;
    if s.social_enabled != state.social.is_on() {
        sync_social(&app, &state, s.social_enabled);
    }
    Ok(s)
}

/// Native folder picker (for game search folders).
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> AppResult<Option<String>> {
    let picked = app
        .dialog()
        .file()
        .set_title("Choisir un dossier de jeux")
        .blocking_pick_folder();
    match picked {
        Some(fp) => Ok(Some(
            fp.into_path()
                .map_err(|e| AppError::Other(e.to_string()))?
                .to_string_lossy()
                .into_owned(),
        )),
        None => Ok(None),
    }
}

// =========================================================== Game detection

/// Folders and executables already in the library (never proposed again).
fn library_keys(games: &[Game]) -> (HashSet<String>, HashSet<String>) {
    let mut dirs = HashSet::new();
    let mut exes = HashSet::new();
    for g in games {
        if !g.install_dir.is_empty() {
            dirs.insert(detect::key_for(Path::new(&g.install_dir)));
        }
        if !g.executable_path.is_empty() {
            exes.insert(g.executable_path.to_lowercase());
            if let Some(parent) = Path::new(&g.executable_path).parent() {
                dirs.insert(detect::key_for(parent));
            }
        }
    }
    (dirs, exes)
}

fn in_library(d: &Detected, dirs: &HashSet<String>, exes: &HashSet<String>) -> bool {
    let prefix = format!("{}\\", d.key);
    exes.contains(&d.executable_path.to_lowercase())
        || dirs.contains(&d.key)
        || dirs.iter().any(|k| k.starts_with(&prefix))
}

/// One read-only scan. New games are stored as `pending` and returned.
pub fn detection_pass(db: &Database, search_paths: &[String]) -> AppResult<Vec<Detected>> {
    let games = db.list_games()?;
    let (dirs, exes) = library_keys(&games);
    let mut skip: HashSet<String> = db.detection_statuses()?.into_keys().collect();
    skip.extend(dirs.iter().cloned());
    let found: Vec<Detected> = detect::scan(search_paths, &skip)
        .into_iter()
        .filter(|d| !in_library(d, &dirs, &exes))
        .collect();
    db.insert_detections(&found, "pending")?;
    Ok(found)
}

/// Background loop: scan every 90 s and notify the UI about new games.
pub fn spawn_detection_loop(app: AppHandle, db: Arc<Database>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(6)).await;
        loop {
            let settings = Settings::load(&db);
            if settings.detect_new_games {
                let db2 = db.clone();
                let res = tauri::async_runtime::spawn_blocking(move || {
                    detection_pass(&db2, &settings.search_paths)
                })
                .await;
                match res {
                    Ok(Ok(found)) if !found.is_empty() => {
                        let _ = app.emit("games-detected", &found);
                    }
                    Ok(Err(e)) => eprintln!("[rez] detection failed: {e}"),
                    _ => {}
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(90)).await;
        }
    });
}

/// Games detected but not answered yet (shown in the pop-up).
#[tauri::command]
pub fn pending_detections(state: State<'_, AppState>) -> AppResult<Vec<Detected>> {
    let games = state.db.list_games()?;
    let (dirs, exes) = library_keys(&games);
    Ok(state
        .db
        .detections_with_status(&["pending"])?
        .into_iter()
        .filter(|d| !in_library(d, &dirs, &exes))
        .collect())
}

/// "Scanner maintenant": every installed game not in the library and not ignored.
#[tauri::command]
pub async fn scan_games_now(state: State<'_, AppState>) -> AppResult<Vec<Detected>> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let settings = Settings::load(&db);
        detection_pass(&db, &settings.search_paths)?;
        let games = db.list_games()?;
        let (dirs, exes) = library_keys(&games);
        Ok(db
            .detections_with_status(&["pending", "seen"])?
            .into_iter()
            .filter(|d| !in_library(d, &dirs, &exes) && Path::new(&d.executable_path).is_file())
            .collect())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// Answer the pop-up: `add` creates library entries (shortcuts only),
/// `ignore` never proposes them again, `later` keeps them for a manual scan.
#[tauri::command]
pub fn resolve_detections(
    state: State<'_, AppState>,
    keys: Vec<String>,
    action: String,
) -> AppResult<Vec<Game>> {
    match action.as_str() {
        "add" => {
            let mut added = Vec::new();
            let mut done = Vec::new();
            for key in keys {
                let Some(d) = state.db.get_detection(&key)? else {
                    continue;
                };
                let version = exe_info::scan(Path::new(&d.executable_path)).version;
                let cover = detect::auto_cover(&d.install_dir, &d.executable_path);
                added.push(state.db.insert_game(GameInput {
                    title: d.title,
                    executable_path: d.executable_path,
                    install_dir: d.install_dir,
                    cover_image_url: cover.unwrap_or_default(),
                    version,
                    category: Category::Installed,
                    description: String::new(),
                    cover_zoom: 1.0,
                    cover_x: 50.0,
                    cover_y: 50.0,
                    kind: d.kind,
                    collection: String::new(),
                })?);
                done.push(key);
            }
            state.db.set_detection_status(&done, "added")?;
            Ok(added)
        }
        "ignore" => {
            state.db.set_detection_status(&keys, "ignored")?;
            Ok(Vec::new())
        }
        "later" => {
            state.db.set_detection_status(&keys, "seen")?;
            Ok(Vec::new())
        }
        other => Err(AppError::Invalid(format!("Action inconnue : {other}"))),
    }
}

#[tauri::command]
pub fn reset_ignored_detections(state: State<'_, AppState>) -> AppResult<usize> {
    state.db.reset_ignored_detections()
}

// ================================================================ Data / cache

#[derive(Debug, Serialize)]
pub struct CacheReport {
    pub files_removed: usize,
    pub bytes_freed: u64,
}

/// Remove covers no game uses anymore (only inside REZ launcher's own folder)
/// and the web cache of remote covers. Library and playtime are kept.
#[tauri::command]
pub fn clear_cache(app: AppHandle, state: State<'_, AppState>) -> AppResult<CacheReport> {
    let profile = Profile::load(&state.db);
    let used: HashSet<String> = state
        .db
        .cover_paths()?
        .into_iter()
        .chain([profile.avatar.url, profile.banner.url])
        .map(|p| p.to_lowercase())
        .collect();
    let mut report = CacheReport {
        files_removed: 0,
        bytes_freed: 0,
    };
    if let Ok(entries) = std::fs::read_dir(&state.covers_dir) {
        for e in entries.flatten() {
            let p = e.path();
            if !e.file_type().is_ok_and(|t| t.is_file())
                || used.contains(&p.to_string_lossy().to_lowercase())
            {
                continue;
            }
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            if std::fs::remove_file(&p).is_ok() {
                report.files_removed += 1;
                report.bytes_freed += size;
            }
        }
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.clear_all_browsing_data();
    }
    Ok(report)
}

#[tauri::command]
pub fn open_data_dir(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    app.opener()
        .open_path(state.data_dir.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::Other(format!("Ouverture impossible : {e}")))
}

#[tauri::command]
pub fn open_repo(app: AppHandle) -> AppResult<()> {
    app.opener()
        .open_url(REPO_URL, None::<&str>)
        .map_err(|e| AppError::Other(format!("Navigateur indisponible : {e}")))
}

// ================================================================== Updates

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: String,
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// Ask GitHub Releases (signed `latest.json`) whether a newer version exists.
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Option<UpdateInfo>> {
    let updater = app
        .updater()
        .map_err(|e| AppError::Other(format!("Mise à jour indisponible : {e}")))?;
    let update = updater
        .check()
        .await
        .map_err(|e| AppError::Other(format!("Vérification impossible : {e}")))?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone().unwrap_or_default(),
        date: u.date.map(|d| d.to_string()),
    });
    *state
        .pending_update
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = update;
    Ok(info)
}

/// Download the signed installer, verify it, install it and restart.
#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    if !state.tracker.list().is_empty() {
        return Err(AppError::Invalid(
            "Ferme ton jeu avant de mettre à jour (session en cours).".into(),
        ));
    }
    let update = state
        .pending_update
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
        .ok_or_else(|| AppError::Invalid("Aucune mise à jour en attente.".into()))?;
    let mut downloaded = 0u64;
    let emitter = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = emitter.emit("update-progress", UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| AppError::Other(format!("Installation impossible : {e}")))?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game(dir: &str, exe: &str) -> Game {
        Game {
            id: 1,
            title: "G".into(),
            executable_path: exe.into(),
            install_dir: dir.into(),
            cover_image_url: String::new(),
            version: String::new(),
            playtime_minutes: 0,
            category: Category::Installed,
            added_at: String::new(),
            last_played_at: None,
            session_count: 0,
            exe_missing: false,
            description: String::new(),
            cover_zoom: 1.0,
            cover_x: 50.0,
            cover_y: 50.0,
            kind: crate::db::Kind::Game,
            collection: String::new(),
            platform: "pc".into(),
            sort_order: 0,
        }
    }

    #[cfg(windows)]
    #[test]
    fn detections_already_in_library_are_filtered() {
        let (dirs, exes) = library_keys(&[
            game(r"D:\Jeux\Hades", r"D:\Jeux\Hades\x64\Hades.exe"),
            game(r"D:\Jeux\Other\bin", r"D:\Jeux\Other\bin\o.exe"),
            game(r"D:\Jeux\Steam", r"D:\Jeux\Steam\steam.exe"),
        ]);
        let d = |dir: &str, exe: &str| Detected {
            key: detect::key_for(Path::new(dir)),
            title: "x".into(),
            executable_path: exe.into(),
            install_dir: dir.into(),
            source: "folder".into(),
            kind: Default::default(),
        };
        assert!(in_library(
            &d(r"d:\jeux\hades", r"D:\Jeux\Hades\x64\Hades.exe"),
            &dirs,
            &exes
        ));
        // Library entry points inside the detected folder.
        assert!(in_library(
            &d(r"D:\Jeux\Other", r"D:\Jeux\Other\o.exe"),
            &dirs,
            &exes
        ));
        // A game inside a launcher folder that is in the library is still new.
        assert!(!in_library(
            &d(
                r"D:\Jeux\Steam\steamapps\common\Portal",
                r"D:\Jeux\Steam\steamapps\common\Portal\portal.exe"
            ),
            &dirs,
            &exes
        ));
    }

    #[test]
    fn detection_pass_stores_new_games_once() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("Jeux");
        std::fs::create_dir_all(root.join("Neon")).unwrap();
        std::fs::write(root.join("Neon").join("neon.exe"), b"x").unwrap();
        let db = Database::open_in_memory().unwrap();
        let paths = vec![root.to_string_lossy().into_owned()];
        let first = detection_pass(&db, &paths).unwrap();
        assert!(first.iter().any(|d| d.title == "Neon"));
        // Second pass: already known, nothing new to notify.
        let second = detection_pass(&db, &paths).unwrap();
        assert!(second.iter().all(|d| d.title != "Neon"));
    }

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
