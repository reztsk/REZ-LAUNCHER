import "./styles.css";
import "./fx.css";
import { api, events, coverSrc, isTauri, installMock, toInput } from "./api";
import type { Category, Detected, DriveInfo, Game, GameInput, Kind, LauncherInfo, Platform, Profile, RunningGame, ScannedExe, Settings, SocialState } from "./api";
import { boxHtml, openGameBox } from "./box3d";
import { disableReorder, enableReorder } from "./reorder";
import { renderFriends } from "./friends-view";
import { avatarHtml, renderProfile, SHOWCASE_MAX, type ProfileCtx } from "./profile-view";
import { mountCarousel } from "./carousel";
import { openCoverEditor } from "./cover-editor";
import { coverHtml, generatedCover, type CoverLike } from "./covers";
import { showDetections } from "./detection";
import { esc, formatBytes, formatClock, formatPlaytime, formatRelative, formatSession } from "./format";
import { openGuide } from "./guide-modal";
import { guideFor } from "./guides";
import { icon } from "./icons";
import { launcherLogo } from "./launcher-logos";
import { renderSettings } from "./settings-view";
import { confirmModal, errorToast, openModal, toast } from "./ui";
import { checkForUpdates, onUpdateStatus } from "./updates";
import { showLaunch, type LaunchHandle } from "./launch-overlay";

type View = "library" | "launchers" | "settings" | "profile" | "friends";
/** "all" = every game (software and launchers have their own tabs). */
type Filter = "all" | Category | "software";
type Sort = "custom" | "title" | "playtime" | "recent";
type Group = "none" | "platform" | "collection";

const LS_KEY = "rez.ui.v1";

interface Persisted {
  filter: Filter;
  sort: Sort;
  drive: string | null;
  guideDone: Record<string, number[]>;
  carouselId: number | null;
  group: Group;
}

function loadPersisted(): Persisted {
  const fallback: Persisted = { filter: "all", sort: "recent", drive: null, guideDone: {}, carouselId: null, group: "none" };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") };
  } catch {
    return fallback;
  }
}

const DEFAULT_SETTINGS: Settings = {
  card_size: "normal",
  animations: true,
  tilt: true,
  ambient: true,
  theme: "steel",
  glass: true,
  library_view: "grid",
  launch_animation: true,
  minimize_on_launch: true,
  restore_on_exit: true,
  check_updates_on_start: true,
  detect_new_games: true,
  search_paths: [],
  start_view: "library",
  launch_at_startup: false,
  social_enabled: false,
};

const persisted = loadPersisted();
const state = {
  view: "library" as View,
  games: [] as Game[],
  running: new Map<number, RunningGame>(),
  filter: persisted.filter,
  sort: persisted.sort,
  search: "",
  open: new Set<number>(),
  seen: new Set<number>(),
  launchers: null as LauncherInfo[] | null,
  drives: [] as DriveInfo[],
  drive: persisted.drive,
  guideDone: persisted.guideDone,
  launching: new Set<number>(),
  settings: { ...DEFAULT_SETTINGS } as Settings,
  updateAvailable: false,
  carouselId: persisted.carouselId,
  /** Next carousel render fans the boxes out (view just opened). */
  carouselIntro: true,
  /** Launch animations in progress, by game id. */
  launches: new Map<number, LaunchHandle>(),
  group: persisted.group,
  profile: null as Profile | null,
  social: null as SocialState | null,
  /** Official uninstallers running, by game id. */
  uninstalling: new Set<number>(),
};

function persist(): void {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        filter: state.filter,
        sort: state.sort,
        drive: state.drive,
        guideDone: state.guideDone,
        carouselId: state.carouselId,
        group: state.group,
      }),
    );
  } catch {
    /* storage unavailable: preferences just won't persist */
  }
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const app = document.getElementById("app")!;

const CATEGORY_LABEL: Record<Category, string> = {
  installed: "Installé",
  not_installed: "Non installé",
  launcher: "Launcher",
};

const PLATFORM_LABEL: Record<Platform, string> = {
  steam: "Steam",
  epic: "Epic Games",
  gog: "GOG",
  ea: "EA app",
  ubisoft: "Ubisoft Connect",
  battlenet: "Battle.net",
  rockstar: "Rockstar Games",
  xbox: "Xbox",
  pc: "Autres jeux PC",
};

/** Games tab ("Tous" and its siblings) never shows software. */
function inFilter(g: Game, f: Filter): boolean {
  if (f === "software") return g.kind === "software";
  if (g.kind === "software") return false;
  return f === "all" ? g.category !== "launcher" : g.category === f;
}

function withTransition(fn: () => void): void {
  type VT = { ready: Promise<void>; finished: Promise<void> };
  const doc = document as Document & { startViewTransition?: (cb: () => void) => VT };
  const reduced = !state.settings.animations || matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (doc.startViewTransition && !reduced) {
    const t = doc.startViewTransition(fn);
    // A newer transition skips this one: expected, not an error.
    t.ready.catch(() => {});
    t.finished.catch(() => {});
  } else fn();
}

/* ============================== Settings ============================== */

function applyVisualPrefs(s: Settings): void {
  const root = document.documentElement;
  root.dataset.cards = s.card_size;
  root.classList.toggle("no-anim", !s.animations);
  root.classList.toggle("no-tilt", !s.tilt);
  root.classList.toggle("no-ambient", !s.ambient);
  root.classList.toggle("no-glass", !s.glass);
  root.dataset.theme = s.theme;
}

async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const prev = state.settings;
  if (patch.library_view && patch.library_view !== prev.library_view) state.carouselIntro = true;
  state.settings = { ...prev, ...patch };
  applyVisualPrefs(state.settings);
  try {
    state.settings = await api.saveSettings(state.settings);
    applyVisualPrefs(state.settings);
  } catch (err) {
    state.settings = prev;
    applyVisualPrefs(prev);
    throw err;
  }
}

/* ============================== Shell ============================== */

function renderShell(): void {
  app.innerHTML = `
    <aside class="sidebar liquid refract flex h-full flex-col px-[14px] py-6">
      <div class="flex items-center gap-3 px-2">
        <img src="/logo-mark.svg" alt="" class="h-10 w-10 drop-shadow-[0_0_12px_rgba(255,255,255,0.25)]" />
        <div class="leading-none">
          <div class="font-display text-[24px] font-black tracking-[0.14em] text-grad">REZ</div>
          <div class="mt-1 text-[10px] font-semibold uppercase tracking-[0.42em] text-muted">Launcher</div>
        </div>
      </div>

      <button id="me-chip" class="me-chip mx-1 mt-7" data-nav="profile" title="Ton profil"></button>

      <nav class="mt-5 flex flex-col gap-1 px-[14px]">
        <button class="nav-btn" data-nav="library">${icon.grid}<span class="flex-1 text-left">Bibliothèque</span><span id="nav-count" class="text-xs text-muted"></span></button>
        <button class="nav-btn" data-nav="friends">${icon.users}<span class="flex-1 text-left">Amis</span><span id="nav-friends" class="nav-pill hidden"></span></button>
        <button class="nav-btn" data-nav="launchers">${icon.rocket}<span class="flex-1 text-left">Launchers</span></button>
        <button class="nav-btn" data-nav="settings">${icon.settings}<span class="flex-1 text-left">Paramètres</span><i id="nav-update" class="nav-dot hidden" title="Mise à jour disponible"></i></button>
      </nav>

      <div id="side-live" class="mx-1 mt-8"></div>

      <div class="mt-auto px-2">
        <div class="flex items-start gap-2.5 rounded-xl border border-white/5 bg-white/[0.02] p-3 text-[11.5px] leading-snug text-muted">
          <span class="mt-0.5 text-white/80">${icon.shield}</span>
          <span><b class="text-white/85">Zéro risque de ban.</b> REZ launcher lance tes jeux comme un raccourci et chronomètre le processus. Aucune injection, aucun fichier de jeu modifié.</span>
        </div>
        <p class="mt-3 text-center text-[11px] text-white/25">Open source · v${esc(__APP_VERSION__)}</p>
      </div>
    </aside>
    <main id="view" class="relative h-full overflow-y-auto"></main>`;

  app.querySelectorAll<HTMLElement>("[data-nav]").forEach((b) =>
    b.addEventListener("click", () => switchView(b.dataset.nav as View)),
  );
}

