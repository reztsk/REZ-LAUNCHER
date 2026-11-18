import "./styles.css";
import { api, events, coverSrc, isTauri, installMock } from "./api";
import type { Category, DriveInfo, Game, GameInput, LauncherInfo, RunningGame, ScannedExe } from "./api";
import { esc, formatBytes, formatClock, formatPlaytime, formatRelative, formatSession, hueFrom, initials } from "./format";
import { guideFor } from "./guides";
import { icon } from "./icons";
import { confirmModal, errorToast, openModal, toast } from "./ui";

type View = "library" | "launchers";
type Filter = "all" | Category;
type Sort = "title" | "playtime" | "recent";

const LS_KEY = "gamerez.ui.v1";

interface Persisted {
  filter: Filter;
  sort: Sort;
  drive: string | null;
  guideDone: Record<string, number[]>;
}

function loadPersisted(): Persisted {
  const fallback: Persisted = { filter: "all", sort: "recent", drive: null, guideDone: {} };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") };
  } catch {
    return fallback;
  }
}

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
  guideOpen: null as string | null,
  guideDone: persisted.guideDone,
  launching: new Set<number>(),
};

function persist(): void {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ filter: state.filter, sort: state.sort, drive: state.drive, guideDone: state.guideDone }),
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

function withTransition(fn: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(fn);
  else fn();
}

/* ============================== Shell ============================== */

function renderShell(): void {
  app.innerHTML = `
    <aside class="sidebar flex h-full flex-col px-[14px] py-6">
      <div class="flex items-center gap-3 px-2">
        <img src="/logo-mark.svg" alt="" class="h-10 w-10 drop-shadow-[0_0_12px_rgba(255,255,255,0.25)]" />
        <div class="leading-none">
          <div class="font-display text-[22px] font-black tracking-[0.12em]">GAME<span class="text-grad">REZ</span></div>
          <div class="mt-1 text-[10px] font-semibold uppercase tracking-[0.28em] text-muted">Launcher</div>
        </div>
      </div>

      <nav class="mt-9 flex flex-col gap-1 px-[14px]">
        <button class="nav-btn" data-nav="library">${icon.grid}<span class="flex-1 text-left">Bibliothèque</span><span id="nav-count" class="text-xs text-muted"></span></button>
        <button class="nav-btn" data-nav="launchers">${icon.rocket}<span class="flex-1 text-left">Launchers</span></button>
      </nav>

      <div id="side-stats" class="glass mx-1 mt-8 rounded-2xl p-4"></div>

      <div class="mt-auto px-2">
        <div class="flex items-start gap-2.5 rounded-xl border border-white/5 bg-white/[0.02] p-3 text-[11.5px] leading-snug text-muted">
          <span class="mt-0.5 text-emerald-400">${icon.shield}</span>
          <span><b class="text-white/80">Zéro risque de ban.</b> GameREZ lance tes jeux comme un raccourci et chronomètre le processus. Aucune injection, aucun fichier de jeu modifié.</span>
        </div>
        <p class="mt-3 text-center text-[11px] text-white/25">Open source · v0.1.0</p>
      </div>
    </aside>
    <main id="view" class="relative h-full overflow-y-auto"></main>`;

  app.querySelectorAll<HTMLElement>("[data-nav]").forEach((b) =>
    b.addEventListener("click", () => switchView(b.dataset.nav as View)),
  );
}

