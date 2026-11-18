// Launch sequence: full-screen box that opens, elegant loading bar while the
// game process starts, then hand-over once its first window shows up (the
// backend minimizes REZ launcher at that moment).
import type { Game } from "./api";
import { boxHtml } from "./box3d";
import { coverBg } from "./covers";
import { esc } from "./format";
import { icon } from "./icons";

export interface LaunchHandle {
  /** Process spawned: now waiting for its window. */
  started: () => void;
  /** Game window detected (or timeout): finish and fade out. */
  ready: () => void;
  /** Launch failed / game exited before showing up. */
  close: () => void;
}

const STEPS = ["Ouverture de la boîte…", "Démarrage du processus…", "En attente de la fenêtre du jeu…", "C'est parti, bon jeu !"];

/** Progress target for each step (the bar eases toward it, never stalls at 100 %). */
const CAPS = [0.18, 0.4, 0.93, 1];

export function showLaunch(g: Game): LaunchHandle {
  document.querySelector(".launch-layer")?.remove();
  const bg = coverBg(g);
  const layer = document.createElement("div");
  layer.className = "layer launch-layer";
  layer.innerHTML = `
    <div class="layer-bg !bg-black/85"></div>
    ${bg ? `<div class="layer-art" style="background-image:${esc(bg)}"></div>` : ""}
    <div class="launch-stage">
      <i class="launch-beam"></i>
      ${boxHtml(g, { w: Math.min(250, Math.round(innerHeight * 0.3)), door: true })}
      <div class="w-full">
        <div class="flex items-end justify-between gap-4">
          <div class="min-w-0">
            <p class="kicker">Lancement</p>
            <h2 class="mt-1 truncate font-display text-2xl font-bold tracking-tight">${esc(g.title)}</h2>
          </div>
          <b class="font-display text-2xl tabular-nums text-grad" data-pct>0 %</b>
        </div>
        <div class="launch-bar mt-4"><i data-bar></i></div>
        <div class="mt-3 flex items-center justify-between text-xs text-muted">
          <span data-step>${STEPS[0]}</span>
          <button class="flex items-center gap-1.5 transition hover:text-white" data-hide title="Masquer l'animation (le jeu continue)">${icon.minimize}Masquer</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(layer);

  const box = layer.querySelector<HTMLElement>(".box3d")!;
  const bar = layer.querySelector<HTMLElement>("[data-bar]")!;
  const pct = layer.querySelector<HTMLElement>("[data-pct]")!;
  const stepEl = layer.querySelector<HTMLElement>("[data-step]")!;
  box.style.setProperty("--by", "-18deg");
  box.style.setProperty("--bx", "-5deg");

  let step = 0;
  let p = 0;
  let raf = 0;
  let closed = false;
  const setStep = (s: number) => {
    if (s <= step && s !== 0) return;
    step = s;
    stepEl.textContent = STEPS[s];
  };
  const frame = () => {
    const cap = CAPS[step];
    p += (cap - p) * (step === 3 ? 0.18 : 0.035);
    if (step === 3 && cap - p < 0.002) p = 1;
    bar.style.width = `${(p * 100).toFixed(2)}%`;
    pct.textContent = `${Math.floor(p * 100)} %`;
    if (!closed && p < 1) raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  // The case swings open, then the process is started.
  const openT = setTimeout(() => {
    layer.classList.add("open");
    box.classList.add("open");
    box.style.setProperty("--by", "-8deg");
    setStep(1);
  }, 650);

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(openT);
    cancelAnimationFrame(raf);
    document.removeEventListener("keydown", onKey, true);
    layer.classList.add("closing");
    setTimeout(() => layer.remove(), 260);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  document.addEventListener("keydown", onKey, true);
  layer.querySelector("[data-hide]")!.addEventListener("click", close);

  return {
    started: () => setStep(2),
    ready: () => {
      if (closed) return;
      layer.classList.add("open");
      box.classList.add("open");
      setStep(3);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
      layer.classList.add("done");
      setTimeout(close, 1300);
    },
    close,
  };
}
