// "Carrousel 3D" library mode: game boxes on a horizontal 3D carousel.
import type { Game, RunningGame } from "./api";
import { boxHtml } from "./box3d";
import { esc } from "./format";
import { slot } from "./fx-math";
import { icon } from "./icons";

export interface CarouselCtx {
  games: Game[];
  activeId: number | null;
  running: Map<number, RunningGame>;
  /** Box width in px. */
  width: number;
  canPlay: (g: Game) => boolean;
  playedLabel: (g: Game) => string;
  onActive: (id: number) => void;
  onPlay: (g: Game) => void;
  onBox: (g: Game) => void;
  onCover: (g: Game) => void;
  onEdit: (g: Game) => void;
  onFolder: (g: Game) => void;
  /** Fan the boxes out from the centre (first display). */
  intro: boolean;
}

let detachKeys: (() => void) | null = null;

/** Only boxes this close to the centre are built. */
const WINDOW = 7;

export function mountCarousel(root: HTMLElement, ctx: CarouselCtx): void {
  const games = ctx.games;
  let active = Math.max(0, games.findIndex((g) => g.id === ctx.activeId));
  const w = ctx.width;

  root.innerHTML = `
    <div class="cf" tabindex="0" aria-roledescription="carrousel" style="height:${Math.round(w * 4 / 3 + 96)}px">
      <div class="cf-track">${games
        .map((g, i) => `<div class="cf-item" data-idx="${i}" style="--w:${w}px" aria-label="${esc(g.title)}"></div>`)
        .join("")}</div>
      <div class="cf-floor" style="top:${Math.round(w * 4 / 3 + 18)}px"></div>
      <button class="cf-nav prev" data-step="-1" title="Précédent (←)">${icon.arrowRight}</button>
      <button class="cf-nav next" data-step="1" title="Suivant (→)">${icon.arrowRight}</button>
    </div>
    <div class="cf-scrub mx-auto mt-1 w-[min(420px,60%)]"><i></i></div>
    <div data-info class="mx-auto mt-4 flex max-w-[680px] flex-col items-center text-center"></div>`;

  const cf = root.querySelector<HTMLElement>(".cf")!;
  const items = [...root.querySelectorAll<HTMLElement>(".cf-item")];
  const info = root.querySelector<HTMLElement>("[data-info]")!;
  const scrub = root.querySelector<HTMLElement>(".cf-scrub i")!;

  const layout = () => {
    items.forEach((el, i) => {
      const o = i - active;
      const p = slot(o, w);
      if (Math.abs(o) < WINDOW && !el.firstElementChild) el.innerHTML = boxHtml(games[i], { w });
      el.classList.toggle("active", o === 0);
      el.style.transform = `translate3d(${p.x}px,0,${p.z}px) rotateY(${p.ry}deg)`;
      el.style.opacity = p.visible ? "1" : "0";
      el.style.pointerEvents = p.visible ? "" : "none";
      const box = el.querySelector<HTMLElement>(".box3d");
      if (box) {
        box.classList.toggle("idle", o === 0);
        box.style.setProperty("--by", o === 0 ? "16deg" : "0deg");
        box.style.setProperty("--bx", o === 0 ? "-4deg" : "0deg");
      }
    });
    const n = Math.max(1, games.length);
    scrub.style.width = `${Math.max(100 / n, 6)}%`;
    scrub.style.left = `${n > 1 ? (active / (n - 1)) * (100 - Math.max(100 / n, 6)) : 0}%`;
    root.querySelector<HTMLButtonElement>(".cf-nav.prev")!.disabled = active === 0;
    root.querySelector<HTMLButtonElement>(".cf-nav.next")!.disabled = active >= games.length - 1;
    renderInfo();
  };

  const renderInfo = () => {
    const g = games[active];
    if (!g) return;
    const running = ctx.running.get(g.id);
    const playable = ctx.canPlay(g);
    info.innerHTML = `
      <div class="cf-info flex flex-col items-center" data-id="${g.id}">
        <h2 class="font-display text-[30px] font-bold leading-tight tracking-tight">${esc(g.title)}</h2>
        <p class="mt-1.5 flex items-center gap-1.5 text-sm text-muted">
          ${
            running
              ? `<span class="badge badge-live"><i class="dot"></i>En cours</span> Session <b class="tabular-nums text-white/90" data-since="${esc(running.started_at)}">0:00</b>`
              : `${icon.clock}<b class="text-white/90">${esc(ctx.playedLabel(g))}</b> sur ce jeu`
          }
        </p>
        <div class="mt-5 flex flex-wrap justify-center gap-2">
          ${
            playable && !running
              ? `<button class="btn btn-primary !h-11 !px-7 text-[15px]" data-cf="play"><span class="[&_svg]:h-4 [&_svg]:w-4">${icon.play}</span>Jouer</button>`
              : ""
          }
          <button class="btn btn-ghost !h-11" data-cf="box" title="Voir la boîte (Espace)">${icon.box}Boîte 3D</button>
          <button class="btn btn-ghost !h-11" data-cf="cover">${icon.image}Jaquette</button>
          <button class="btn btn-ghost !h-11 !px-3" data-cf="folder" title="Ouvrir l'emplacement" ${g.install_dir || g.executable_path ? "" : "disabled"}>${icon.folder}</button>
          <button class="btn btn-ghost !h-11 !px-3" data-cf="edit" title="Modifier">${icon.edit}</button>
        </div>
        <p class="mt-4 text-[11.5px] text-white/30">${active + 1} / ${games.length} · ← → molette ou glisser · Entrée pour jouer</p>
      </div>`;
  };

  const go = (i: number) => {
    const next = Math.max(0, Math.min(games.length - 1, i));
    if (next === active) return;
    active = next;
    layout();
    ctx.onActive(games[active].id);
  };

  // Clicks: side box -> bring to centre; centre box -> open it.
  let dragged = false;
  cf.addEventListener("click", (e) => {
    if (dragged) return;
    const step = (e.target as HTMLElement).closest<HTMLElement>("[data-step]");
    if (step) return go(active + Number(step.dataset.step));
    const item = (e.target as HTMLElement).closest<HTMLElement>(".cf-item");
    if (!item) return;
    const i = Number(item.dataset.idx);
    if (i === active) ctx.onBox(games[i]);
    else go(i);
  });
  info.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-cf]")?.dataset.cf;
    const g = games[active];
    if (!act || !g) return;
    const handlers: Record<string, (g: Game) => void> = {
      play: ctx.onPlay,
      box: ctx.onBox,
      cover: ctx.onCover,
      edit: ctx.onEdit,
      folder: ctx.onFolder,
    };
    handlers[act]?.(g);
  });

  // Wheel (vertical or horizontal) -> one box per notch.
  let acc = 0;
  let lastStep = 0;
  cf.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      acc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const now = performance.now();
      if (Math.abs(acc) >= 40 && now - lastStep > 110) {
        go(active + Math.sign(acc));
        acc = 0;
        lastStep = now;
      }
    },
    { passive: false },
  );

  // Drag / swipe.
  let drag: { x: number; from: number } | null = null;
  cf.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    drag = { x: e.clientX, from: active };
    dragged = false;
  });
  cf.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 6 && !dragged) {
      dragged = true;
      cf.setPointerCapture(e.pointerId);
      cf.classList.add("dragging");
    }
    if (dragged) go(drag.from - Math.round(dx / (w * 0.45)));
  });
  const endDrag = () => {
    drag = null;
    cf.classList.remove("dragging");
    setTimeout(() => (dragged = false), 0);
  };
  cf.addEventListener("pointerup", endDrag);
  cf.addEventListener("pointercancel", endDrag);

  // Keyboard, while the carousel is on screen and nothing is layered on top.
  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected) return document.removeEventListener("keydown", onKey);
    if (document.querySelector(".modal-backdrop, .layer")) return;
    const t = e.target as HTMLElement;
    if (t.matches("input, textarea, select")) return;
    const g = games[active];
    if (e.key === "ArrowRight") go(active + 1);
    else if (e.key === "ArrowLeft") go(active - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(games.length - 1);
    else if (e.key === "Enter" && g && ctx.canPlay(g) && !ctx.running.has(g.id)) ctx.onPlay(g);
    else if (e.key === " " && g) ctx.onBox(g);
    else return;
    e.preventDefault();
  };
  detachKeys?.();
  document.addEventListener("keydown", onKey);
  detachKeys = () => document.removeEventListener("keydown", onKey);

  if (!ctx.intro) cf.classList.add("no-trans");
  layout();
  void cf.offsetWidth; // commit positions before re-enabling transitions
  cf.classList.remove("no-trans");
}
