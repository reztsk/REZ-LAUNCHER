// In-memory backend used only when the UI is opened in a plain browser
// (`npm run dev` without Tauri) — handy for UI work and screenshots.
import type { Api, Detected, Events, Game, GameInput, GameReady, GameStopped, RunningGame, Settings, UpdateProgress } from "./api";

/** Demo artwork (SVG data URL) so covers, the 3D box and the editor have real images. */
function art(title: string, a: string, b: string, wide = false): string {
  const [w, h] = wide ? [1600, 900] : [600, 800];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="#050506"/></linearGradient>
    <radialGradient id="s" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="${b}" stop-opacity="0"/></radialGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${w * 0.62}" cy="${h * 0.36}" r="${h * 0.22}" fill="url(#s)" opacity=".85"/>
    <path d="M0 ${h * 0.72} L${w * 0.18} ${h * 0.5} L${w * 0.34} ${h * 0.66} L${w * 0.55} ${h * 0.42} L${w * 0.8} ${h * 0.68} L${w} ${h * 0.55} V${h} H0Z" fill="#0b0b0e" opacity=".92"/>
    <path d="M0 ${h * 0.86} L${w * 0.3} ${h * 0.7} L${w * 0.62} ${h * 0.84} L${w} ${h * 0.72} V${h} H0Z" fill="#000"/>
    <text x="50%" y="${h * 0.16}" text-anchor="middle" font-family="Segoe UI, sans-serif" font-weight="800" font-size="${h * 0.075}" letter-spacing="6" fill="#fff">${title.toUpperCase()}</text>
  </svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}
const framing = { description: "", cover_zoom: 1, cover_x: 50, cover_y: 50 };

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const H = 3_600_000;

let nextId = 7;
const games: Game[] = [
  { id: 1, title: "Neon Drift", executable_path: "D:\\Jeux\\Steam\\steamapps\\common\\Neon Drift\\NeonDrift.exe", install_dir: "D:\\Jeux\\Steam\\steamapps\\common\\Neon Drift", cover_image_url: art("Neon Drift", "#0e7490", "#22d3ee"), version: "1.4.2", playtime_minutes: 2535, category: "installed", added_at: iso(900 * H), last_played_at: iso(3 * H), exe_missing: false, session_count: 37, ...framing, description: "Course futuriste dans une mégapole de néons. Drift, boost et duels en ligne à 200 km/h.\n\nObjectif : finir la ligue Platine." },
  { id: 2, title: "Hollow Depths", executable_path: "D:\\Jeux\\GOGGalaxy\\Games\\Hollow Depths\\hollow.exe", install_dir: "D:\\Jeux\\GOGGalaxy\\Games\\Hollow Depths", cover_image_url: art("Hollow Depths", "#3f3f46", "#e4e4e7"), version: "1.5.78", playtime_minutes: 4210, category: "installed", added_at: iso(1200 * H), last_played_at: iso(30 * H), exe_missing: false, session_count: 52, ...framing },
  { id: 3, title: "Starfall Tactics", executable_path: "", install_dir: "", cover_image_url: "", version: "", playtime_minutes: 610, category: "not_installed", added_at: iso(400 * H), last_played_at: iso(800 * H), exe_missing: false, session_count: 9, ...framing },
  { id: 4, title: "Steam", executable_path: "D:\\Jeux\\Steam\\steam.exe", install_dir: "D:\\Jeux\\Steam", cover_image_url: "", version: "", playtime_minutes: 0, category: "launcher", added_at: iso(1500 * H), last_played_at: null, exe_missing: false, session_count: 0, ...framing },
  { id: 5, title: "Circuit Breakers", executable_path: "D:\\Jeux\\EpicGames\\Games\\CircuitBreakers\\CB-Win64-Shipping.exe", install_dir: "D:\\Jeux\\EpicGames\\Games\\CircuitBreakers", cover_image_url: art("Circuit Breakers", "#b45309", "#fbbf24"), version: "2.0.1", playtime_minutes: 95, category: "installed", added_at: iso(50 * H), last_played_at: iso(48 * H), exe_missing: false, session_count: 3, ...framing },
  { id: 6, title: "Pixel Odyssey", executable_path: "", install_dir: "", cover_image_url: "", version: "", playtime_minutes: 0, category: "not_installed", added_at: iso(10 * H), last_played_at: null, exe_missing: false, session_count: 0, ...framing },
];
const running = new Map<number, RunningGame>();
const params = new URLSearchParams(location.search);
let settings: Settings = {
  card_size: "normal",
  animations: true,
  tilt: true,
  ambient: true,
  check_updates_on_start: true,
  detect_new_games: true,
  search_paths: ["D:\\Jeux"],
  start_view: (params.get("view") as Settings["start_view"]) ?? "library",
  launch_at_startup: false,
  theme: (params.get("theme") as Settings["theme"]) ?? "steel",
  glass: true,
  library_view: (params.get("mode") as Settings["library_view"]) ?? "grid",
  launch_animation: true,
  minimize_on_launch: true,
  restore_on_exit: true,
};
const det = (title: string, source: Detected["source"], dir: string, exe: string): Detected => ({
  key: dir.toLowerCase(),
  title,
  executable_path: `${dir}\\${exe}`,
  install_dir: dir,
  source,
});
let detections: Detected[] = [
  det("Portal 2", "steam", "D:\\Jeux\\Steam\\steamapps\\common\\Portal 2", "portal2.exe"),
  det("Hades", "epic", "D:\\Jeux\\EpicGames\\Games\\Hades", "x64\\Hades.exe"),
  det("Celeste", "folder", "D:\\Jeux\\Celeste", "Celeste.exe"),
];
const progressCbs: ((p: UpdateProgress) => void)[] = [];
const startedCbs: ((p: RunningGame) => void)[] = [];
const readyCbs: ((p: GameReady) => void)[] = [];
const stoppedCbs: ((p: GameStopped) => void)[] = [];

const delay = <T>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const find = (id: number) => {
  const g = games.find((x) => x.id === id);
  if (!g) throw new Error(`Jeu introuvable (id ${id})`);
  return g;
};
const apply = (g: Game, i: GameInput) => Object.assign(g, i, { title: i.title.trim() });

export const mockApi: Api = {
  listGames: () => delay(games),
  addGame: (input) => {
    if (!input.title.trim()) return Promise.reject("Le titre est obligatoire.");
    const g = apply({ id: nextId++, playtime_minutes: 0, added_at: new Date().toISOString(), last_played_at: null, exe_missing: false, session_count: 0, ...framing } as Game, input);
    games.push(g);
    return delay(g);
  },
  updateGame: (id, input) => delay(apply(find(id), input)),
  deleteGame: (id) => {
    games.splice(games.findIndex((g) => g.id === id), 1);
    return delay(undefined);
  },
  launchGame: (id) => {
    const g = find(id);
    if (running.has(id)) return Promise.reject(`${g.title} est déjà en cours.`);
    const rg = { game_id: id, started_at: new Date().toISOString() };
    if (g.category !== "launcher") {
      running.set(id, rg);
      startedCbs.forEach((cb) => cb(rg));
      // Simulated session: window shows after ~3 s, game closes after 12 s.
      setTimeout(() => readyCbs.forEach((cb) => cb({ game_id: id, window: true })), 3000);
      setTimeout(() => {
        running.delete(id);
        g.playtime_minutes += 1;
        g.session_count += 1;
        g.last_played_at = new Date().toISOString();
        stoppedCbs.forEach((cb) => cb({ game: structuredClone(g), session_seconds: 68 }));
      }, 12000);
    }
    return delay(rg);
  },
  runningGames: () => delay([...running.values()]),
  openFolder: () => delay(undefined),
  scanExecutable: () => delay({ title: "Demo Game", executable_path: "D:\\Jeux\\Demo\\demo.exe", install_dir: "D:\\Jeux\\Demo", version: "1.0.0" }),
  pickCover: () => delay(art("Import", "#1e3a8a", "#7dd3fc", true)),
  fillMissingCovers: () => delay([]),
  listLaunchers: () =>
    delay([
      { id: "steam", name: "Steam", publisher: "Valve", download_url: "https://store.steampowered.com/about/", recommended_folder: "Steam", detected_exe: "D:\\Jeux\\Steam\\steam.exe" },
      { id: "epic", name: "Epic Games", publisher: "Epic Games", download_url: "https://store.epicgames.com/download", recommended_folder: "EpicGames", detected_exe: "D:\\Jeux\\EpicGames\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe" },
      { id: "battlenet", name: "Battle.net", publisher: "Blizzard", download_url: "https://www.blizzard.com/download/", recommended_folder: "BattleNet", detected_exe: null },
      { id: "ubisoft", name: "Ubisoft Connect", publisher: "Ubisoft", download_url: "https://ubisoftconnect.com/", recommended_folder: "UbisoftConnect", detected_exe: null },
      { id: "gog", name: "GOG Galaxy", publisher: "GOG", download_url: "https://www.gog.com/galaxy", recommended_folder: "GOGGalaxy", detected_exe: null },
      { id: "ea", name: "EA app", publisher: "Electronic Arts", download_url: "https://www.ea.com/ea-app", recommended_folder: "EAapp", detected_exe: null },
    ]),
  openLauncherDownload: () => delay(undefined),
  listDrives: () =>
    delay([
      { mount: "C:\\", name: "Système", total_bytes: 512e9, available_bytes: 80e9, removable: false },
      { mount: "D:\\", name: "Data", total_bytes: 2e12, available_bytes: 1.2e12, removable: false },
    ]),
  createFolder: (path) => delay(path),
  getSettings: () => delay(settings),
  saveSettings: (s) => {
    settings = { ...s };
    return delay(settings);
  },
  pickFolder: () => delay("E:\\Games"),
  pendingDetections: () => delay(params.has("detect") ? detections.slice(0, params.get("detect") === "1" ? 1 : 3) : []),
  scanGamesNow: () => delay(detections, 600),
  resolveDetections: (keys, action) => {
    const picked = detections.filter((d) => keys.includes(d.key));
    detections = detections.filter((d) => !keys.includes(d.key) || action === "later");
    if (action !== "add") return delay([]);
    const added = picked.map((d) => {
      const g: Game = { id: nextId++, title: d.title, executable_path: d.executable_path, install_dir: d.install_dir, cover_image_url: "", version: "", playtime_minutes: 0, category: "installed", added_at: new Date().toISOString(), last_played_at: null, exe_missing: false, session_count: 0, ...framing };
      games.push(g);
      return g;
    });
    return delay(added);
  },
  resetIgnoredDetections: () => delay(2),
  clearCache: () => delay({ files_removed: 3, bytes_freed: 4_200_000 }),
  openDataDir: () => delay(undefined),
  openRepo: () => delay(undefined),
  checkUpdate: () =>
    delay(
      params.has("update")
        ? { version: "0.3.0", current_version: "0.2.0", notes: "• Nouveautés de démonstration\n• Corrections diverses", date: null }
        : null,
      700,
    ),
  installUpdate: () =>
    new Promise((resolve) => {
      const total = 2_400_000;
      let done = 0;
      const t = setInterval(() => {
        done = Math.min(total, done + 300_000);
        progressCbs.forEach((cb) => cb({ downloaded: done, total }));
        if (done >= total) {
          clearInterval(t);
          setTimeout(() => location.reload(), 800);
          resolve(undefined);
        }
      }, 200);
    }),
};

export const mockEvents: Events = {
  onGameStarted: (cb) => {
    startedCbs.push(cb);
    return Promise.resolve(() => {});
  },
  onGameReady: (cb) => {
    readyCbs.push(cb);
    return Promise.resolve(() => {});
  },
  onGameStopped: (cb) => {
    stoppedCbs.push(cb);
    return Promise.resolve(() => {});
  },
  onGamesDetected: () => Promise.resolve(() => {}),
  onUpdateProgress: (cb) => {
    progressCbs.push(cb);
    return Promise.resolve(() => {});
  },
};
