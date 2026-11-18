//! REZ launcher core: local game library, launcher and exact playtime tracker.

mod commands;
pub mod db;
pub mod detect;
pub mod error;
pub mod exe_info;
pub mod launchers;
pub mod settings;
pub mod social;
pub mod sysreg;
pub mod uninstall;
pub mod watcher;

use std::sync::{Arc, Mutex};

use tauri::Manager;

use commands::AppState;
use db::Database;
use watcher::Tracker;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            // Former name: GameREZ (io.github.gamerez). Import its data once.
            if let Some(parent) = data_dir.parent() {
                match db::migrate_legacy(&parent.join("io.github.gamerez"), &data_dir) {
                    Ok(true) => eprintln!("[rez] imported GameREZ library"),
                    Ok(false) => {}
                    Err(e) => eprintln!("[rez] GameREZ import failed: {e}"),
                }
            }
            let db = Arc::new(Database::open(&db::db_path(&data_dir))?);
            let recovered = db.recover_sessions()?;
            if recovered > 0 {
                eprintln!("[rez] recovered {recovered} interrupted session(s)");
            }
            commands::spawn_detection_loop(app.handle().clone(), db.clone());
            let social_on = settings::Settings::load(&db).social_enabled;
            app.manage(AppState {
                db,
                tracker: Arc::new(Tracker::default()),
                covers_dir: data_dir.join("covers"),
                data_dir,
                pending_update: Mutex::new(None),
                social: Arc::new(social::Social::default()),
                uninstalling: Arc::new(Mutex::new(Default::default())),
            });
            if social_on {
                let state = app.state::<AppState>();
                commands::sync_social(app.handle(), &state, true);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_games,
            commands::add_game,
            commands::fill_missing_covers,
            commands::update_game,
            commands::delete_game,
            commands::reorder_games,
            commands::uninstall_info,
            commands::uninstall_game,
            commands::uninstalling_games,
            commands::get_profile,
            commands::save_profile,
            commands::image_data_url,
            commands::social_state,
            commands::add_friend,
            commands::answer_friend,
            commands::remove_friend,
            commands::friend_profile,
            commands::launch_game,
            commands::running_games,
            commands::open_folder,
            commands::scan_executable,
            commands::pick_cover,
            commands::list_launchers,
            commands::open_launcher_download,
            commands::list_drives,
            commands::create_folder,
            commands::get_settings,
            commands::save_settings,
            commands::pick_folder,
            commands::pending_detections,
            commands::scan_games_now,
            commands::resolve_detections,
            commands::reset_ignored_detections,
            commands::clear_cache,
            commands::open_data_dir,
            commands::open_repo,
            commands::check_update,
            commands::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running REZ launcher");
}
