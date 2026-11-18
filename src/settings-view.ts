// "Paramètres" tab.
import { api } from "./api";
import type { CardSize, LibraryView, Settings, StartView, ThemeId } from "./api";
import { esc, formatBytes, formatRelative } from "./format";
import { icon } from "./icons";
import { THEMES } from "./themes";
import { confirmModal, errorToast, toast } from "./ui";
import { checkForUpdates, onUpdateStatus, showUpdateModal, updateStatus } from "./updates";
import type { UpdateStatus } from "./updates";

export interface SettingsCtx {
  get: () => Settings;
  /** Persist a change (optimistic: UI already reflects it). */
  save: (patch: Partial<Settings>) => Promise<void>;
  scanNow: () => Promise<void>;
  /** Re-save UI conveniences wiped by a web-cache clear. */
  afterCacheClear: () => void;
}

const sw = (key: keyof Settings, on: boolean, label: string) =>
  `<button class="switch" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-switch="${key}"></button>`;

const row = (title: string, desc: string, control: string) => `
  <div class="set-row">
    <div><p class="t">${title}</p>${desc ? `<p class="d">${desc}</p>` : ""}</div>
    <div class="flex shrink-0 items-center gap-2">${control}</div>
  </div>`;

function updateLine(s: UpdateStatus): string {
  switch (s.kind) {
    case "checking":
      return `<span class="flex items-center gap-2"><span class="animate-spin [&_.icon]:h-4 [&_.icon]:w-4">${icon.refresh}</span>Vérification…</span>`;
    case "uptodate":
      return `Tu as la dernière version · vérifié ${formatRelative(new Date(s.at).toISOString()).toLowerCase()}`;
    case "available":
      return `<b class="text-white">v${esc(s.info.version)} disponible</b>`;
    case "error":
      return `Vérification impossible : ${esc(s.message)}`;
    default:
      return "Les mises à jour sont publiées sur GitHub Releases.";
  }
}

let unsub: (() => void) | null = null;

