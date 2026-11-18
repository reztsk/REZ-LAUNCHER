// Typed bridge to the Rust backend (Tauri commands + events).
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Category = "installed" | "not_installed" | "launcher";

export interface Game {
  id: number;
  title: string;
  executable_path: string;
  install_dir: string;
  cover_image_url: string;
  version: string;
  playtime_minutes: number;
  category: Category;
  added_at: string;
  last_played_at: string | null;
  exe_missing: boolean;
}

export interface GameInput {
  title: string;
  executable_path: string;
  install_dir: string;
  cover_image_url: string;
  version: string;
  category: Category;
}

export interface ScannedExe {
  title: string;
  executable_path: string;
  install_dir: string;
  version: string;
}

export interface RunningGame {
  game_id: number;
  started_at: string;
}

export interface GameStopped {
  game: Game;
  session_seconds: number;
}

export interface LauncherInfo {
  id: string;
  name: string;
  publisher: string;
  download_url: string;
  recommended_folder: string;
  detected_exe: string | null;
}

export interface DriveInfo {
  mount: string;
  name: string;
  total_bytes: number;
  available_bytes: number;
  removable: boolean;
}

const tauriApi = {
  listGames: () => invoke<Game[]>("list_games"),
  addGame: (input: GameInput) => invoke<Game>("add_game", { input }),
  updateGame: (id: number, input: GameInput) => invoke<Game>("update_game", { id, input }),
  deleteGame: (id: number) => invoke<void>("delete_game", { id }),
  launchGame: (id: number) => invoke<RunningGame>("launch_game", { id }),
  runningGames: () => invoke<RunningGame[]>("running_games"),
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  scanExecutable: (path?: string) => invoke<ScannedExe | null>("scan_executable", { path: path ?? null }),
  pickCover: () => invoke<string | null>("pick_cover"),
  listLaunchers: () => invoke<LauncherInfo[]>("list_launchers"),
  openLauncherDownload: (id: string) => invoke<void>("open_launcher_download", { id }),
  listDrives: () => invoke<DriveInfo[]>("list_drives"),
  createFolder: (path: string) => invoke<string>("create_folder", { path }),
};

const tauriEvents = {
  onGameStarted: (cb: (p: RunningGame) => void): Promise<UnlistenFn> =>
    listen<RunningGame>("game-started", (e) => cb(e.payload)),
  onGameStopped: (cb: (p: GameStopped) => void): Promise<UnlistenFn> =>
    listen<GameStopped>("game-stopped", (e) => cb(e.payload)),
};

export type Api = typeof tauriApi;
export type Events = typeof tauriEvents;

// Live bindings: swapped for an in-memory mock when previewed outside Tauri.
export let api: Api = tauriApi;
export let events: Events = tauriEvents;
export function installMock(mockApi: Api, mockEvents: Events): void {
  api = mockApi;
  events = mockEvents;
}

/** Resolve a cover: remote URL as-is, local file through Tauri's asset protocol. */
export function coverSrc(url: string): string | null {
  if (!url) return null;
  if (/^(https?:|data:)/i.test(url)) return url;
  return isTauri() ? convertFileSrc(url) : null;
}

/** True when running inside the Tauri webview (false in a plain browser preview). */
export const isTauri = (): boolean => "__TAURI_INTERNALS__" in window;