function renderSidebar(): void {
  document.querySelectorAll<HTMLElement>("[data-nav]").forEach((b) => {
    if (b.dataset.nav === state.view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  const games = state.games.filter((g) => g.category !== "launcher");
  $("#nav-count")!.textContent = String(games.length);
  const total = games.reduce((s, g) => s + g.playtime_minutes, 0);
  const top = [...games].sort((a, b) => b.playtime_minutes - a.playtime_minutes)[0];
  const live = state.running.size;
  $("#side-stats")!.innerHTML = `
    <p class="label !mb-1">Temps de jeu total</p>
    <p class="font-display text-[26px] font-bold tracking-tight">${formatPlaytime(total)}</p>
    <div class="mt-3 grid grid-cols-2 gap-2 text-xs">
      <div class="rounded-lg bg-white/[0.03] p-2"><p class="text-muted">Jeux</p><p class="mt-0.5 text-sm font-semibold">${games.length}</p></div>
      <div class="rounded-lg bg-white/[0.03] p-2"><p class="text-muted">En cours</p><p class="mt-0.5 text-sm font-semibold ${live ? "text-cyan-300" : ""}">${live}</p></div>
    </div>
    ${
      top && top.playtime_minutes > 0
        ? `<p class="mt-3 truncate text-xs text-muted">Le plus joué : <span class="text-white/85">${esc(top.title)}</span></p>`
        : ""
    }`;
}

function switchView(view: View): void {
  if (view === state.view && $("#view")!.childElementCount) return;
  state.view = view;
  renderSidebar();
  withTransition(() => {
    if (view === "library") renderLibrary();
    else renderLaunchers();
  });
}

/* ============================== Library ============================== */

function visibleGames(): Game[] {
  const q = state.search.trim().toLowerCase();
  const list = state.games.filter(
    (g) => (state.filter === "all" || g.category === state.filter) && (!q || g.title.toLowerCase().includes(q)),
  );
  const byTitle = (a: Game, b: Game) => a.title.localeCompare(b.title, "fr", { sensitivity: "base" });
  switch (state.sort) {
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
          <p class="mt-1 text-sm text-muted">Tous tes jeux, un seul endroit. Le temps de jeu est mesuré à la seconde près.</p>
        </div>
        <div class="flex items-center gap-2.5">
          <label class="relative">
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">${icon.search}</span>
            <input id="search" class="field w-64 !pl-10" placeholder="Rechercher…  (Ctrl+F)" value="${esc(state.search)}" spellcheck="false" />
          </label>
          <select id="sort" class="field !w-auto pr-8" title="Trier">
            <option value="recent">Récents</option>
            <option value="playtime">Temps de jeu</option>
            <option value="title">A → Z</option>
          </select>
          <button class="btn btn-primary" id="add-game">${icon.plus}Ajouter un jeu</button>
        </div>
      </header>
      <section id="hero-slot" class="mt-7"></section>
      <div class="mt-7 flex items-center justify-between gap-4">
        <div id="tabs" class="tabs glass" role="tablist"></div>
        <p id="result-count" class="text-xs text-muted"></p>
      </div>
      <section id="grid" class="grid-games mt-6"></section>
    </div>`;

  $<HTMLSelectElement>("#sort")!.value = state.sort;
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
  if (animate) withTransition(run);
  else run();
}

function renderTabs(): void {
  const tabs = $("#tabs")!;
  const count = (f: Filter) => (f === "all" ? state.games.length : state.games.filter((g) => g.category === f).length);
  const items: [Filter, string][] = [
    ["all", "Tous"],
    ["installed", "Installés"],
    ["not_installed", "Non installés"],
    ["launcher", "Launchers"],
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

function generatedCover(title: string): string {
  const h = hueFrom(title);
  return `<div class="gen" style="background:
      radial-gradient(circle at 25% 15%, hsl(${(h + 40) % 360} 85% 60% / .45), transparent 55%),
      linear-gradient(155deg, hsl(${h} 70% 34%), hsl(${(h + 60) % 360} 70% 16%) 62%, #0a0914)">
      <span class="mark" style="background:url(/logo-mark.svg) center/contain no-repeat;aspect-ratio:1"></span>
      <span class="initials">${esc(initials(title))}</span>
    </div>`;
}

function coverHtml(g: Game): string {
  const src = coverSrc(g.cover_image_url);
  return src
    ? `<img class="cover-img" src="${esc(src)}" alt="" loading="lazy" draggable="false" data-title="${esc(g.title)}" />`
    : generatedCover(g.title);
}

function canPlay(g: Game): boolean {
  return g.category !== "not_installed" && !!g.executable_path && !g.exe_missing;
}

function cardHtml(g: Game, i: number): string {
  const running = state.running.get(g.id);
  const isOpen = state.open.has(g.id);
  const enter = !state.seen.has(g.id);
  const badges: string[] = [];
  if (running) badges.push(`<span class="badge badge-live"><i class="dot"></i>En cours</span>`);
  else if (g.category !== "installed") badges.push(`<span class="badge">${CATEGORY_LABEL[g.category]}</span>`);
  if (g.exe_missing) badges.push(`<span class="badge badge-warn" title="${esc(g.executable_path)}">Exe introuvable</span>`);
  const dir = g.install_dir || g.executable_path;
  const sub = running
    ? `<span class="text-cyan-300">Session <b data-since="${esc(running.started_at)}" class="font-semibold tabular-nums">0:00</b></span>`
    : `${formatPlaytime(g.playtime_minutes)} · ${formatRelative(g.last_played_at)}`;

  return `
  <article class="card ${isOpen ? "open" : ""} ${running ? "is-running" : ""}" data-id="${g.id}"
           style="--i:${enter ? Math.min(i, 16) : 0};${enter ? "" : "animation:none;"}view-transition-name:g-${g.id}">
    <div class="cover" data-action="${canPlay(g) ? "play" : "toggle"}" title="${canPlay(g) ? "Jouer" : "Options"}">
      ${coverHtml(g)}
      <div class="shade"></div>
      <div class="absolute left-2.5 top-2.5 flex flex-wrap gap-1.5">${badges.join("")}</div>
      ${
        canPlay(g) && !running
          ? `<button class="play-fab" data-action="play" aria-label="Jouer à ${esc(g.title)}">${icon.play}</button>`
          : ""
      }
    </div>
    <div class="mt-3 flex items-start gap-2 px-0.5">
      <div class="min-w-0 flex-1">
        <h3 class="truncate text-[15px] font-semibold" title="${esc(g.title)}">${esc(g.title)}</h3>
        <p class="mt-0.5 truncate text-xs text-muted">${sub}</p>
      </div>
      <button class="opt-toggle" data-action="toggle" aria-expanded="${isOpen}" title="Options">${icon.chevron}</button>
    </div>
    <div class="options"><div>
      <div class="glass rounded-xl px-3 py-1">
        <div class="opt-row"><span>Temps de jeu</span><span class="text-grad">${formatPlaytime(g.playtime_minutes)}</span></div>
        <div class="opt-row"><span>Version</span><span>${esc(g.version || "—")}</span></div>
        <div class="opt-row"><span>Dernière session</span><span>${formatRelative(g.last_played_at)}</span></div>
        <div class="opt-row"><span>Catégorie</span><span>${CATEGORY_LABEL[g.category]}</span></div>
      </div>
      <div class="mt-2 grid grid-cols-[1fr_auto_auto] gap-1.5">
        <button class="btn btn-ghost btn-sm" data-action="open-folder" ${dir ? "" : "disabled"} title="${esc(dir)}">${icon.folder}Ouvrir l'emplacement</button>
        <button class="btn btn-ghost btn-sm !px-2.5" data-action="edit" title="Modifier">${icon.edit}</button>
        <button class="btn btn-danger btn-sm !px-2.5" data-action="delete" title="Supprimer">${icon.trash}</button>
      </div>
    </div></div>
  </article>`;
}

function renderGrid(): void {
  const grid = $("#grid")!;
  const list = visibleGames();
  $("#result-count")!.textContent = `${list.length} ${list.length > 1 ? "éléments" : "élément"}`;
  if (list.length === 0) {
    const emptyLib = state.games.length === 0;
    grid.innerHTML = `
      <div class="empty glass col-span-full flex flex-col items-center rounded-3xl px-8 py-16 text-center">
        <div class="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-cyan-400/20 to-violet-500/30 text-violet-200 [&_.icon]:h-8 [&_.icon]:w-8">${icon.gamepad}</div>
        <h3 class="mt-5 font-display text-xl font-bold">${emptyLib ? "Ta bibliothèque est vide" : "Aucun résultat"}</h3>
        <p class="mt-2 max-w-md text-sm text-muted">${
          emptyLib
            ? "Ajoute un jeu via son .exe — ou glisse-dépose l'exécutable directement dans la fenêtre."
            : "Essaie un autre filtre ou une autre recherche."
        }</p>
        ${emptyLib ? `<button class="btn btn-primary mt-6" data-action="add">${icon.plus}Ajouter mon premier jeu</button>` : ""}
      </div>`;
    grid.querySelector('[data-action="add"]')?.addEventListener("click", () => openGameForm());
    return;
  }
  grid.innerHTML = list.map(cardHtml).join("");
  list.forEach((g) => state.seen.add(g.id));
  tickTimers();
}

function renderHero(): void {
  const slot = $("#hero-slot")!;
  const showHero = state.filter === "all" && !state.search.trim();
  const candidates = state.games.filter((g) => g.category === "installed" && g.last_played_at && canPlay(g));
  const g = candidates.sort((a, b) => b.last_played_at!.localeCompare(a.last_played_at!))[0];
  if (!showHero || !g) {
    slot.innerHTML = "";
    slot.classList.remove("mt-7");
    return;
  }
  slot.classList.add("mt-7");
  const src = coverSrc(g.cover_image_url);
  const h = hueFrom(g.title);
  const bg = src
    ? `background-image:url('${esc(src)}')`
    : `background:linear-gradient(120deg, hsl(${h} 80% 45%), hsl(${(h + 70) % 360} 80% 35%))`;
  const running = state.running.get(g.id);
  slot.innerHTML = `
    <div class="hero glass" data-id="${g.id}">
      <div class="hero-bg" style="${bg}"></div>
      <div class="hero-content flex items-center gap-7 p-7">
        <div class="cover hidden w-[118px] shrink-0 sm:block" data-action="play">${coverHtml(g)}</div>
        <div class="min-w-0 flex-1">
          <p class="text-[11px] font-bold uppercase tracking-[0.25em] text-cyan-300/90">${running ? "En cours" : "Reprendre"}</p>
          <h2 class="mt-2 truncate font-display text-[30px] font-bold tracking-tight">${esc(g.title)}</h2>
          <div class="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
            <span class="flex items-center gap-1.5">${icon.clock}<b class="text-white/90">${formatPlaytime(g.playtime_minutes)}</b> au total</span>
            <span>Dernière session : <b class="text-white/90">${formatRelative(g.last_played_at)}</b></span>
            ${g.version ? `<span>Version <b class="text-white/90">${esc(g.version)}</b></span>` : ""}
          </div>
        </div>
        <div class="flex shrink-0 gap-2">
          <button class="btn btn-ghost" data-action="open-folder">${icon.folder}Emplacement</button>
          ${
            running
              ? `<span class="btn btn-ghost !border-cyan-400/40 text-cyan-200 tabular-nums">${icon.clock}<b data-since="${esc(running.started_at)}">0:00</b></span>`
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
      try {
        await api.openFolder(game.install_dir || game.executable_path);
      } catch (err) {
        errorToast(err, "Emplacement introuvable");
      }
      return;
    case "edit":
      return openGameForm(game);
    case "delete": {
      const ok = await confirmModal(
        "Supprimer ce jeu ?",
        `<b class="text-white">${esc(game.title)}</b> sera retiré de GameREZ avec son historique de sessions (${formatPlaytime(
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

async function launch(game: Game): Promise<void> {
  if (state.launching.has(game.id) || state.running.has(game.id)) return;
  state.launching.add(game.id);
  try {
    const rg = await api.launchGame(game.id);
    if (game.category === "launcher") {
      toast(`${game.title} ouvert`, "Les launchers ne sont pas chronométrés.");
    } else {
      onStarted(rg);
      toast(`C'est parti : ${game.title}`, "Le chrono tourne. Bon jeu !");
    }
  } catch (err) {
    errorToast(err, "Lancement impossible");
  } finally {
    state.launching.delete(game.id);
  }
}

function onStarted(rg: RunningGame): void {
  if (state.running.has(rg.game_id)) return;
  state.running.set(rg.game_id, rg);
  renderSidebar();
  updateLibrary(true);
}

/* Subtle 3D tilt + light sheen following the cursor. */
function onTilt(e: MouseEvent): void {
  const cover = (e.target as HTMLElement).closest<HTMLElement>(".cover");
  const card = cover?.closest<HTMLElement>(".card");
  if (!cover || !card) return;
  const r = cover.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  card.style.setProperty("--ry", `${(x - 0.5) * 10}deg`);
  card.style.setProperty("--rx", `${(0.5 - y) * 10}deg`);
  card.style.setProperty("--mx", `${x * 100}%`);
  card.style.setProperty("--my", `${y * 100}%`);
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
  };
  const seg = (c: Category, label: string) =>
    `<label><input type="radio" name="category" value="${c}" ${v.category === c ? "checked" : ""}/><span>${label}</span></label>`;

  const m = openModal(
    game ? "Modifier le jeu" : "Ajouter un jeu",
    `<form id="game-form" class="grid grid-cols-[132px_1fr] gap-5" autocomplete="off">
      <div>
        <div id="f-preview" class="cover !cursor-default">${coverPreview(v.title, v.cover_image_url)}</div>
        <button type="button" class="btn btn-ghost btn-sm mt-2 w-full" id="f-pick-cover">${icon.image}Image locale</button>
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
        <div><span class="label">Catégorie</span>
          <div class="seg">${seg("installed", "Installé")}${seg("not_installed", "Non installé")}${seg("launcher", "Launcher")}</div></div>
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
    $("#f-preview", m.el)!.innerHTML = coverPreview(field("title").value, field("cover_image_url").value);
  };
  field("title").addEventListener("input", refreshPreview);
  field("cover_image_url").addEventListener("change", refreshPreview);

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
  $("#f-pick-cover", m.el)!.addEventListener("click", async () => {
    try {
      const p = await api.pickCover();
      if (p) {
        field("cover_image_url").value = p;
        refreshPreview();
      }
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
    };
    const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    submit.disabled = true;
    try {
      const saved = game ? await api.updateGame(game.id, input) : await api.addGame(input);
      state.games = game ? state.games.map((g) => (g.id === saved.id ? saved : g)) : [...state.games, saved];
      m.close();
      renderSidebar();
      if (state.view === "library") updateLibrary(true);
      else renderLaunchers();
      toast(game ? "Jeu mis à jour" : "Jeu ajouté", saved.title);
    } catch (err) {
      errorToast(err, "Enregistrement impossible");
      submit.disabled = false;
    }
  });
}

function coverPreview(title: string, url: string): string {
  const src = coverSrc(url.trim());
  return src
    ? `<img class="cover-img" src="${esc(src)}" alt="" data-title="${esc(title || "?")}" />`
    : generatedCover(title || "?");
}

/* ============================== Launchers ============================== */

const LAUNCHER_STYLE: Record<string, string> = {
  steam: "linear-gradient(135deg,#1b2838,#2a475e 60%,#66c0f4)",
  epic: "linear-gradient(135deg,#202020,#3a3a3a 60%,#9a9a9a)",
  battlenet: "linear-gradient(135deg,#0b3d91,#148eff)",
  ubisoft: "linear-gradient(135deg,#1d1aa8,#0070ff 55%,#a855f7)",
  gog: "linear-gradient(135deg,#4b1659,#86328a)",
  ea: "linear-gradient(135deg,#7a1020,#ff4747)",
};

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
  const driveLabel = drive.replace(/\\$/, "");
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
          <h1 class="font-display text-[34px] font-bold tracking-tight">Launchers <span class="text-grad">& PC propre</span></h1>
          <p class="mt-1 text-sm text-muted">Installe tes launchers au bon endroit, une bonne fois pour toutes. ${detected}/${state.launchers.length} détectés.</p>
        </div>
        <div class="flex items-center gap-2.5">
          <label class="flex items-center gap-2 text-sm text-muted">${icon.drive}
            <select id="drive" class="field !w-auto pr-8" title="Disque de jeux">${driveOptions || `<option>${esc(driveLabel)}</option>`}</select>
          </label>
          <button class="btn btn-ghost" id="rescan">${icon.refresh}Relancer la détection</button>
        </div>
      </header>

      <section class="mt-7 grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <div class="glass rounded-2xl p-5">
          <p class="label">Structure recommandée</p>
          <div class="tree mt-2">${structureTree(driveLabel)}</div>
        </div>
        <div class="glass rounded-2xl p-5">
          <p class="label">Les règles d'or</p>
          <ul class="mt-3 space-y-3 text-sm">
            ${[
              ["Un seul dossier racine", `Tous tes jeux dans <code>${esc(driveLabel)}\\Jeux</code>, rien dans <code>Program Files</code>.`],
              ["Un sous-dossier par launcher", "Plus de doublons, plus de jeux perdus, désinstallation propre."],
              ["Sites officiels uniquement", "Les boutons « Télécharger » ouvrent la page officielle de l'éditeur."],
              ["Un disque dédié si possible", "Garde ton disque système (C:) léger et rapide."],
            ]
              .map(
                ([t, b]) =>
                  `<li class="flex gap-3"><span class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-violet-500/20 text-violet-200 [&_.icon]:h-3 [&_.icon]:w-3">${icon.check}</span><span><b class="text-white/90">${t}.</b> <span class="text-muted">${b}</span></span></li>`,
              )
              .join("")}
          </ul>
        </div>
      </section>

      <section class="mt-6 grid items-start gap-4 xl:grid-cols-2">
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

function structureTree(drive: string): string {
  const ls = state.launchers ?? [];
  const lines = ls.map((l, i) => {
    const last = i === ls.length - 1;
    const sub = l.id === "steam" ? "steamapps\\common\\…" : "Games\\…";
    return `${last ? "└─" : "├─"} <b>${esc(l.recommended_folder)}\\</b>  <em>${esc(l.name)} + ${sub}</em>`;
  });
  return `<b>${esc(drive)}\\</b>\n└─ <b>Jeux\\</b>\n${lines.map((l) => "   " + l).join("\n")}`;
}

function launcherCard(l: LauncherInfo, i: number, drive: string): string {
  const open = state.guideOpen === l.id;
  const steps = guideFor(l.id, l.name, l.recommended_folder, drive);
  const done = new Set(state.guideDone[l.id] ?? []);
  const pct = Math.round((done.size / steps.length) * 100);
  const added = inLibrary(l);
  const initialsTxt = l.name.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase();

  return `
  <article class="launcher-card glass p-5" data-launcher="${esc(l.id)}" style="--i:${i}">
    <div class="flex items-start gap-4">
      <div class="launcher-logo shrink-0" style="background:${LAUNCHER_STYLE[l.id] ?? "var(--grad)"}">${esc(initialsTxt)}</div>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="font-display text-lg font-bold">${esc(l.name)}</h3>
          ${
            l.detected_exe
              ? `<span class="badge !border-emerald-400/40 !text-emerald-300">${icon.check.replace('class="icon"', 'class="h-3 w-3"')}Détecté</span>`
              : `<span class="badge">Non détecté</span>`
          }
        </div>
        <p class="mt-0.5 truncate text-xs text-muted" title="${esc(l.detected_exe ?? "")}">${
          l.detected_exe ? esc(l.detected_exe) : `${esc(l.publisher)} · dossier conseillé <code>${esc(l.recommended_folder)}</code>`
        }</p>
      </div>
    </div>
    <div class="mt-4 flex flex-wrap gap-2">
      <button class="btn btn-ghost btn-sm" data-act="download">${icon.download}Télécharger</button>
      ${
        l.detected_exe
          ? added
            ? `<span class="btn btn-ghost btn-sm pointer-events-none opacity-60">${icon.check}Dans ta bibliothèque</span>`
            : `<button class="btn btn-ghost btn-sm" data-act="add">${icon.plus}Ajouter à la bibliothèque</button>`
          : ""
      }
      <button class="btn btn-sm ${open ? "btn-primary" : "btn-ghost"} ml-auto" data-act="guide" aria-expanded="${open}">${icon.book}Guide de rangement<span class="ml-1 text-[11px] opacity-70">${pct}%</span></button>
    </div>
    ${
      open
        ? `<div class="mt-5 rounded-xl border border-white/5 bg-black/20 p-4">
        <div class="flex items-center gap-3"><div class="progress flex-1"><i style="width:${pct}%"></i></div><span class="text-xs text-muted">${done.size}/${steps.length}</span></div>
        <ol class="steps mt-2">
          ${steps
            .map((s, idx) => {
              const isDone = done.has(idx);
              let action = "";
              if (s.action?.kind === "create_folder")
                action = `<button class="btn btn-ghost btn-sm" data-act="mkdir" data-path="${esc(s.action.path)}" title="Créer ${esc(s.action.path)}">${icon.folderPlus}Créer</button>`;
              else if (s.action?.kind === "download")
                action = `<button class="btn btn-ghost btn-sm" data-act="download">${icon.external}Site officiel</button>`;
              else if (s.action?.kind === "rescan")
                action = `<button class="btn btn-ghost btn-sm" data-act="rescan">${icon.refresh}Détecter</button>`;
              return `<li class="step ${isDone ? "done" : ""}">
                <button class="step-check" data-act="check" data-step="${idx}" aria-pressed="${isDone}" title="Marquer comme fait">${isDone ? icon.check.replace('class="icon"', 'class="h-4 w-4"') : idx + 1}</button>
                <div class="min-w-0"><p class="step-title text-sm font-semibold">${s.title}</p><p class="mt-1 text-[13px] leading-relaxed text-muted">${s.body}</p></div>
                <div>${action}</div>
              </li>`;
            })
            .join("")}
        </ol>
      </div>`
        : ""
    }
  </article>`;
}

async function rescan(): Promise<void> {
  state.launchers = null;
  renderLaunchers();
}

function markStep(id: string, idx: number, value?: boolean): void {
  const set = new Set(state.guideDone[id] ?? []);
  const on = value ?? !set.has(idx);
  if (on) set.add(idx);
  else set.delete(idx);
  state.guideDone[id] = [...set].sort((a, b) => a - b);
  persist();
}

async function onLauncherClick(e: Event): Promise<void> {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  const card = e.currentTarget as HTMLElement;
  if (!btn) return;
  const id = card.dataset.launcher!;
  const l = state.launchers?.find((x) => x.id === id);
  if (!l) return;
  const steps = guideFor(l.id, l.name, l.recommended_folder, state.drive ?? "D:\\");

  switch (btn.dataset.act) {
    case "download":
      try {
        await api.openLauncherDownload(id);
        const dl = steps.findIndex((s) => s.action?.kind === "download");
        if (state.guideOpen === id && dl >= 0) markStep(id, dl, true);
        toast(`Page officielle de ${l.name} ouverte`, "Dans ton navigateur par défaut.");
      } catch (err) {
        errorToast(err);
      }
      break;
    case "add":
      try {
        const g = await api.addGame({
          title: l.name,
          executable_path: l.detected_exe!,
          install_dir: "",
          cover_image_url: "",
          version: "",
          category: "launcher",
        });
        state.games.push(g);
        renderSidebar();
        toast(`${l.name} ajouté`, "Retrouve-le dans le filtre « Launchers ».");
      } catch (err) {
        errorToast(err);
      }
      break;
    case "guide":
      state.guideOpen = state.guideOpen === id ? null : id;
      break;
    case "check":
      markStep(id, Number(btn.dataset.step));
      break;
    case "mkdir":
      try {
        const p = await api.createFolder(btn.dataset.path!);
        const idx = steps.findIndex((s) => s.action?.kind === "create_folder" && s.action.path === btn.dataset.path);
        if (idx >= 0) markStep(id, idx, true);
        toast("Dossier prêt", p);
      } catch (err) {
        errorToast(err, "Création impossible");
      }
      break;
    case "rescan":
      return rescan();
  }
  if (state.view === "launchers") {
    const scroll = $("#view")!.scrollTop;
    renderLaunchers();
    $("#view")!.scrollTop = scroll;
    // Keep entry animations from replaying on in-place updates.
    document.querySelectorAll<HTMLElement>(".launcher-card").forEach((c) => (c.style.animation = "none"));
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
        overlay.innerHTML = `<div class="text-center"><div class="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-violet-500/20 text-violet-200 [&_.icon]:h-8 [&_.icon]:w-8">${icon.download}</div><p class="mt-4 font-display text-xl font-bold">Dépose ton .exe ici</p><p class="mt-1 text-sm text-muted">GameREZ lira son nom et sa version.</p></div>`;
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

  await events.onGameStarted(onStarted);
  await events.onGameStopped(({ game, session_seconds }) => {
    state.running.delete(game.id);
    state.games = state.games.map((g) => (g.id === game.id ? game : g));
    renderSidebar();
    updateLibrary(true);
    toast(
      `Session terminée · ${game.title}`,
      `+${formatSession(session_seconds)} — total ${formatPlaytime(game.playtime_minutes)}`,
      "info",
      7000,
    );
  });
  void setupDragDrop();

  setInterval(tickTimers, 1000);
  state.view = "library";
  renderSidebar();
  renderLibrary();
}

void boot();
