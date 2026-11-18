//! GameREZ core: local game library, launcher and exact playtime tracker.

mod commands;
pub mod db;
pub mod error;
pub mod exe_info;
pub mod launchers;
pub mod watcher;

use std::sync::Arc;

use tauri::Manager;

use commands::AppState;
use db::Database;
use watcher::Tracker;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db = Database::open(&db::db_path(&data_dir))?;
            let recovered = db.recover_sessions()?;
            if recovered > 0 {
                eprintln!("[gamerez] recovered {recovered} interrupted session(s)");
            }
            app.manage(AppState {
                db: Arc::new(db),
                tracker: Arc::new(Tracker::default()),
                covers_dir: data_dir.join("covers"),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_games,
            commands::add_game,
            commands::update_game,
            commands::delete_game,
            commands::launch_game,
            commands::running_games,
            commands::open_folder,
            commands::scan_executable,
            commands::pick_cover,
            commands::list_launchers,
            commands::open_launcher_download,
            commands::list_drives,
            commands::create_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GameREZ");
}
