// "New game detected" pop-up. Adding a game only creates a library entry
// (an internal shortcut): no game or launcher file is ever touched.
import { api } from "./api";
import type { Detected, Game } from "./api";
import { esc } from "./format";
import { icon } from "./icons";
import { launcherLogo } from "./launcher-logos";
import { errorToast, openModal, toast, whenNoModal } from "./ui";

const SOURCE_LABEL: Record<Detected["source"], string> = {
  steam: "Steam",
  epic: "Epic Games",
  gog: "GOG",
  folder: "Dossier",
};

let open = false;
let queued = false;

export interface DetectionCtx {
  onAdded: (games: Game[]) => void;
}

/** Show the pop-up. If one is already open, the new games are shown right after. */
export function showDetections(list: Detected[], ctx: DetectionCtx): void {
  if (list.length === 0) return;
  if (open) {
    queued = true;
    return;
  }
  open = true;
  whenNoModal(() => render(list, ctx));
}

function showQueued(ctx: DetectionCtx): void {
  if (!queued) return;
  queued = false;
  void api.pendingDetections().then((l) => showDetections(l, ctx), () => {});
}

function render(list: Detected[], ctx: DetectionCtx): void {
  const single = list.length === 1;
  let answered = false;
  const keys = list.map((d) => d.key);

  const rows = list
    .map((d) => {
      const logo = d.source === "folder" ? icon.folder : launcherLogo(d.source, "h-[18px] w-[18px]");
      return `
      <label class="det-row">
        <input type="checkbox" class="check" data-key="${esc(d.key)}" checked ${single ? "hidden" : ""} />
        <div class="min-w-0">
          <p class="truncate text-sm font-semibold">${esc(d.title)}${d.kind === "software" ? ` <span class="badge ml-1 align-middle" title="Rangé dans l’onglet « Logiciels »">Logiciel</span>` : ""}</p>
          <p class="truncate text-xs text-muted" title="${esc(d.executable_path)}">${esc(d.executable_path)}</p>
        </div>
        <span class="badge shrink-0 !normal-case !tracking-normal">${logo}${SOURCE_LABEL[d.source]}</span>
      </label>`;
    })
    .join("");

  const modal = openModal(
    single ? "Nouveau jeu détecté" : `${list.length} jeux détectés`,
    `<div class="flex items-start gap-4">
       <div class="icon-tile h-12 w-12 shrink-0">${icon.radar}</div>
       <p class="pt-1 text-[15px] leading-relaxed">${
         single
           ? `<b>${esc(list[0].title)}</b> vient d'être repéré sur ton PC.<br/>Veux-tu l'ajouter à la bibliothèque REZ launcher ?`
           : "Ces jeux sont installés sur ton PC.<br/>Veux-tu les ajouter à la bibliothèque REZ launcher ?"
       }</p>
     </div>
     <div class="det-list mt-5">${rows}</div>
     <p class="mt-4 flex items-start gap-2 text-xs leading-relaxed text-muted"><span class="mt-px [&_.icon]:h-4 [&_.icon]:w-4">${icon.shield}</span>REZ launcher crée seulement un raccourci interne. Aucun fichier du jeu, de son dossier ou de son launcher n'est modifié.</p>
     <div class="mt-5 flex items-center gap-2 border-t border-white/5 pt-4">
       ${
         single
           ? `<button class="btn btn-ghost" data-do="ignore">Non merci</button>`
           : `<button class="btn btn-ghost btn-sm !text-muted" data-do="ignore-all" title="Ne plus proposer ces jeux">Ne plus proposer</button>`
       }
       <span class="flex-1"></span>
       ${single ? "" : `<button class="btn btn-ghost" data-do="later">Plus tard</button>`}
       <button class="btn btn-primary" data-do="add">${icon.plus}<span data-add-label>${single ? "Oui, ajouter" : "Ajouter"}</span></button>
     </div>`,
    () => {
      open = false;
      if (answered) showQueued(ctx);
      else void api.resolveDetections(keys, "later").then(() => showQueued(ctx), () => {});
    },
    { wide: !single },
  );

  const boxes = () => [...modal.el.querySelectorAll<HTMLInputElement>("input[data-key]")];
  const addBtn = modal.el.querySelector<HTMLButtonElement>('[data-do="add"]')!;
  const refresh = () => {
    const n = boxes().filter((b) => b.checked).length;
    if (!single) modal.el.querySelector("[data-add-label]")!.textContent = `Ajouter (${n})`;
    addBtn.disabled = n === 0;
  };
  modal.el.querySelector(".det-list")!.addEventListener("change", refresh);
  refresh();

  const finish = () => {
    answered = true;
    modal.close();
  };

  modal.el.querySelectorAll<HTMLElement>("[data-do]").forEach((b) =>
    b.addEventListener("click", async () => {
      const checked = boxes().filter((x) => x.checked).map((x) => x.dataset.key!);
      const unchecked = keys.filter((k) => !checked.includes(k));
      try {
        switch (b.dataset.do) {
          case "add": {
            addBtn.disabled = true;
            const games = await api.resolveDetections(checked, "add");
            if (unchecked.length) await api.resolveDetections(unchecked, "later");
            finish();
            ctx.onAdded(games);
            toast(
              games.length === 1 ? `${games[0].title} ajouté` : `${games.length} jeux ajoutés`,
              "Raccourci créé dans ta bibliothèque. Le temps de jeu sera compté à chaque lancement.",
            );
            break;
          }
          case "ignore":
          case "ignore-all":
            await api.resolveDetections(keys, "ignore");
            finish();
            toast("C'est noté", "Ce jeu ne sera plus proposé (réactivable dans Paramètres).");
            break;
          case "later":
            await api.resolveDetections(keys, "later");
            finish();
            break;
        }
      } catch (err) {
        addBtn.disabled = false;
        errorToast(err);
      }
    }),
  );
}