/** Sidebar: navigation + games running right now (no global playtime total). */
function renderSidebar(): void {
  document.querySelectorAll<HTMLElement>("[data-nav]").forEach((b) => {
    if (b.dataset.nav === state.view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("#nav-count")!.textContent = String(state.games.filter((g) => inFilter(g, "all")).length);
  const st = state.social;
  const online = st?.friends.filter((f) => f.state === "friend" && f.status !== "offline").length ?? 0;
  const requests = st?.friends.filter((f) => f.state === "incoming").length ?? 0;
  const pill = $("#nav-friends")!;
  pill.classList.toggle("hidden", !(online || requests));
  pill.classList.toggle("alert", requests > 0);
  pill.textContent = requests ? String(requests) : String(online);
  pill.title = requests ? `${requests} demande(s) d'ami` : `${online} ami(s) en ligne`;
  const p = state.profile;
  const playing = [...state.running.values()].map((r) => state.games.find((g) => g.id === r.game_id)).find(Boolean);
  $("#me-chip")!.innerHTML = p
    ? `<span class="relative shrink-0">${avatarHtml(p, "sm")}<i class="presence ${playing ? "ingame" : st?.enabled ? "online" : "offline"}"></i></span>
       <span class="min-w-0 flex-1 text-left"><b class="block truncate text-sm">${esc(p.name)}</b>
       <small class="block truncate text-[11px] text-muted">${playing ? `En jeu · ${esc(playing.title)}` : st?.enabled ? "En ligne" : "Voir mon profil"}</small></span>`
    : "";
  if (state.view === "profile") $("#me-chip")!.setAttribute("aria-current", "page");
  else $("#me-chip")!.removeAttribute("aria-current");
  $("#nav-update")!.classList.toggle("hidden", !state.updateAvailable);
  const live = [...state.running.values()]
    .map((r) => ({ r, g: state.games.find((g) => g.id === r.game_id) }))
    .filter((x): x is { r: RunningGame; g: Game } => !!x.g);
  $("#side-live")!.innerHTML = live.length
    ? `<div class="glass rounded-2xl p-3">
        <p class="label !mb-2 flex items-center gap-2"><i class="nav-dot"></i>En cours</p>
        ${live
          .map(
            ({ r, g }) => `
          <div class="flex items-center justify-between gap-2 rounded-lg bg-white/[0.03] px-2.5 py-2 text-xs">
            <span class="truncate font-semibold">${esc(g.title)}</span>
            <b class="tabular-nums" data-since="${esc(r.started_at)}">0:00</b>
          </div>`,
          )
          .join("")}
      </div>`
    : "";
  tickTimers();
}

function renderView(): void {
  if (state.view === "library") renderLibrary();
  else if (state.view === "launchers") renderLaunchers();
  else if (state.view === "profile") renderProfileView();
  else if (state.view === "friends") renderFriendsView();
  else renderSettingsView();
}

function switchView(view: View): void {
  if (view === state.view && $("#view")!.childElementCount) return;
  state.view = view;
  if (view === "library") state.carouselIntro = true;
  renderSidebar();
  $("#view")!.scrollTop = 0;
  withTransition(renderView);
}

/* ============================== Library ============================== */

function visibleGames(): Game[] {
  const q = state.search.trim().toLowerCase();
  const list = state.games.filter((g) => inFilter(g, state.filter) && (!q || g.title.toLowerCase().includes(q)));
  const byTitle = (a: Game, b: Game) => a.title.localeCompare(b.title, "fr", { sensitivity: "base" });
  switch (state.sort) {
    case "custom":
      return list.sort((a, b) => a.sort_order - b.sort_order || byTitle(a, b));
    case "playtime":
      return list.sort((a, b) => b.playtime_minutes - a.playtime_minutes || byTitle(a, b));
    case "recent":
      return list.sort(
        (a, b) =>
          Number(state.running.has(b.id)) - Number(state.running.has(a.id)) ||
          (b.last_played_at ?? b.added_at).localeCompare(a.last_played_at ?? a.added_at) ||
          byTitle(a, b),
      );
    default:
      return list.sort(byTitle);
  }
}

function renderLibrary(): void {
  const view = $("#view")!;
  view.innerHTML = `
    <div class="mx-auto max-w-[1500px] px-10 pb-16 pt-8">
      <header class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 class="font-display text-[34px] font-bold tracking-tight">Bibliothèque</h1>
          <p class="mt-1 text-sm text-muted">Tous tes jeux, un seul endroit. Le temps de chaque jeu est mesuré à la seconde près.</p>
        </div>
        <div class="flex items-center gap-2.5">
          <label class="relative">
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">${icon.search}</span>
            <input id="search" class="field w-64 !pl-10" placeholder="Rechercher…  (Ctrl+F)" value="${esc(state.search)}" spellcheck="false" />
          </label>
          <select id="group" class="field !w-auto pr-8" title="Grouper par">
            <option value="none">Sans groupe</option>
            <option value="platform">Par plateforme</option>
            <option value="collection">Par catégorie</option>
          </select>
          <select id="sort" class="field !w-auto pr-8" title="Trier">
            <option value="custom">Mon ordre</option>
            <option value="recent">Récents</option>
            <option value="playtime">Temps de jeu</option>
            <option value="title">A → Z</option>
          </select>
          <button class="btn btn-primary" id="add-game">${icon.plus}Ajouter un jeu</button>
        </div>
      </header>
      <section id="hero-slot" class="mt-7"></section>
      <div class="mt-7 flex items-center justify-between gap-4">
        <div id="tabs" class="tabs liquid" role="tablist"></div>
        <p id="result-count" class="text-xs text-muted"></p>
      </div>
      <p id="order-hint" class="order-hint mt-3 hidden">${icon.grip}Glisse les jeux pour les réordonner. L'ordre est enregistré.</p>
      <section id="grid" class="${state.settings.library_view === "carousel" ? "mt-4" : "grid-games mt-6"}"></section>
    </div>`;

  $<HTMLSelectElement>("#sort")!.value = state.sort;
  $<HTMLSelectElement>("#group")!.value = state.group;
  $<HTMLSelectElement>("#group")!.addEventListener("change", (e) => {
    state.group = (e.target as HTMLSelectElement).value as Group;
    persist();
    updateLibrary(true);
  });
  $<HTMLInputElement>("#search")!.addEventListener("input", (e) => {
    state.search = (e.target as HTMLInputElement).value;
    updateLibrary(false);
  });
  $<HTMLSelectElement>("#sort")!.addEventListener("change", (e) => {
    state.sort = (e.target as HTMLSelectElement).value as Sort;
    persist();
    updateLibrary(true);
  });
  $("#add-game")!.addEventListener("click", () => openGameForm());

  const grid = $("#grid")!;
  grid.addEventListener("click", onGridClick);
  grid.addEventListener("mousemove", onTilt);
  grid.addEventListener("mouseleave", resetTilt, true);
  $("#hero-slot")!.addEventListener("click", onGridClick);

  state.seen.clear();
  updateLibrary(false);
}

function updateLibrary(animate: boolean): void {
  if (state.view !== "library" || !$("#grid")) return;
  const run = () => {
    renderTabs();
    renderHero();
    renderGrid();
  };
  // The carousel animates itself; a page-wide view transition would ghost the 3D boxes.
  if (animate && state.settings.library_view !== "carousel") withTransition(run);
  else run();
}

function renderTabs(): void {
  const tabs = $("#tabs")!;
  const count = (f: Filter) => state.games.filter((g) => inFilter(g, f)).length;
  const items: [Filter, string][] = [
    ["all", "Tous"],
    ["installed", "Installés"],
    ["not_installed", "Non installés"],
    ["launcher", "Launchers"],
    ["software", "Logiciels"],
  ];
  const prev = $<HTMLElement>(".tab-indicator", tabs);
  const prevBox = prev ? { left: prev.style.left, width: prev.style.width } : null;
  tabs.innerHTML =
    `<span class="tab-indicator"></span>` +
    items
      .map(
        ([f, label]) =>
          `<button class="tab" role="tab" data-filter="${f}" aria-selected="${state.filter === f}">${label}<span class="count">${count(f)}</span></button>`,
      )
      .join("");
  const ind = $<HTMLElement>(".tab-indicator", tabs)!;
  const sel = $<HTMLElement>(`[data-filter="${state.filter}"]`, tabs)!;
  const place = () => {
    ind.style.left = `${sel.offsetLeft}px`;
    ind.style.width = `${sel.offsetWidth}px`;
  };
  if (prevBox?.width) {
    ind.style.transition = "none";
    ind.style.left = prevBox.left;
    ind.style.width = prevBox.width;
    void ind.offsetWidth; // commit start position, then animate to the new tab
    ind.style.transition = "";
  }
  requestAnimationFrame(place);
  tabs.querySelectorAll<HTMLElement>("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      if (state.filter === b.dataset.filter) return;
      state.filter = b.dataset.filter as Filter;
      persist();
      updateLibrary(true);
    }),
  );
}

function canPlay(g: Game): boolean {
  return g.category !== "not_installed" && !!g.executable_path && !g.exe_missing;
}

/** "42h 15m jouées" — playtime of this game only. */
function playedLabel(g: Game): string {
  if (g.category === "launcher") return "Non chronométré";
  return g.playtime_minutes > 0 ? `${formatPlaytime(g.playtime_minutes)} jouées` : "Jamais lancé";
}

function cardHtml(g: Game, i: number): string {
  const running = state.running.get(g.id);
  const isOpen = state.open.has(g.id);
  const enter = !state.seen.has(g.id);
  const badges: string[] = [];
  if (state.uninstalling.has(g.id)) badges.push(`<span class="badge badge-warn">Désinstallation…</span>`);
  else if (running) badges.push(`<span class="badge badge-live"><i class="dot"></i>En cours</span>`);
  else if (g.category !== "installed") badges.push(`<span class="badge">${CATEGORY_LABEL[g.category]}</span>`);
  if (g.exe_missing) badges.push(`<span class="badge badge-warn" title="${esc(g.executable_path)}">Exe introuvable</span>`);
  const dir = g.install_dir || g.executable_path;
  const sub = running
    ? `<span class="playtime">${icon.clock}Session <b data-since="${esc(running.started_at)}" class="tabular-nums">0:00</b></span>`
    : `<span class="playtime" title="Dernière session : ${esc(formatRelative(g.last_played_at))}">${icon.clock}${playedLabel(g)}</span>`;
  const avg = g.session_count > 0 ? Math.round(g.playtime_minutes / g.session_count) : 0;
  const timed = g.category !== "launcher";
  const boxMode = state.settings.library_view === "box3d";
  const coverAction = boxMode ? "box" : canPlay(g) ? "play" : "toggle";
  const coverTitle = boxMode ? "Voir la boîte 3D" : canPlay(g) ? "Jouer" : "Options";
  const pinned = state.profile?.showcase.includes(g.id) ?? false;
  const uninstallable = g.category === "installed" && !!g.executable_path && !g.exe_missing && !running && !state.uninstalling.has(g.id);
  const visual = boxMode
    ? `<div class="box-slot" data-action="box" title="Voir la boîte 3D">
        ${boxHtml(g, { w: boxWidth(), lite: true })}
        <div class="absolute left-0 top-1 z-[2] flex flex-wrap gap-1.5">${badges.join("")}</div>
      </div>`
    : `<div class="cover" data-action="${coverAction}" title="${coverTitle}">
      ${coverHtml(g)}
      <div class="shade"></div>
      <div class="absolute left-2.5 top-2.5 flex flex-wrap gap-1.5">${badges.join("")}</div>
      ${
        canPlay(g) && !running
          ? `<button class="play-fab" data-action="play" aria-label="Jouer à ${esc(g.title)}">${icon.play}</button>`
          : ""
      }
    </div>`;

  return `
  <article class="card ${boxMode ? "boxed" : ""} ${isOpen ? "open" : ""} ${running ? "is-running" : ""}" data-id="${g.id}"
           style="--i:${enter ? Math.min(i, 16) : 0};${enter ? "" : "animation:none;"}view-transition-name:g-${g.id}">
    ${visual}
    <div class="mt-3 flex items-start gap-2 px-0.5">
      <div class="min-w-0 flex-1">
        <h3 class="truncate text-[15px] font-semibold" title="${esc(g.title)}">${esc(g.title)}</h3>
        <p class="mt-0.5 truncate text-xs text-muted">${sub}</p>
      </div>
      ${
        boxMode && canPlay(g) && !running
          ? `<button class="opt-toggle play-mini" data-action="play" title="Jouer à ${esc(g.title)}">${icon.play}</button>`
          : ""
      }
      <button class="opt-toggle" data-action="toggle" aria-expanded="${isOpen}" title="Options">${icon.chevron}</button>
    </div>
    <div class="options"><div>
      <div class="glass rounded-xl px-3 py-1">
        ${
          timed
            ? `<div class="opt-hero"><p class="text-[11px] font-semibold uppercase tracking-wider text-muted">Temps de jeu sur ce jeu</p><b class="text-grad">${formatPlaytime(g.playtime_minutes)}</b></div>
        <div class="opt-row"><span>Sessions</span><span>${g.session_count}</span></div>
        ${avg ? `<div class="opt-row"><span>Moyenne / session</span><span>${formatPlaytime(avg)}</span></div>` : ""}`
            : ""
        }
        <div class="opt-row"><span>Dernière session</span><span>${formatRelative(g.last_played_at)}</span></div>
        <div class="opt-row"><span>Version</span><span>${esc(g.version || "—")}</span></div>
        <div class="opt-row"><span>Statut</span><span>${CATEGORY_LABEL[g.category]}</span></div>
        <div class="opt-row"><span>Plateforme</span><span>${PLATFORM_LABEL[g.platform] ?? "—"}</span></div>
        ${g.collection ? `<div class="opt-row"><span>Catégorie</span><span>${esc(g.collection)}</span></div>` : ""}
      </div>
      <div class="mt-2 grid grid-cols-2 gap-1.5">
        ${
          g.kind === "game"
            ? `<button class="btn btn-ghost btn-sm min-w-0 !px-2" data-action="pin" aria-pressed="${pinned}" title="${pinned ? "Retirer de la vitrine du profil" : "Épingler sur la vitrine du profil"}">${pinned ? icon.check : icon.pin}<span class="truncate">Vitrine</span></button>`
            : `<span></span>`
        }
        <button class="btn btn-ghost btn-sm min-w-0 !px-2" data-action="kind" title="${g.kind === "game" ? "Ranger dans « Logiciels »" : "Remettre dans les jeux"}">${g.kind === "game" ? icon.package : icon.gamepad}<span class="truncate">${g.kind === "game" ? "Logiciel" : "C'est un jeu"}</span></button>
      </div>
      <div class="mt-2 grid grid-cols-[1fr_auto_auto_auto] gap-1.5">
        <button class="btn btn-ghost btn-sm min-w-0 !px-2" data-action="open-folder" ${dir ? "" : "disabled"} title="Ouvrir l'emplacement : ${esc(dir)}">${icon.folder}<span class="truncate">Emplacement</span></button>
        <button class="btn btn-ghost btn-sm !px-2.5" data-action="cover" title="Personnaliser la jaquette">${icon.image}</button>
        <button class="btn btn-ghost btn-sm !px-2.5" data-action="edit" title="Modifier">${icon.edit}</button>
        <button class="btn btn-danger btn-sm !px-2.5" data-action="delete" title="Retirer de REZ launcher (les fichiers restent)">${icon.trash}</button>
      </div>
      ${
        uninstallable
          ? `<button class="btn btn-danger btn-sm mt-1.5 w-full" data-action="uninstall" title="Lancer le désinstallateur officiel du jeu">${icon.uninstall}Désinstaller</button>`
          : ""
      }
    </div></div>
  </article>`;
}

function renderGrid(): void {
  const grid = $("#grid")!;
  const list = visibleGames();
  const carousel = state.settings.library_view === "carousel";
  grid.className = carousel ? "mt-4" : "grid-games mt-6";
  $("#result-count")!.textContent = `${list.length} ${list.length > 1 ? "éléments" : "élément"}`;
  if (list.length === 0) {
    const emptyLib = state.games.length === 0;
    grid.innerHTML = `
      <div class="empty glass col-span-full flex flex-col items-center rounded-3xl px-8 py-16 text-center">
        <div class="icon-tile h-16 w-16 [&_.icon]:h-8 [&_.icon]:w-8">${icon.gamepad}</div>
        <h3 class="mt-5 font-display text-xl font-bold">${emptyLib ? "Ta bibliothèque est vide" : "Aucun résultat"}</h3>
        <p class="mt-2 max-w-md text-sm text-muted">${
          emptyLib
            ? "Ajoute un jeu via son .exe, glisse-dépose l'exécutable dans la fenêtre, ou laisse REZ launcher trouver tes jeux installés."
            : "Essaie un autre filtre ou une autre recherche."
        }</p>
        ${
          emptyLib
            ? `<div class="mt-6 flex gap-2"><button class="btn btn-ghost" data-action="scan">${icon.radar}Trouver mes jeux</button><button class="btn btn-primary" data-action="add">${icon.plus}Ajouter un jeu</button></div>`
            : ""
        }
      </div>`;
    grid.querySelector('[data-action="add"]')?.addEventListener("click", () => openGameForm());
    grid.querySelector('[data-action="scan"]')?.addEventListener("click", () => void scanNow());
    return;
  }
  if (carousel) {
    mountCarousel(grid, {
      games: list,
      activeId: state.carouselId,
      running: state.running,
      // Fit the whole carousel + its info panel in the window height.
      width: Math.max(
        170,
        Math.min({ compact: 196, normal: 232, large: 272 }[state.settings.card_size], Math.round((innerHeight - 500) * 0.75)),
      ),
      intro: state.carouselIntro,
      canPlay,
      playedLabel,
      onActive: (id) => {
        state.carouselId = id;
        persist();
      },
      onPlay: (g) => void launch(g),
      onBox: openBox,
      onCover: (g) => void editCover(g),
      onEdit: (g) => openGameForm(g),
      onFolder: (g) => void openFolderOf(g),
    });
    state.carouselIntro = false;
    tickTimers();
    return;
  }
  const canReorder = state.sort === "custom" && state.group === "none" && !state.search.trim();
  $("#order-hint")!.classList.toggle("hidden", !canReorder || list.length < 2);
  if (state.group === "none") {
    grid.innerHTML = list.map(cardHtml).join("");
  } else {
    const key = (g: Game) => (state.group === "platform" ? PLATFORM_LABEL[g.platform] ?? "Autres jeux PC" : g.collection || "Sans catégorie");
    const groups = new Map<string, Game[]>();
    list.forEach((g) => groups.set(key(g), [...(groups.get(key(g)) ?? []), g]));
    const names = [...groups.keys()].sort((a, b) => {
      const last = (n: string) => (n === "Sans catégorie" || n === "Autres jeux PC" ? 1 : 0);
      return last(a) - last(b) || a.localeCompare(b, "fr", { sensitivity: "base" });
    });
    let i = 0;
    grid.innerHTML = names
      .map(
        (n) => `<h3 class="group-head col-span-full"><span>${esc(n)}</span><small>${groups.get(n)!.length}</small></h3>${groups
          .get(n)!
          .map((g) => cardHtml(g, i++))
          .join("")}`,
      )
      .join("");
  }
  list.forEach((g) => state.seen.add(g.id));
  if (canReorder) enableReorder(grid, (ids) => void saveOrder(ids));
  else disableReorder();
  tickTimers();
}

/** Width of the 3D boxes of the "Boîte 3D" grid, from the card size setting. */
function boxWidth(): number {
  return { compact: 116, normal: 146, large: 184 }[state.settings.card_size];
}

/** Drag & drop result: the visible games in their new order (others keep theirs). */
async function saveOrder(visibleIds: number[]): Promise<void> {
  const rest = [...state.games].sort((a, b) => a.sort_order - b.sort_order).map((g) => g.id).filter((id) => !visibleIds.includes(id));
  const ids = [...visibleIds, ...rest];
  ids.forEach((id, i) => {
    const g = state.games.find((x) => x.id === id);
    if (g) g.sort_order = i + 1;
  });
  try {
    await api.reorderGames(ids);
  } catch (err) {
    errorToast(err, "Ordre non enregistré");
  }
}

function openBox(g: Game): void {
  openGameBox(g, {
    canPlay: (x) => canPlay(x) && !state.running.has(x.id),
    onPlay: (x) => void launch(x),
    onCover: (x) => void editCover(x),
    onEdit: (x) => openGameForm(x),
  });
}

async function openFolderOf(g: Game): Promise<void> {
  try {
    await api.openFolder(g.install_dir || g.executable_path);
  } catch (err) {
    errorToast(err, "Emplacement introuvable");
  }
}

/** Cover editor on an existing game, saved right away. */
async function editCover(g: Game): Promise<void> {
  const res = await openCoverEditor(g, { pickImage: () => api.pickCover() });
  if (!res) return;
  try {
    const saved = await api.updateGame(g.id, toInput(g, coverFields(res)));
    replaceGame(saved);
    toast("Jaquette mise à jour", saved.title);
  } catch (err) {
    errorToast(err, "Enregistrement impossible");
  }
}

function coverFields(c: CoverLike): Pick<GameInput, "cover_image_url" | "cover_zoom" | "cover_x" | "cover_y"> {
  return { cover_image_url: c.cover_image_url, cover_zoom: c.cover_zoom, cover_x: c.cover_x, cover_y: c.cover_y };
}

function replaceGame(saved: Game): void {
  state.games = state.games.map((x) => (x.id === saved.id ? saved : x));
  renderSidebar();
  if (state.view === "library") updateLibrary(false);
}

function renderHero(): void {
  const slot = $("#hero-slot")!;
  const showHero = state.filter === "all" && !state.search.trim() && state.settings.library_view !== "carousel";
  const candidates = state.games.filter((g) => g.category === "installed" && g.last_played_at && canPlay(g));
  const g = candidates.sort((a, b) => b.last_played_at!.localeCompare(a.last_played_at!))[0];
  if (!showHero || !g) {
    slot.innerHTML = "";
    slot.classList.remove("mt-7");
    return;
  }
  slot.classList.add("mt-7");
  const src = coverSrc(g.cover_image_url);
  const bg = src
    ? `background-image:url('${esc(src)}')`
    : `background:linear-gradient(120deg, #3f3f46, #18181b 60%, #09090b)`;
  const running = state.running.get(g.id);
  slot.innerHTML = `
    <div class="hero glass" data-id="${g.id}">
      <div class="hero-bg" style="${bg}"></div>
      <div class="hero-content flex items-center gap-7 p-7">
        <div class="cover hidden w-[118px] shrink-0 sm:block" data-action="play">${coverHtml(g)}</div>
        <div class="min-w-0 flex-1">
          <p class="kicker">${running ? "En cours" : "Reprendre"}</p>
          <h2 class="mt-2 truncate font-display text-[30px] font-bold tracking-tight">${esc(g.title)}</h2>
          <div class="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
            <span class="flex items-center gap-1.5">${icon.clock}<b class="text-white/90">${formatPlaytime(g.playtime_minutes)}</b> jouées sur ce jeu</span>
            <span>Dernière session : <b class="text-white/90">${formatRelative(g.last_played_at)}</b></span>
            ${g.version ? `<span>Version <b class="text-white/90">${esc(g.version)}</b></span>` : ""}
          </div>
        </div>
        <div class="flex shrink-0 gap-2">
          <button class="btn btn-ghost" data-action="open-folder">${icon.folder}Emplacement</button>
          ${
            running
              ? `<span class="btn btn-ghost !border-white/30 tabular-nums">${icon.clock}<b data-since="${esc(running.started_at)}">0:00</b></span>`
              : `<button class="btn btn-primary !h-11 !px-6 text-[15px]" data-action="play"><span class="[&_svg]:h-4 [&_svg]:w-4">${icon.play}</span>Jouer</button>`
          }
        </div>
      </div>
    </div>`;
}

async function onGridClick(e: Event): Promise<void> {
  const target = e.target as HTMLElement;
  const actionEl = target.closest<HTMLElement>("[data-action]");
  const holder = target.closest<HTMLElement>("[data-id]");
  if (!actionEl || !holder) return;
  e.stopPropagation();
  const id = Number(holder.dataset.id);
  const game = state.games.find((g) => g.id === id);
  if (!game) return;

  switch (actionEl.dataset.action) {
    case "play":
      return launch(game);
    case "box":
      return openBox(game);
    case "cover":
      return editCover(game);
    case "toggle": {
      const card = holder.classList.contains("card") ? holder : null;
      if (!card) return;
      const open = !state.open.has(id);
      if (open) state.open.add(id);
      else state.open.delete(id);
      card.classList.toggle("open", open);
      card.querySelector(".opt-toggle")?.setAttribute("aria-expanded", String(open));
      return;
    }
    case "open-folder":
      return openFolderOf(game);
    case "edit":
      return openGameForm(game);
    case "pin":
      return togglePin(game);
    case "kind":
      return setKind(game, game.kind === "game" ? "software" : "game");
    case "uninstall":
      return uninstall(game);
    case "delete": {
      const ok = await confirmModal(
        "Supprimer ce jeu ?",
        `<b class="text-white">${esc(game.title)}</b> sera retiré de REZ launcher avec son historique de sessions (${formatPlaytime(
          game.playtime_minutes,
        )}). <br/>Les fichiers du jeu sur ton disque ne sont <b class="text-white">pas</b> touchés.`,
        "Supprimer",
      );
      if (!ok) return;
      try {
        await api.deleteGame(id);
        state.games = state.games.filter((g) => g.id !== id);
        state.open.delete(id);
        renderSidebar();
        updateLibrary(true);
        toast("Jeu retiré", game.title);
      } catch (err) {
        errorToast(err);
      }
      return;
    }
  }
}

async function togglePin(g: Game): Promise<void> {
  const p = state.profile;
  if (!p) return;
  const on = p.showcase.includes(g.id);
  if (!on && p.showcase.length >= SHOWCASE_MAX) {
    errorToast(`Ta vitrine contient déjà ${SHOWCASE_MAX} jeux. Retire-en un depuis ton profil.`, "Vitrine pleine");
    return;
  }
  try {
    await saveProfile({ ...p, showcase: on ? p.showcase.filter((id) => id !== g.id) : [...p.showcase, g.id] });
    toast(on ? "Retiré de la vitrine" : "Épinglé sur ta vitrine", g.title);
  } catch (err) {
    errorToast(err);
  }
}

async function setKind(g: Game, kind: Kind): Promise<void> {
  try {
    const saved = await api.updateGame(g.id, toInput(g, { kind }));
    replaceGame(saved);
    toast(kind === "software" ? "Rangé dans « Logiciels »" : "Remis dans les jeux", saved.title);
  } catch (err) {
    errorToast(err);
  }
}

/** Official uninstaller (registry entry, Steam, or unins000.exe), then removal from the library. */
async function uninstall(g: Game): Promise<void> {
  let plan;
  try {
    plan = await api.uninstallInfo(g.id);
  } catch (err) {
    return errorToast(err);
  }
  if (!plan) {
    errorToast(
      "Aucun désinstallateur officiel trouvé. Désinstalle ce jeu depuis son launcher ou Paramètres Windows › Applications, puis retire-le de REZ launcher.",
      "Désinstallation impossible",
    );
    return;
  }
  const how =
    plan.via === "steam"
      ? "Steam va ouvrir sa fenêtre de désinstallation : confirme-la dans Steam."
      : `Le désinstallateur officiel du jeu va s'ouvrir :<br/><code class="break-all text-[11.5px]">${esc(plan.detail)}</code>`;
  const ok = await confirmModal(
    `Désinstaller ${g.title} ?`,
    `${how}<br/><br/>Les fichiers du jeu seront supprimés <b class="text-white">par son propre désinstallateur</b>. Une fois terminé, le jeu et son historique (${formatPlaytime(g.playtime_minutes)}) quittent REZ launcher.`,
    "Désinstaller",
  );
  if (!ok) return;
  try {
    await api.uninstallGame(g.id);
    state.uninstalling.add(g.id);
    state.open.delete(g.id);
    if (state.view === "library") updateLibrary(false);
    toast("Désinstallation lancée", "Suis les étapes du désinstallateur. REZ launcher attend la fin.");
  } catch (err) {
    errorToast(err, "Désinstallation impossible");
  }
}

async function launch(game: Game): Promise<void> {
  if (state.launching.has(game.id) || state.running.has(game.id)) return;
  state.launching.add(game.id);
  const timed = game.category !== "launcher";
  const anim = timed && state.settings.launch_animation ? showLaunch(game) : null;
  if (anim) state.launches.set(game.id, anim);
  try {
    // Let the case open before the game grabs the screen.
    if (anim) await new Promise((r) => setTimeout(r, 700));
    const rg = await api.launchGame(game.id);
    if (!timed) {
      toast(`${game.title} ouvert`, "Les launchers ne sont pas chronométrés.");
    } else {
      anim?.started();
      onStarted(rg);
      if (!anim) toast(`C'est parti : ${game.title}`, "Le chrono de ce jeu tourne. Bon jeu !");
    }
  } catch (err) {
    anim?.close();
    state.launches.delete(game.id);
    errorToast(err, "Lancement impossible");
  } finally {
    state.launching.delete(game.id);
  }
}

/** Game window is up: finish the animation, stop costly rendering while playing. */
function onReady(gameId: number): void {
  const anim = state.launches.get(gameId);
  state.launches.delete(gameId);
  anim?.ready();
  if (state.settings.minimize_on_launch) document.documentElement.classList.add("gaming");
}

function onStarted(rg: RunningGame): void {
  if (state.running.has(rg.game_id)) return;
  state.running.set(rg.game_id, rg);
  renderSidebar();
  updateLibrary(true);
}

/* Subtle 3D tilt following the cursor (no light effect). */
function onTilt(e: MouseEvent): void {
  if (!state.settings.tilt) return;
  const cover = (e.target as HTMLElement).closest<HTMLElement>(".cover");
  const card = cover?.closest<HTMLElement>(".card");
  if (!cover || !card) return;
  const r = cover.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  card.style.setProperty("--ry", `${(x - 0.5) * 10}deg`);
  card.style.setProperty("--rx", `${(0.5 - y) * 10}deg`);
}

function resetTilt(e: Event): void {
  const card = (e.target as HTMLElement).closest?.<HTMLElement>(".card");
  if (!card) return;
  card.style.setProperty("--rx", "0deg");
  card.style.setProperty("--ry", "0deg");
}

function tickTimers(): void {
  const now = Date.now();
  document.querySelectorAll<HTMLElement>("[data-since]").forEach((el) => {
    el.textContent = formatClock((now - new Date(el.dataset.since!).getTime()) / 1000);
  });
}

/* ============================== Game form ============================== */

function openGameForm(game?: Game, prefill?: ScannedExe): void {
  const v: GameInput = {
    title: game?.title ?? prefill?.title ?? "",
    executable_path: game?.executable_path ?? prefill?.executable_path ?? "",
    install_dir: game?.install_dir ?? prefill?.install_dir ?? "",
    cover_image_url: game?.cover_image_url ?? "",
    version: game?.version ?? prefill?.version ?? "",
    category: game?.category ?? "installed",
    description: game?.description ?? "",
    cover_zoom: game?.cover_zoom ?? 1,
    cover_x: game?.cover_x ?? 50,
    cover_y: game?.cover_y ?? 50,
    kind: game?.kind ?? "game",
    collection: game?.collection ?? "",
  };
  const collections = [...new Set(state.games.map((g) => g.collection).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
  const kindSeg = (k: Kind, label: string) =>
    `<label><input type="radio" name="kind" value="${k}" ${v.kind === k ? "checked" : ""}/><span>${label}</span></label>`;
  const framing = { cover_zoom: v.cover_zoom, cover_x: v.cover_x, cover_y: v.cover_y };
  const seg = (c: Category, label: string) =>
    `<label><input type="radio" name="category" value="${c}" ${v.category === c ? "checked" : ""}/><span>${label}</span></label>`;

  const m = openModal(
    game ? "Modifier le jeu" : "Ajouter un jeu",
    `<form id="game-form" class="grid grid-cols-[132px_1fr] gap-5" autocomplete="off">
      <div>
        <div id="f-preview" class="cover !cursor-pointer" title="Personnaliser la jaquette">${coverPreview(v.title, v.cover_image_url, framing)}</div>
        <button type="button" class="btn btn-ghost btn-sm mt-2 w-full" id="f-edit-cover">${icon.image}Jaquette…</button>
      </div>
      <div class="flex flex-col gap-3.5">
        <div><label class="label" for="f-title">Titre</label>
          <input id="f-title" name="title" class="field" value="${esc(v.title)}" required maxlength="200" autofocus /></div>
        <div><label class="label" for="f-exe">Exécutable</label>
          <div class="flex gap-2">
            <input id="f-exe" name="executable_path" class="field" value="${esc(v.executable_path)}" placeholder="D:\\Jeux\\MonJeu\\jeu.exe" spellcheck="false" />
            <button type="button" class="btn btn-ghost shrink-0" id="f-browse">${icon.folder}Parcourir</button>
          </div></div>
        <div class="grid grid-cols-[1fr_120px] gap-3">
          <div><label class="label" for="f-dir">Dossier d'installation</label>
            <input id="f-dir" name="install_dir" class="field" value="${esc(v.install_dir)}" placeholder="Auto (dossier de l'exe)" spellcheck="false" /></div>
          <div><label class="label" for="f-version">Version</label>
            <input id="f-version" name="version" class="field" value="${esc(v.version)}" placeholder="1.0.0" /></div>
        </div>
        <div><label class="label" for="f-cover">Jaquette (URL)</label>
          <input id="f-cover" name="cover_image_url" class="field" value="${esc(v.cover_image_url)}" placeholder="https://… (format portrait 3:4 conseillé)" spellcheck="false" /></div>
        <div><span class="label">Statut</span>
          <div class="seg">${seg("installed", "Installé")}${seg("not_installed", "Non installé")}${seg("launcher", "Launcher")}</div></div>
        <div class="grid grid-cols-[1fr_1fr] gap-3">
          <div><span class="label">Type</span>
            <div class="seg">${kindSeg("game", "Jeu")}${kindSeg("software", "Logiciel")}</div></div>
          <div><label class="label" for="f-coll">Catégorie</label>
            <input id="f-coll" name="collection" class="field" value="${esc(v.collection)}" maxlength="40" list="f-colls" placeholder="FPS, Coop, Course…" />
            <datalist id="f-colls">${collections.map((c) => `<option value="${esc(c)}"></option>`).join("")}</datalist></div>
        </div>
        <div><label class="label" for="f-desc">Description <span class="normal-case tracking-normal text-white/30">(dos de la boîte 3D)</span></label>
          <textarea id="f-desc" name="description" class="field !h-20 resize-none !py-2.5 leading-snug" maxlength="4000" placeholder="Résumé, souvenirs, objectifs…">${esc(v.description)}</textarea></div>
      </div>
      <div class="col-span-2 mt-1 flex justify-end gap-2 border-t border-white/5 pt-4">
        <button type="button" class="btn btn-ghost" data-close>Annuler</button>
        <button type="submit" class="btn btn-primary">${icon.check}${game ? "Enregistrer" : "Ajouter"}</button>
      </div>
    </form>`,
  );

  const form = $<HTMLFormElement>("#game-form", m.el)!;
  const field = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  const refreshPreview = () => {
    $("#f-preview", m.el)!.innerHTML = coverPreview(field("title").value, field("cover_image_url").value, framing);
  };
  const editFormCover = async () => {
    const res = await openCoverEditor(
      { title: field("title").value || "?", cover_image_url: field("cover_image_url").value.trim(), ...framing },
      { pickImage: () => api.pickCover() },
    );
    if (!res) return;
    field("cover_image_url").value = res.cover_image_url;
    Object.assign(framing, { cover_zoom: res.cover_zoom, cover_x: res.cover_x, cover_y: res.cover_y });
    refreshPreview();
  };
  $("#f-preview", m.el)!.addEventListener("click", () => void editFormCover());
  $("#f-edit-cover", m.el)!.addEventListener("click", () => void editFormCover());
  field("title").addEventListener("input", refreshPreview);
  field("cover_image_url").addEventListener("change", () => {
    Object.assign(framing, { cover_zoom: 1, cover_x: 50, cover_y: 50 });
    refreshPreview();
  });

  $("#f-browse", m.el)!.addEventListener("click", async () => {
    try {
      const s = await api.scanExecutable();
      if (!s) return;
      field("executable_path").value = s.executable_path;
      field("install_dir").value = s.install_dir;
      if (!field("version").value) field("version").value = s.version;
      if (!field("title").value) field("title").value = s.title;
      refreshPreview();
    } catch (err) {
      errorToast(err);
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const input: GameInput = {
      title: String(fd.get("title") ?? ""),
      executable_path: String(fd.get("executable_path") ?? ""),
      install_dir: String(fd.get("install_dir") ?? ""),
      cover_image_url: String(fd.get("cover_image_url") ?? ""),
      version: String(fd.get("version") ?? ""),
      category: String(fd.get("category") ?? "installed") as Category,
      description: String(fd.get("description") ?? ""),
      ...framing,
      kind: String(fd.get("kind") ?? "game") as Kind,
      collection: String(fd.get("collection") ?? ""),
    };
    const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    submit.disabled = true;
    try {
      const saved = game ? await api.updateGame(game.id, input) : await api.addGame(input);
      state.games = game ? state.games.map((g) => (g.id === saved.id ? saved : g)) : [...state.games, saved];
      m.close();
      renderSidebar();
      if (state.view === "library") updateLibrary(true);
      else if (state.view === "launchers") renderLaunchers();
      toast(game ? "Jeu mis à jour" : "Jeu ajouté", saved.title);
    } catch (err) {
      errorToast(err, "Enregistrement impossible");
      submit.disabled = false;
    }
  });
}

function coverPreview(title: string, url: string, f: Pick<CoverLike, "cover_zoom" | "cover_x" | "cover_y">): string {
  return coverHtml({ title: title || "?", cover_image_url: url.trim(), ...f }, false);
}

/* ============================== Launchers ============================== */

function pickDefaultDrive(drives: DriveInfo[]): string | null {
  const fixed = drives.filter((d) => !d.removable && /^[A-Z]:\\?$/i.test(d.mount));
  if (fixed.length === 0) return drives[0]?.mount ?? null;
  const nonSystem = fixed.filter((d) => !/^C:/i.test(d.mount) && d.available_bytes > 50e9);
  const pool = nonSystem.length ? nonSystem : fixed;
  return [...pool].sort((a, b) => b.available_bytes - a.available_bytes)[0].mount;
}

async function loadLaunchers(): Promise<void> {
  try {
    const [launchers, drives] = await Promise.all([api.listLaunchers(), api.listDrives()]);
    state.launchers = launchers;
    state.drives = drives;
    if (!state.drive || !drives.some((d) => d.mount === state.drive)) state.drive = pickDefaultDrive(drives);
  } catch (err) {
    state.launchers = [];
    errorToast(err, "Détection impossible");
  }
}

function inLibrary(l: LauncherInfo): boolean {
  const exe = l.detected_exe?.toLowerCase();
  return !!exe && state.games.some((g) => g.executable_path.toLowerCase() === exe);
}

function renderLaunchers(): void {
  const view = $("#view")!;
  if (!state.launchers) {
    view.innerHTML = `<div class="grid h-full place-items-center text-sm text-muted"><span class="flex items-center gap-2"><span class="animate-spin">${icon.refresh}</span>Détection des launchers…</span></div>`;
    void loadLaunchers().then(() => state.view === "launchers" && renderLaunchers());
    return;
  }
  const drive = state.drive ?? "D:\\";
  const driveOptions = state.drives
    .map(
      (d) =>
        `<option value="${esc(d.mount)}" ${d.mount === drive ? "selected" : ""}>${esc(d.mount.replace(/\\$/, ""))} ${
          d.name ? `· ${esc(d.name)}` : ""
        } — ${formatBytes(d.available_bytes)} libres</option>`,
    )
    .join("");
  const detected = state.launchers.filter((l) => l.detected_exe).length;

  view.innerHTML = `
    <div class="mx-auto max-w-[1300px] px-10 pb-16 pt-8">
      <header class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 class="font-display text-[34px] font-bold tracking-tight">Launchers</h1>
          <p class="mt-1 text-sm text-muted">${detected}/${state.launchers.length} détectés. Chaque launcher a son guide pas-à-pas pour l'installer au bon endroit.</p>
        </div>
        <div class="flex items-center gap-2.5">
          <label class="flex items-center gap-2 text-sm text-muted" title="Disque utilisé par les guides">${icon.drive}
            <select id="drive" class="field !w-auto pr-8">${driveOptions || `<option>${esc(drive)}</option>`}</select>
          </label>
          <button class="btn btn-ghost" id="rescan">${icon.refresh}Relancer la détection</button>
        </div>
      </header>

      <section class="mt-7 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        ${state.launchers.map((l, i) => launcherCard(l, i, drive)).join("")}
      </section>
    </div>`;

  $<HTMLSelectElement>("#drive")?.addEventListener("change", (e) => {
    state.drive = (e.target as HTMLSelectElement).value;
    persist();
    renderLaunchers();
  });
  $("#rescan")!.addEventListener("click", rescan);
  view.querySelectorAll<HTMLElement>(".launcher-card").forEach((card) => card.addEventListener("click", onLauncherClick));
}

function launcherCard(l: LauncherInfo, i: number, drive: string): string {
  const steps = guideFor(l.id, l.name, l.recommended_folder, drive);
  const done = (state.guideDone[l.id] ?? []).filter((x) => x < steps.length).length;
  const pct = Math.round((done / steps.length) * 100);
  const added = inLibrary(l);

  return `
  <article class="launcher-card glass flex flex-col p-5" data-launcher="${esc(l.id)}" style="--i:${i}">
    <div class="flex items-start gap-4">
      <div class="launcher-logo shrink-0">${launcherLogo(l.id)}</div>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="font-display text-lg font-bold">${esc(l.name)}</h3>
          ${
            l.detected_exe
              ? `<span class="badge badge-ok">${icon.check.replace('class="icon"', 'class="h-3 w-3"')}Détecté</span>`
              : `<span class="badge">Non détecté</span>`
          }
        </div>
        <p class="mt-0.5 truncate text-xs text-muted" title="${esc(l.detected_exe ?? "")}">${
          l.detected_exe ? esc(l.detected_exe) : `${esc(l.publisher)} · dossier conseillé <code>${esc(l.recommended_folder)}</code>`
        }</p>
      </div>
    </div>
    <button class="mt-5 flex w-full items-center gap-3 rounded-xl border border-white/5 bg-black/20 px-3.5 py-3 text-left transition hover:border-white/20 hover:bg-white/[0.04]" data-act="guide">
      <span class="text-muted">${icon.book}</span>
      <span class="min-w-0 flex-1">
        <span class="block text-sm font-semibold">Guide d'installation</span>
        <span class="mt-1.5 flex items-center gap-2"><span class="progress flex-1"><i style="width:${pct}%"></i></span><span class="text-[11px] text-muted tabular-nums">${done}/${steps.length}</span></span>
      </span>
      <span class="text-muted">${icon.arrowRight}</span>
    </button>
    <div class="mt-3 flex flex-wrap gap-2">
      <button class="btn btn-ghost btn-sm" data-act="download">${icon.download}Télécharger</button>
      ${
        l.detected_exe
          ? added
            ? `<span class="btn btn-ghost btn-sm pointer-events-none opacity-60">${icon.check}Dans ta bibliothèque</span>`
            : `<button class="btn btn-ghost btn-sm" data-act="add">${icon.plus}Ajouter à la bibliothèque</button>`
          : ""
      }
    </div>
  </article>`;
}

async function rescan(): Promise<void> {
  state.launchers = null;
  renderLaunchers();
}

async function onLauncherClick(e: Event): Promise<void> {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  const card = e.currentTarget as HTMLElement;
  if (!btn) return;
  const id = card.dataset.launcher!;
  const l = state.launchers?.find((x) => x.id === id);
  if (!l) return;

  switch (btn.dataset.act) {
    case "guide":
      openGuide(l, {
        drive: state.drive ?? "D:\\",
        done: state.guideDone[id] ?? [],
        onProgress: (done) => {
          state.guideDone[id] = done;
          persist();
          if (state.view === "launchers") refreshLaunchersInPlace();
        },
        onRescan: () => void rescan(),
      });
      return;
    case "download":
      try {
        await api.openLauncherDownload(id);
        toast(`Page officielle de ${l.name} ouverte`, "Dans ton navigateur par défaut.");
      } catch (err) {
        errorToast(err);
      }
      return;
    case "add":
      try {
        const g = await api.addGame({
          title: l.name,
          executable_path: l.detected_exe!,
          install_dir: "",
          cover_image_url: "",
          version: "",
          category: "launcher",
          description: "",
          cover_zoom: 1,
          cover_x: 50,
          cover_y: 50,
          kind: "game",
          collection: "",
        });
        state.games.push(g);
        renderSidebar();
        refreshLaunchersInPlace();
        toast(`${l.name} ajouté`, "Retrouve-le dans le filtre « Launchers ».");
      } catch (err) {
        errorToast(err);
      }
      return;
  }
}

function refreshLaunchersInPlace(): void {
  const scroll = $("#view")!.scrollTop;
  renderLaunchers();
  $("#view")!.scrollTop = scroll;
  // Keep entry animations from replaying on in-place updates.
  document.querySelectorAll<HTMLElement>(".launcher-card").forEach((c) => (c.style.animation = "none"));
}

/* ============================== Profile & friends ============================== */

async function saveProfile(p: Profile): Promise<void> {
  state.profile = await api.saveProfile(p);
  renderSidebar();
  if (state.view === "profile") renderProfileView();
  else if (state.view === "library") updateLibrary(false);
}

const profileCtx: ProfileCtx = {
  profile: () => state.profile!,
  games: () => state.games,
  code: () => state.social?.me.code ?? "",
  save: saveProfile,
  openBox: (g) => openBox(g),
};

function renderProfileView(): void {
  const view = $("#view")!;
  if (!state.profile) {
    view.innerHTML = "";
    void loadProfile().then(() => state.view === "profile" && renderProfileView());
    return;
  }
  renderProfile(view, profileCtx);
}

function renderFriendsView(): void {
  renderFriends($("#view")!, {
    social: () => state.social,
    setEnabled: async (on) => {
      try {
        await saveSettings({ social_enabled: on });
        await refreshSocial();
        toast(on ? "Amis activés" : "Amis désactivés", on ? "Tu es visible sur ton réseau local." : "Tu n'es plus visible sur le réseau.");
      } catch (err) {
        errorToast(err);
      }
    },
    refresh: refreshSocial,
  });
}

async function loadProfile(): Promise<void> {
  try {
    state.profile = await api.getProfile();
  } catch {
    /* profile is optional */
  }
}

/** Reload friends / presence. Toasts new friend requests. */
async function refreshSocial(): Promise<void> {
  const before = new Set(state.social?.friends.filter((f) => f.state === "incoming").map((f) => f.id) ?? []);
  try {
    state.social = await api.socialState();
  } catch {
    return;
  }
  if (state.social.enabled) {
    state.social.friends
      .filter((f) => f.state === "incoming" && !before.has(f.id) && state.social !== null)
      .forEach((f) => toast("Demande d'ami", `${f.name} veut t'ajouter. Réponds depuis « Amis ».`, "info", 7000));
  }
  renderSidebar();
  if (state.view === "friends") {
    const scroll = $("#view")!.scrollTop;
    renderFriendsView();
    $("#view")!.scrollTop = scroll;
  }
}

/* ============================== Settings view ============================== */

function renderSettingsView(): void {
  renderSettings($("#view")!, {
    get: () => state.settings,
    save: saveSettings,
    scanNow,
    afterCacheClear: persist,
  });
}

/* ============================== Detection ============================== */

const detectionCtx = {
  onAdded: (games: Game[]) => {
    state.games = [...state.games, ...games];
    renderSidebar();
    if (state.view === "library") updateLibrary(true);
  },
};

async function scanNow(): Promise<void> {
  try {
    const found: Detected[] = await api.scanGamesNow();
    if (found.length === 0) toast("Aucun nouveau jeu trouvé", "Tous tes jeux installés sont déjà dans ta bibliothèque.");
    else showDetections(found, detectionCtx);
  } catch (err) {
    errorToast(err, "Analyse impossible");
  }
}

/* ============================== Boot ============================== */

async function refreshGames(): Promise<void> {
  const [games, running] = await Promise.all([api.listGames(), api.runningGames()]);
  state.games = games;
  state.running = new Map(running.map((r) => [r.game_id, r]));
}

async function setupDragDrop(): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  let overlay: HTMLElement | null = null;
  const hide = () => {
    overlay?.remove();
    overlay = null;
  };
  await getCurrentWebview().onDragDropEvent(async (ev) => {
    const p = ev.payload;
    if (p.type === "enter" || p.type === "over") {
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.className = "drop-overlay";
        overlay.innerHTML = `<div class="text-center"><div class="icon-tile mx-auto h-16 w-16 [&_.icon]:h-8 [&_.icon]:w-8">${icon.download}</div><p class="mt-4 font-display text-xl font-bold">Dépose ton .exe ici</p><p class="mt-1 text-sm text-muted">REZ launcher lira son nom et sa version.</p></div>`;
        document.body.appendChild(overlay);
      }
    } else if (p.type === "leave") {
      hide();
    } else if (p.type === "drop") {
      hide();
      const path = p.paths[0];
      if (!path) return;
      try {
        const s = await api.scanExecutable(path);
        if (s) openGameForm(undefined, s);
      } catch (err) {
        errorToast(err, "Fichier non pris en charge");
      }
    }
  });
}

async function boot(): Promise<void> {
  if (!isTauri()) {
    const m = await import("./mock");
    installMock(m.mockApi, m.mockEvents);
  }

  try {
    state.settings = await api.getSettings();
  } catch {
    /* defaults */
  }
  applyVisualPrefs(state.settings);
  renderShell();

  // Broken cover URL -> generated cover.
  document.addEventListener(
    "error",
    (e) => {
      const img = e.target as HTMLElement;
      if (img instanceof HTMLImageElement && img.classList.contains("cover-img")) {
        img.outerHTML = generatedCover(img.dataset.title ?? "?");
      }
    },
    true,
  );

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && state.view === "library") {
      e.preventDefault();
      $<HTMLInputElement>("#search")?.focus();
    }
  });

  try {
    await refreshGames();
  } catch (err) {
    errorToast(err, "Chargement de la bibliothèque impossible");
  }
  await loadProfile();
  void refreshSocial();
  try {
    state.uninstalling = new Set(await api.uninstallingGames());
  } catch {
    /* none */
  }

  await events.onGameStarted(onStarted);
  await events.onGameReady(({ game_id }) => onReady(game_id));
  await events.onGameStopped(({ game, session_seconds }) => {
    state.launches.get(game.id)?.close();
    state.launches.delete(game.id);
    state.running.delete(game.id);
    if (state.running.size === 0) document.documentElement.classList.remove("gaming");
    state.games = state.games.map((g) => (g.id === game.id ? game : g));
    renderSidebar();
    updateLibrary(true);
    toast(
      `Session terminée · ${game.title}`,
      `+${formatSession(session_seconds)} — ${formatPlaytime(game.playtime_minutes)} jouées sur ce jeu`,
      "info",
      7000,
    );
  });
  await events.onGameUninstalled(({ game_id, title, removed }) => {
    state.uninstalling.delete(game_id);
    if (removed) {
      state.games = state.games.filter((g) => g.id !== game_id);
      if (state.profile?.showcase.includes(game_id)) state.profile.showcase = state.profile.showcase.filter((id) => id !== game_id);
      toast("Jeu désinstallé", `${title} a été désinstallé et retiré de ta bibliothèque.`);
    } else {
      toast(`${title} toujours installé`, "Désinstallation annulée ou incomplète : le jeu reste dans ta bibliothèque.", "info", 7000);
    }
    renderSidebar();
    if (state.view === "library") updateLibrary(true);
  });
  await events.onSocialUpdated(() => void refreshSocial());
  await events.onGamesDetected(() => {
    void api.pendingDetections().then((l) => showDetections(l, detectionCtx), () => {});
  });
  void setupDragDrop();

  onUpdateStatus((s) => {
    state.updateAvailable = s.kind === "available";
    renderSidebar();
  });

  setInterval(tickTimers, 1000);
  // Back in REZ launcher during a game: animate again.
  const backInApp = () => document.documentElement.classList.remove("gaming");
  window.addEventListener("focus", backInApp);
  document.addEventListener("pointerdown", backInApp);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && backInApp());
  void api.fillMissingCovers().then((changed) => changed.forEach(replaceGame), () => {});
  state.view = state.settings.start_view;
  renderSidebar();
  renderView();

  // Games detected while the app was closed / before the UI was ready.
  try {
    const pending = await api.pendingDetections();
    if (pending.length) showDetections(pending, detectionCtx);
  } catch {
    /* ignore */
  }
  if (state.settings.check_updates_on_start) setTimeout(() => void checkForUpdates(true), 2500);
}

void boot();
