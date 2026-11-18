// In-memory backend used only when the UI is opened in a plain browser
// (`npm run dev` without Tauri) — handy for UI work and screenshots.
import type { Api, Events, Game, GameInput, GameStopped, RunningGame } from "./api";

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const H = 3_600_000;

let nextId = 7;
const games: Game[] = [
  { id: 1, title: "Neon Drift", executable_path: "D:\\Jeux\\Steam\\steamapps\\common\\Neon Drift\\NeonDrift.exe", install_dir: "D:\\Jeux\\Steam\\steamapps\\common\\Neon Drift", cover_image_url: "", version: "1.4.2", playtime_minutes: 2535, category: "installed", added_at: iso(900 * H), last_played_at: iso(3 * H), exe_missing: false },
  { id: 2, title: "Hollow Depths", executable_path: "D:\\Jeux\\GOGGalaxy\\Games\\Hollow Depths\\hollow.exe", install_dir: "D:\\Jeux\\GOGGalaxy\\Games\\Hollow Depths", cover_image_url: "", version: "1.5.78", playtime_minutes: 4210, category: "installed", added_at: iso(1200 * H), last_played_at: iso(30 * H), exe_missing: false },
  { id: 3, title: "Starfall Tactics", executable_path: "", install_dir: "", cover_image_url: "", version: "", playtime_minutes: 610, category: "not_installed", added_at: iso(400 * H), last_played_at: iso(800 * H), exe_missing: false },
  { id: 4, title: "Steam", executable_path: "D:\\Jeux\\Steam\\steam.exe", install_dir: "D:\\Jeux\\Steam", cover_image_url: "", version: "", playtime_minutes: 0, category: "launcher", added_at: iso(1500 * H), last_played_at: null, exe_missing: false },
  { id: 5, title: "Circuit Breakers", executable_path: "D:\\Jeux\\EpicGames\\Games\\CircuitBreakers\\CB-Win64-Shipping.exe", install_dir: "D:\\Jeux\\EpicGames\\Games\\CircuitBreakers", cover_image_url: "", version: "2.0.1", playtime_minutes: 95, category: "installed", added_at: iso(50 * H), last_played_at: iso(48 * H), exe_missing: false },
  { id: 6, title: "Pixel Odyssey", executable_path: "", install_dir: "", cover_image_url: "", version: "", playtime_minutes: 0, category: "not_installed", added_at: iso(10 * H), last_played_at: null, exe_missing: false },
];
const running = new Map<number, RunningGame>();
const startedCbs: ((p: RunningGame) => void)[] = [];
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
    const g = apply({ id: nextId++, playtime_minutes: 0, added_at: new Date().toISOString(), last_played_at: null, exe_missing: false } as Game, input);
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
      // Simulated 8 s session.
      setTimeout(() => {
        running.delete(id);
        g.playtime_minutes += 1;
        g.last_played_at = new Date().toISOString();
        stoppedCbs.forEach((cb) => cb({ game: structuredClone(g), session_seconds: 68 }));
      }, 8000);
    }
    return delay(rg);
  },
  runningGames: () => delay([...running.values()]),
  openFolder: () => delay(undefined),
  scanExecutable: () => delay({ title: "Demo Game", executable_path: "D:\\Jeux\\Demo\\demo.exe", install_dir: "D:\\Jeux\\Demo", version: "1.0.0" }),
  pickCover: () => delay(null),
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
};

export const mockEvents: Events = {
  onGameStarted: (cb) => {
    startedCbs.push(cb);
    return Promise.resolve(() => {});
  },
  onGameStopped: (cb) => {
    stoppedCbs.push(cb);
    return Promise.resolve(() => {});
  },
};
