// Interactive 3D game box: front = cover, spine = embossed title,
// back = description over the blurred artwork. Pure CSS 3D transforms.
import type { Game } from "./api";
import { coverBg, coverHtml, type CoverLike } from "./covers";
import { esc, formatPlaytime, formatRelative } from "./format";
import { icon } from "./icons";

export interface BoxOptions {
  /** Box width in px (height = 4/3, depth ≈ 13 %). */
  w: number;
  /** Front swings open on `.open` (launch sequence). */
  door?: boolean;
  cls?: string;
}

/** Text of the back cover: the user's description, or a generated one. */
export function backText(g: Game): string {
  if (g.description.trim()) return g.description.trim();
  const since = new Date(g.added_at);
  const date = Number.isNaN(since.getTime())
    ? ""
    : ` depuis le ${since.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}`;
  const played =
    g.category === "launcher"
      ? "Les launchers ne sont pas chronométrés."
      : g.playtime_minutes > 0
        ? `${formatPlaytime(g.playtime_minutes)} jouées en ${g.session_count} session${g.session_count > 1 ? "s" : ""}.`
        : "Pas encore lancé : à toi de jouer.";
  return `${g.title} fait partie de ta bibliothèque REZ launcher${date}. ${played}\n\nAjoute ta propre description depuis « Modifier ».`;
}

function backHtml(g: Game | CoverLike): string {
  const bg = coverBg(g);
  const game = "added_at" in g ? (g as Game) : null;
  const stats = game
    ? `<div class="back-stats">
        <div><span>Temps de jeu</span><b>${game.category === "launcher" ? "—" : formatPlaytime(game.playtime_minutes)}</b></div>
        <div><span>Sessions</span><b>${game.session_count}</b></div>
        <div><span>Dernière session</span><b>${esc(formatRelative(game.last_played_at))}</b></div>
        <div><span>Version</span><b>${esc(game.version || "—")}</b></div>
      </div>`
    : "";
  return `
    <div class="back-art ${bg ? "" : "gen-bg"}" ${bg ? `style="background-image:${esc(bg)}"` : ""}></div>
    <div class="back-panel">
      <p class="kick">REZ launcher</p>
      <h4>${esc(g.title)}</h4>
      <p class="desc">${game ? esc(backText(game)) : ""}</p>
      ${stats}
      <div class="back-foot"><span>PC · Windows</span><i class="barcode"></i></div>
    </div>`;
}

export function boxHtml(g: Game | CoverLike, o: BoxOptions): string {
  const d = Math.round(o.w * 0.13);
  const front = `<div class="face front">${coverHtml(g, false)}</div>`;
  return `
  <div class="box3d ${o.cls ?? ""}" style="--w:${o.w}px;--d:${d}px">
    <div class="box-rot">
      ${
        o.door
          ? `<div class="face inner"><i class="disc"></i></div><div class="door">${front}<div class="face door-in"></div></div>`
          : front
      }
      <div class="face back">${backHtml(g)}</div>
      <div class="face spine"><span class="spine-logo"></span><b>${esc(g.title)}</b><i>REZ</i></div>
      <div class="face side-r"></div>
      <div class="face top"></div>
      <div class="face bottom"></div>
    </div>
  </div>`;
}

/** Orient a `.box3d` (degrees). */
export function setRotation(box: HTMLElement, bx: number, by: number): void {
  box.style.setProperty("--bx", `${bx}deg`);
  box.style.setProperty("--by", `${by}deg`);
}

