// Typed bridge to the Rust backend (Tauri commands + events).
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Category = "installed" | "not_installed" | "launcher";
/** Game, or software / utility (overlays, wallpaper, benchmarks…). */
export type Kind = "game" | "software";
export type Platform = "steam" | "epic" | "gog" | "ea" | "ubisoft" | "battlenet" | "rockstar" | "xbox" | "pc";

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
  /** Recorded play sessions for this game. */
  session_count: number;
  exe_missing: boolean;
  /** Shown on the back of the 3D game box. */
  description: string;
  /** Cover framing (cover editor): zoom 1..4 around a focal point in % of the image. */
  cover_zoom: number;
  cover_x: number;
  cover_y: number;
  kind: Kind;
  /** User category (free text). */
  collection: string;
  /** Store / launcher guessed from the install path. */
  platform: Platform;
  /** Manual order (drag & drop). */
  sort_order: number;
}

export interface GameInput {
  title: string;
  executable_path: string;
  install_dir: string;
  cover_image_url: string;
  version: string;
  category: Category;
  description: string;
  cover_zoom: number;
  cover_x: number;
  cover_y: number;
  kind: Kind;
  collection: string;
}

/** Editable payload of an existing game. */
export function toInput(g: Game, patch: Partial<GameInput> = {}): GameInput {
  const { title, executable_path, install_dir, cover_image_url, version, category, description, cover_zoom, cover_x, cover_y, kind, collection } = g;
  return { title, executable_path, install_dir, cover_image_url, version, category, description, cover_zoom, cover_x, cover_y, kind, collection, ...patch };
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

export interface GameReady {
  game_id: number;
  /** false when REZ launcher stopped waiting without seeing a game window. */
  window: boolean;
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

export type CardSize = "compact" | "normal" | "large";
export type StartView = "library" | "launchers";
export type LibraryView = "grid" | "box3d" | "carousel";
export type ThemeId = "steel" | "cyan" | "neon" | "carbon" | "ember" | "glacier";

export interface Settings {
  card_size: CardSize;
  animations: boolean;
  tilt: boolean;
  ambient: boolean;
  theme: ThemeId;
  glass: boolean;
  library_view: LibraryView;
  launch_animation: boolean;
  minimize_on_launch: boolean;
  restore_on_exit: boolean;
  check_updates_on_start: boolean;
  detect_new_games: boolean;
  search_paths: string[];
  start_view: StartView;
  launch_at_startup: boolean;
  /** Friends & presence on the local network (opt-in). */
  social_enabled: boolean;
}

/** A game found on disk by the read-only detector. */
export interface Detected {
  key: string;
  title: string;
  executable_path: string;
  install_dir: string;
  source: "steam" | "epic" | "gog" | "folder";
  kind: Kind;
}

export type DetectionAction = "add" | "ignore" | "later";

export interface UpdateInfo {
  version: string;
  current_version: string;
  notes: string;
  date: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

export interface UninstallPlan {
  via: "steam" | "registry" | "inno";
  detail: string;
}

export interface UninstallFinished {
  game_id: number;
  title: string;
  removed: boolean;
}

/** An image + its framing (zoom around a focal point, in %). */
export interface ImageFrame {
  url: string;
  zoom: number;
  x: number;
  y: number;
}

export interface Profile {
  id: string;
  name: string;
  bio: string;
  avatar: ImageFrame;
  banner: ImageFrame;
  /** Framed renders (data URLs) shared with friends. */
  avatar_thumb: string;
  banner_thumb: string;
  /** Pinned games (ids), in order. */
  showcase: number[];
}

export type Presence = "offline" | "online" | "ingame";

export interface PeerView {
  id: string;
  code: string;
  name: string;
  status: Presence;
  game: string;
}

export interface FriendView {
  id: string;
  code: string;
  name: string;
  avatar: string;
  state: "friend" | "incoming" | "outgoing";
  status: Presence;
  game: string;
}

export interface SocialState {
  enabled: boolean;
  error: string | null;
  me: { id: string; code: string; name: string };
  peers: PeerView[];
  friends: FriendView[];
}

export interface PublicProfile {
  id: string;
  name: string;
  bio: string;
  avatar: string;
  banner: string;
  status: Presence;
  game: string;
  showcase: { title: string; playtime_minutes: number; cover: string }[];
}

export interface CacheReport {
  files_removed: number;
  bytes_freed: number;
}

const tauriApi = {
  listGames: () => invoke<Game[]>("list_games"),
  addGame: (input: GameInput) => invoke<Game>("add_game", { input }),
  fillMissingCovers: () => invoke<Game[]>("fill_missing_covers"),
  updateGame: (id: number, input: GameInput) => invoke<Game>("update_game", { id, input }),
  deleteGame: (id: number) => invoke<void>("delete_game", { id }),
  reorderGames: (ids: number[]) => invoke<void>("reorder_games", { ids }),
  uninstallInfo: (id: number) => invoke<UninstallPlan | null>("uninstall_info", { id }),
  uninstallGame: (id: number) => invoke<void>("uninstall_game", { id }),
  uninstallingGames: () => invoke<number[]>("uninstalling_games"),
  getProfile: () => invoke<Profile>("get_profile"),
  saveProfile: (profile: Profile) => invoke<Profile>("save_profile", { profile }),
  imageDataUrl: (path: string) => invoke<string>("image_data_url", { path }),
  socialState: () => invoke<SocialState>("social_state"),
  addFriend: (id: string) => invoke<"friend" | "outgoing">("add_friend", { id }),
  answerFriend: (id: string, accept: boolean) => invoke<void>("answer_friend", { id, accept }),
  removeFriend: (id: string) => invoke<void>("remove_friend", { id }),
  friendProfile: (id: string) => invoke<PublicProfile>("friend_profile", { id }),
  launchGame: (id: number) => invoke<RunningGame>("launch_game", { id }),
  runningGames: () => invoke<RunningGame[]>("running_games"),
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  scanExecutable: (path?: string) => invoke<ScannedExe | null>("scan_executable", { path: path ?? null }),
  pickCover: () => invoke<string | null>("pick_cover"),
  listLaunchers: () => invoke<LauncherInfo[]>("list_launchers"),
  openLauncherDownload: (id: string) => invoke<void>("open_launcher_download", { id }),
  listDrives: () => invoke<DriveInfo[]>("list_drives"),
  createFolder: (path: string) => invoke<string>("create_folder", { path }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  pickFolder: () => invoke<string | null>("pick_folder"),
  pendingDetections: () => invoke<Detected[]>("pending_detections"),
  scanGamesNow: () => invoke<Detected[]>("scan_games_now"),
  resolveDetections: (keys: string[], action: DetectionAction) =>
    invoke<Game[]>("resolve_detections", { keys, action }),
  resetIgnoredDetections: () => invoke<number>("reset_ignored_detections"),
  clearCache: () => invoke<CacheReport>("clear_cache"),
  openDataDir: () => invoke<void>("open_data_dir"),
  openRepo: () => invoke<void>("open_repo"),
  checkUpdate: () => invoke<UpdateInfo | null>("check_update"),
  installUpdate: () => invoke<void>("install_update"),
};

const tauriEvents = {
  onGameStarted: (cb: (p: RunningGame) => void): Promise<UnlistenFn> =>
    listen<RunningGame>("game-started", (e) => cb(e.payload)),
  onGameReady: (cb: (p: GameReady) => void): Promise<UnlistenFn> =>
    listen<GameReady>("game-ready", (e) => cb(e.payload)),
  onGameStopped: (cb: (p: GameStopped) => void): Promise<UnlistenFn> =>
    listen<GameStopped>("game-stopped", (e) => cb(e.payload)),
  onGamesDetected: (cb: (p: Detected[]) => void): Promise<UnlistenFn> =>
    listen<Detected[]>("games-detected", (e) => cb(e.payload)),
  onGameUninstalled: (cb: (p: UninstallFinished) => void): Promise<UnlistenFn> =>
    listen<UninstallFinished>("game-uninstalled", (e) => cb(e.payload)),
  onSocialUpdated: (cb: () => void): Promise<UnlistenFn> => listen("social-updated", () => cb()),
  onUpdateProgress: (cb: (p: UpdateProgress) => void): Promise<UnlistenFn> =>
    listen<UpdateProgress>("update-progress", (e) => cb(e.payload)),
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
