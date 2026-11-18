// Per-launcher "tidy PC" guide as an interactive step-by-step carousel.
import { api } from "./api";
import type { LauncherInfo } from "./api";
import { esc } from "./format";
import { guideFor } from "./guides";
import { icon } from "./icons";
import { launcherLogo } from "./launcher-logos";
import { errorToast, openModal, toast } from "./ui";

export interface GuideCtx {
  drive: string;
  done: number[];
  /** Persist the list of completed step indices. */
  onProgress: (done: number[]) => void;
  /** Re-run launcher detection (last step). */
  onRescan: () => void;
}

const check = (cls = "h-5 w-5") => icon.check.replace('class="icon"', `class="${cls}"`);

function treeFor(l: LauncherInfo, drive: string): string {
  const d = drive.replace(/[\\/]+$/, "");
  const lib = l.id === "steam" ? "steamapps\\common\\…" : "Games\\…";
  return `<b>${esc(d)}\\</b>
└─ <b>Jeux\\</b>
   └─ <b>${esc(l.recommended_folder)}\\</b>   <em>← ${esc(l.name)}</em>
      └─ <b>${esc(lib)}</b>   <em>← tes jeux</em>`;
}

export function openGuide(l: LauncherInfo, ctx: GuideCtx): void {
  const steps = guideFor(l.id, l.name, l.recommended_folder, ctx.drive);
  const done = new Set(ctx.done.filter((i) => i < steps.length));
  const total = steps.length + 1; // intro + steps
  const firstTodo = steps.findIndex((_, i) => !done.has(i));
  let cur = done.size === 0 ? 0 : firstTodo < 0 ? steps.length : firstTodo + 1;

  const intro = `
    <div class="slide" data-slide="0">
      <div class="flex items-center gap-4">
        <div class="launcher-logo lg">${launcherLogo(l.id)}</div>
        <div>
          <p class="kicker">Objectif</p>
          <h3 class="mt-1 font-display text-xl font-bold">Ranger ${esc(l.name)} proprement</h3>
        </div>
      </div>
      <p class="mt-4 text-sm leading-relaxed text-muted">En ${steps.length} étapes, ${esc(l.name)} et tous ses jeux atterrissent dans un seul dossier, sur le disque de ton choix. Rien n'est déplacé automatiquement : REZ launcher te guide, c'est toi qui installes.</p>
      <div class="tree mt-4 rounded-xl border border-white/5 bg-black/30 p-4">${treeFor(l, ctx.drive)}</div>
    </div>`;

  const slides = steps
    .map((s, i) => {
      let action = "";
      if (s.action?.kind === "create_folder")
        action = `<button class="btn btn-ghost btn-sm" data-act="mkdir" data-path="${esc(s.action.path)}">${icon.folderPlus}Créer <code>${esc(s.action.path)}</code></button>`;
      else if (s.action?.kind === "download")
        action = `<button class="btn btn-ghost btn-sm" data-act="download">${icon.external}Ouvrir le site officiel</button>`;
      else if (s.action?.kind === "rescan")
        action = `<button class="btn btn-ghost btn-sm" data-act="rescan">${icon.refresh}Relancer la détection</button>`;
      return `
      <div class="slide ${done.has(i) ? "done" : ""}" data-slide="${i + 1}">
        <div class="flex items-start gap-4">
          <span class="slide-num">${done.has(i) ? check() : i + 1}</span>
          <div class="min-w-0 flex-1">
            <p class="kicker">Étape ${i + 1} / ${steps.length}</p>
            <h3 class="mt-1 font-display text-lg font-bold leading-snug">${s.title}</h3>
          </div>
        </div>
        <p class="mt-4 text-sm leading-relaxed text-muted">${s.body}</p>
        <div class="mt-5 flex flex-wrap items-center gap-2">
          ${action}
          <button class="btn btn-sm ${done.has(i) ? "btn-primary" : "btn-ghost"} ml-auto" data-act="toggle" data-step="${i}" aria-pressed="${done.has(i)}">${check("icon")}<span>${done.has(i) ? "Fait" : "Marquer comme fait"}</span></button>
        </div>
      </div>`;
    })
    .join("");

  const m = openModal(
    `Guide ${l.name}`,
    `<div class="flex items-center gap-3">
       <div class="progress flex-1"><i data-progress></i></div>
       <span class="text-xs text-muted tabular-nums" data-count></span>
     </div>
     <div class="carousel mt-4"><div class="slides">${intro}${slides}</div></div>
     <div class="mt-5 flex items-center justify-between gap-3">
       <button class="btn btn-ghost" data-nav="prev">${icon.arrowLeft}Précédent</button>
       <div class="dots">${Array.from({ length: total }, (_, i) => `<button data-dot="${i}" aria-label="Étape ${i}"></button>`).join("")}</div>
       <button class="btn btn-primary" data-nav="next"></button>
     </div>`,
    () => document.removeEventListener("keydown", onKey),
    { wide: true },
  );

  const el = m.el;
  const track = el.querySelector<HTMLElement>(".slides")!;
  const prev = el.querySelector<HTMLButtonElement>('[data-nav="prev"]')!;
  const next = el.querySelector<HTMLButtonElement>('[data-nav="next"]')!;

  const paint = () => {
    track.style.transform = `translateX(-${cur * 100}%)`;
    el.querySelectorAll<HTMLElement>("[data-dot]").forEach((d) => {
      const i = Number(d.dataset.dot);
      d.toggleAttribute("aria-current", false);
      if (i === cur) d.setAttribute("aria-current", "step");
      d.classList.toggle("done", i > 0 && done.has(i - 1));
    });
    prev.disabled = cur === 0;
    next.innerHTML = cur === 0 ? `Commencer${icon.arrowRight}` : cur === total - 1 ? `${check("icon")}Terminer` : `Suivant${icon.arrowRight}`;
    el.querySelector<HTMLElement>("[data-progress]")!.style.width = `${(done.size / steps.length) * 100}%`;
    el.querySelector<HTMLElement>("[data-count]")!.textContent = `${done.size}/${steps.length} étapes`;
  };

  const setDone = (i: number, on: boolean) => {
    if (on) done.add(i);
    else done.delete(i);
    ctx.onProgress([...done].sort((a, b) => a - b));
    const slide = el.querySelector<HTMLElement>(`[data-slide="${i + 1}"]`)!;
    slide.classList.toggle("done", on);
    slide.querySelector(".slide-num")!.innerHTML = on ? check() : String(i + 1);
    const t = slide.querySelector<HTMLElement>('[data-act="toggle"]')!;
    t.classList.toggle("btn-primary", on);
    t.classList.toggle("btn-ghost", !on);
    t.setAttribute("aria-pressed", String(on));
    t.querySelector("span")!.textContent = on ? "Fait" : "Marquer comme fait";
    paint();
  };

  const go = (i: number) => {
    cur = Math.max(0, Math.min(total - 1, i));
    paint();
  };

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowRight") go(cur + 1);
    else if (e.key === "ArrowLeft") go(cur - 1);
  }
  document.addEventListener("keydown", onKey);

  prev.addEventListener("click", () => go(cur - 1));
  next.addEventListener("click", () => (cur === total - 1 ? m.close() : go(cur + 1)));
  el.querySelectorAll<HTMLElement>("[data-dot]").forEach((d) => d.addEventListener("click", () => go(Number(d.dataset.dot))));

  el.querySelector(".slides")!.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!btn) return;
    const slideIdx = Number(btn.closest<HTMLElement>("[data-slide]")!.dataset.slide) - 1;
    switch (btn.dataset.act) {
      case "toggle":
        return setDone(slideIdx, !done.has(slideIdx));
      case "mkdir":
        try {
          const p = await api.createFolder(btn.dataset.path!);
          setDone(slideIdx, true);
          toast("Dossier prêt", p);
        } catch (err) {
          errorToast(err, "Création impossible");
        }
        return;
      case "download":
        try {
          await api.openLauncherDownload(l.id);
          setDone(slideIdx, true);
          toast(`Page officielle de ${l.name} ouverte`, "Dans ton navigateur par défaut.");
        } catch (err) {
          errorToast(err);
        }
        return;
      case "rescan":
        setDone(slideIdx, true);
        m.close();
        ctx.onRescan();
        return;
    }
  });

  paint();
}