/** Drag-to-rotate on a `.box3d`, with an idle float when left alone. */
export function makeRotatable(box: HTMLElement, start = { bx: -6, by: -24 }): { set: (bx: number, by: number) => void } {
  let { bx, by } = start;
  setRotation(box, bx, by);
  let drag: { x: number; y: number; bx: number; by: number } | null = null;
  let idleTimer = 0;
  const setIdle = (on: boolean) => {
    clearTimeout(idleTimer);
    if (on) idleTimer = window.setTimeout(() => box.classList.add("idle"), 950);
    else box.classList.remove("idle");
  };
  box.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    drag = { x: e.clientX, y: e.clientY, bx, by };
    box.setPointerCapture(e.pointerId);
    box.classList.add("dragging");
    setIdle(false);
  });
  box.addEventListener("pointermove", (e) => {
    if (!drag) return;
    by = drag.by + (e.clientX - drag.x) * 0.45;
    bx = Math.max(-35, Math.min(35, drag.bx - (e.clientY - drag.y) * 0.3));
    setRotation(box, bx, by);
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    box.classList.remove("dragging");
    setIdle(true);
  };
  box.addEventListener("pointerup", end);
  box.addEventListener("pointercancel", end);
  setIdle(true);
  return {
    set: (nbx, nby) => {
      // Shortest way to the requested face.
      const turns = Math.round((by - nby) / 360);
      bx = nbx;
      by = nby + turns * 360;
      setIdle(false);
      setRotation(box, bx, by);
      setIdle(true);
    },
  };
}

export interface BoxViewerCtx {
  canPlay: (g: Game) => boolean;
  onPlay: (g: Game) => void;
  onCover: (g: Game) => void;
  onEdit: (g: Game) => void;
}

/** "Bibliothèque 3D" mode: the clicked game's box, full screen, interactive. */
export function openGameBox(g: Game, ctx: BoxViewerCtx): void {
  document.querySelector(".box-layer")?.remove();
  const bg = coverBg(g);
  const layer = document.createElement("div");
  layer.className = "layer box-layer";
  layer.innerHTML = `
    <div class="layer-bg"></div>
    ${bg ? `<div class="layer-art" style="background-image:${esc(bg)}"></div>` : ""}
    <button class="opt-toggle box-close" data-act="close" title="Fermer (Échap)">${icon.x}</button>
    <div class="box-stage">
      <div class="relative">
        ${boxHtml(g, { w: Math.min(300, Math.round(innerHeight * 0.36)) })}
        <div class="box-floor" style="top:calc(100% + 4px)"></div>
      </div>
      <div class="flex flex-col items-center gap-4">
        <div class="seg !w-auto" style="grid-template-columns:repeat(3,auto)">
          <label><input type="radio" name="face" value="front" checked/><span>Face</span></label>
          <label><input type="radio" name="face" value="spine"/><span>Tranche</span></label>
          <label><input type="radio" name="face" value="back"/><span>Dos</span></label>
        </div>
        <div class="flex gap-2">
          ${
            ctx.canPlay(g)
              ? `<button class="btn btn-primary !h-11 !px-7 text-[15px]" data-act="play"><span class="[&_svg]:h-4 [&_svg]:w-4">${icon.play}</span>Jouer</button>`
              : ""
          }
          <button class="btn btn-ghost !h-11" data-act="cover">${icon.image}Jaquette</button>
          <button class="btn btn-ghost !h-11" data-act="edit">${icon.edit}Modifier</button>
        </div>
        <p class="text-xs text-muted">Glisse la boîte pour la faire tourner · ← → pour changer de face</p>
      </div>
    </div>`;
  document.body.appendChild(layer);
  const box = layer.querySelector<HTMLElement>(".box3d")!;
  const rot = makeRotatable(box);
  const faces: Record<string, [number, number]> = { front: [-6, -24], spine: [-4, 90], back: [-6, 180] };
  const order = ["front", "spine", "back"];
  let face = "front";
  const show = (f: string) => {
    face = f;
    rot.set(...faces[f]);
    const r = layer.querySelector<HTMLInputElement>(`input[name="face"][value="${f}"]`);
    if (r) r.checked = true;
  };
  layer.querySelectorAll<HTMLInputElement>('input[name="face"]').forEach((r) =>
    r.addEventListener("change", () => show(r.value)),
  );

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    layer.classList.add("closing");
    setTimeout(() => layer.remove(), 240);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const i = order.indexOf(face) + (e.key === "ArrowRight" ? 1 : -1);
      show(order[(i + order.length) % order.length]);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener("keydown", onKey, true);
  layer.querySelector(".layer-bg")!.addEventListener("click", close);
  layer.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "close") close();
    else if (act === "play") {
      close();
      ctx.onPlay(g);
    } else if (act === "cover") {
      close();
      ctx.onCover(g);
    } else if (act === "edit") {
      close();
      ctx.onEdit(g);
    }
  });
}