export function renderSettings(view: HTMLElement, ctx: SettingsCtx): void {
  const s = ctx.get();
  const seg = <T extends string>(name: string, value: T, opts: [T, string][]) =>
    `<div class="seg !w-auto" style="grid-template-columns:repeat(${opts.length},auto)">${opts
      .map(
        ([v, l]) =>
          `<label><input type="radio" name="${name}" value="${v}" ${v === value ? "checked" : ""}/><span>${l}</span></label>`,
      )
      .join("")}</div>`;

  const paths = s.search_paths.length
    ? s.search_paths
        .map(
          (p, i) =>
            `<div class="path-chip"><span class="text-muted [&_.icon]:h-4 [&_.icon]:w-4">${icon.folder}</span><span class="min-w-0 flex-1 truncate" title="${esc(p)}">${esc(p)}</span><button class="opt-toggle !h-7 !w-7" data-remove-path="${i}" title="Retirer">${icon.x}</button></div>`,
        )
        .join("")
    : `<p class="text-xs text-muted">Aucun dossier : seuls Steam, Epic Games et GOG sont analysés.</p>`;

  view.innerHTML = `
    <div class="mx-auto max-w-[920px] px-10 pb-16 pt-8">
      <header>
        <h1 class="font-display text-[34px] font-bold tracking-tight">Paramètres</h1>
        <p class="mt-1 text-sm text-muted">Apparence, lancement des jeux, mises à jour, détection et démarrage.</p>
      </header>

      <div class="mt-7 flex flex-col gap-4">
        <section class="set-card glass" style="--i:0">
          <h2 class="set-head">${icon.palette}Apparence</h2>
          <div class="set-row !block">
            <p class="t">Thème</p>
            <p class="d">Duo de couleurs des accents : boutons, onglets, barres de progression, halos.</p>
            <div class="theme-grid mt-3">${THEMES.map(
              (t) => `<button class="theme-sw" data-theme-pick="${t.id}" aria-pressed="${s.theme === t.id}" style="--sw:${t.stops[1]}" title="${esc(t.hint)}">
                  <i style="background:linear-gradient(135deg, ${t.stops[0]}, ${t.stops[1]} 50%, ${t.stops[2]})"></i>
                  <span><b>${esc(t.name)}</b><small>${esc(t.hint)}</small></span>
                </button>`,
            ).join("")}</div>
          </div>
          ${row(
            "Affichage de la bibliothèque",
            "Grille classique, grille avec boîte 3D au clic, ou carrousel 3D de boîtes.",
            seg<LibraryView>("library_view", s.library_view, [["grid", "Grille"], ["box3d", "Boîte 3D"], ["carousel", "Carrousel 3D"]]),
          )}
          ${row("Effet verre Apple", "Verre givré, reflets et bordures lumineuses sur la barre latérale et les catégories.", sw("glass", s.glass, "Effet verre"))}
          ${row("Taille des jaquettes", "", seg<CardSize>("card_size", s.card_size, [["compact", "Compacte"], ["normal", "Normale"], ["large", "Grande"]]))}
          ${row("Animations", "Transitions et apparitions fluides de l'interface.", sw("animations", s.animations, "Animations"))}
          ${row("Effet 3D des jaquettes", "Inclinaison et reflet qui suivent la souris.", sw("tilt", s.tilt, "Effet 3D"))}
          ${row("Fond animé", "Halo acier et grille en arrière-plan.", sw("ambient", s.ambient, "Fond animé"))}
        </section>

        <section class="set-card glass" style="--i:1">
          <h2 class="set-head">${icon.rocket}Lancement des jeux</h2>
          ${row("Animation de lancement", "La boîte s'ouvre et une barre de chargement suit le démarrage du jeu jusqu'à l'apparition de sa fenêtre.", sw("launch_animation", s.launch_animation, "Animation de lancement"))}
          ${row("Réduire REZ launcher pendant le jeu", "La fenêtre passe dans la barre des tâches dès que le jeu est affiché, et les animations s'arrêtent.", sw("minimize_on_launch", s.minimize_on_launch, "Réduire pendant le jeu"))}
          ${row("Réafficher à la fermeture du jeu", "REZ launcher revient au premier plan avec le temps de la session.", sw("restore_on_exit", s.restore_on_exit, "Réafficher à la fermeture"))}
        </section>

        <section class="set-card glass" style="--i:2">
          <h2 class="set-head">${icon.sparkles}Mises à jour</h2>
          ${row(
            `REZ launcher <span class="text-muted">v${esc(__APP_VERSION__)}</span>`,
            `<span data-update-line>${updateLine(updateStatus())}</span>`,
            `<button class="btn btn-ghost btn-sm" data-act="check-update">${icon.refresh}Vérifier</button>`,
          )}
          ${row("Vérifier au lancement", "Une pop-up te propose la nouvelle version dès qu'elle sort.", sw("check_updates_on_start", s.check_updates_on_start, "Vérifier au lancement"))}
        </section>

        <section class="set-card glass" style="--i:3">
          <h2 class="set-head">${icon.radar}Détection des jeux</h2>
          ${row(
            "Détecter les nouveaux jeux installés",
            "Analyse en lecture seule (toutes les 90 s) des manifestes Steam, Epic Games, GOG et des dossiers ci-dessous. Rien n'est jamais écrit dans les dossiers de jeux.",
            sw("detect_new_games", s.detect_new_games, "Détecter les nouveaux jeux"),
          )}
          <div class="set-row !block">
            <div class="flex items-center justify-between gap-3">
              <div><p class="t">Dossiers de recherche</p><p class="d">Un sous-dossier = un jeu (ex : <code>D:\\Jeux\\MonJeu</code>).</p></div>
              <button class="btn btn-ghost btn-sm" data-act="add-path">${icon.folderPlus}Ajouter un dossier</button>
            </div>
            <div class="mt-3 flex flex-col gap-2">${paths}</div>
          </div>
          ${row(
            "Analyser maintenant",
            "Liste tous les jeux installés qui ne sont pas encore dans ta bibliothèque.",
            `<button class="btn btn-ghost btn-sm" data-act="reset-ignored" title="Les jeux refusés seront à nouveau proposés">Réinitialiser les ignorés</button><button class="btn btn-primary btn-sm" data-act="scan">${icon.radar}Scanner</button>`,
          )}
        </section>

        <section class="set-card glass" style="--i:4">
          <h2 class="set-head">${icon.power}Démarrage</h2>
          ${row("Lancer REZ launcher avec Windows", "Ajoute REZ launcher aux applications de démarrage de ta session.", sw("launch_at_startup", s.launch_at_startup, "Lancer avec Windows"))}
          ${row("Onglet d'ouverture", "", seg<StartView>("start_view", s.start_view, [["library", "Bibliothèque"], ["launchers", "Launchers"]]))}
        </section>

        <section class="set-card glass" style="--i:5">
          <h2 class="set-head">${icon.database}Données & cache</h2>
          ${row(
            "Vider le cache",
            "Supprime les jaquettes inutilisées et le cache web des images. Ta bibliothèque et ton temps de jeu sont conservés.",
            `<button class="btn btn-ghost btn-sm" data-act="clear-cache">${icon.trash}Vider</button>`,
          )}
          ${row("Dossier des données", "Base SQLite locale (bibliothèque, sessions) et jaquettes.", `<button class="btn btn-ghost btn-sm" data-act="open-data">${icon.folder}Ouvrir</button>`)}
        </section>

        <section class="set-card glass" style="--i:6">
          <h2 class="set-head">${icon.shield}Zéro risque de ban</h2>
          <p class="pb-4 text-sm leading-relaxed text-muted">REZ launcher lance tes jeux comme un raccourci Windows et chronomètre leur processus. Il n'injecte rien, ne lit ni n'écrit la mémoire d'un jeu, et ne modifie aucun fichier de jeu, de dossier d'installation ou de launcher.</p>
          ${row("Code source", "Open source, licence MIT.", `<button class="btn btn-ghost btn-sm" data-act="repo">${icon.github}GitHub</button>`)}
        </section>
      </div>
    </div>`;

  // Switches
  view.querySelectorAll<HTMLElement>("[data-switch]").forEach((b) =>
    b.addEventListener("click", async () => {
      const key = b.dataset.switch as keyof Settings;
      const on = b.getAttribute("aria-checked") !== "true";
      b.setAttribute("aria-checked", String(on));
      try {
        await ctx.save({ [key]: on } as Partial<Settings>);
      } catch (err) {
        b.setAttribute("aria-checked", String(!on));
        errorToast(err);
      }
    }),
  );
  // Segmented controls
  view.querySelectorAll<HTMLInputElement>('.seg input[type="radio"]').forEach((r) =>
    r.addEventListener("change", () => void ctx.save({ [r.name]: r.value } as Partial<Settings>).catch(errorToast)),
  );
  // Theme picker (applied instantly)
  view.querySelectorAll<HTMLElement>("[data-theme-pick]").forEach((b) =>
    b.addEventListener("click", async () => {
      const prev = ctx.get().theme;
      const theme = b.dataset.themePick as ThemeId;
      if (theme === prev) return;
      const mark = (id: ThemeId) =>
        view.querySelectorAll<HTMLElement>("[data-theme-pick]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.themePick === id)));
      mark(theme);
      try {
        await ctx.save({ theme });
      } catch (err) {
        mark(prev);
        errorToast(err);
      }
    }),
  );
  // Remove a search folder
  view.querySelectorAll<HTMLElement>("[data-remove-path]").forEach((b) =>
    b.addEventListener("click", async () => {
      const i = Number(b.dataset.removePath);
      try {
        await ctx.save({ search_paths: ctx.get().search_paths.filter((_, j) => j !== i) });
        renderSettings(view, ctx);
      } catch (err) {
        errorToast(err);
      }
    }),
  );

  view.firstElementChild!.addEventListener("click", onAction);
  async function onAction(e: Event): Promise<void> {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]");
    if (!b) return;
    try {
      switch (b.dataset.act) {
        case "check-update": {
          const st = updateStatus();
          if (st.kind === "available") showUpdateModal(st.info);
          else await checkForUpdates(false);
          break;
        }
        case "add-path": {
          const p = await api.pickFolder();
          if (!p) return;
          await ctx.save({ search_paths: [...ctx.get().search_paths, p] });
          renderSettings(view, ctx);
          toast("Dossier ajouté", p);
          break;
        }
        case "scan":
          b.disabled = true;
          await ctx.scanNow();
          b.disabled = false;
          break;
        case "reset-ignored": {
          const n = await api.resetIgnoredDetections();
          toast(n ? `${n} jeu${n > 1 ? "x" : ""} à nouveau proposé${n > 1 ? "s" : ""}` : "Aucun jeu ignoré", "Lance un scan pour les revoir.");
          break;
        }
        case "clear-cache": {
          const ok = await confirmModal(
            "Vider le cache ?",
            "Les jaquettes qui ne sont plus utilisées et le cache web des images seront supprimés. <b class='text-white'>Ta bibliothèque et ton temps de jeu ne sont pas touchés.</b>",
            "Vider le cache",
            false,
          );
          if (!ok) return;
          const r = await api.clearCache();
          ctx.afterCacheClear();
          toast("Cache vidé", r.files_removed ? `${r.files_removed} fichier(s) · ${formatBytes(r.bytes_freed)} libérés` : "Cache web nettoyé.");
          break;
        }
        case "open-data":
          await api.openDataDir();
          break;
        case "repo":
          await api.openRepo();
          break;
      }
    } catch (err) {
      b.disabled = false;
      errorToast(err);
    }
  }

  unsub?.();
  unsub = onUpdateStatus((st) => {
    const el = view.querySelector("[data-update-line]");
    if (el) el.innerHTML = updateLine(st);
  });
}
