// Auto-update: signed releases published on GitHub (see .github/workflows/release.yml).
import { api, events } from "./api";
import type { UpdateInfo } from "./api";
import { esc, formatBytes } from "./format";
import { icon } from "./icons";
import { errorToast, openModal, toast, whenNoModal } from "./ui";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate"; at: number }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "error"; message: string };

let status: UpdateStatus = { kind: "idle" };
const listeners = new Set<(s: UpdateStatus) => void>();

export const updateStatus = (): UpdateStatus => status;
export function onUpdateStatus(cb: (s: UpdateStatus) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function set(s: UpdateStatus): void {
  status = s;
  listeners.forEach((cb) => cb(s));
}

/** Check GitHub Releases. `silent`: no toast when up to date or offline. */
export async function checkForUpdates(silent: boolean): Promise<void> {
  if (status.kind === "checking") return;
  set({ kind: "checking" });
  try {
    const info = await api.checkUpdate();
    if (info) {
      set({ kind: "available", info });
      if (silent) whenNoModal(() => showUpdateModal(info));
      else showUpdateModal(info);
    } else {
      set({ kind: "uptodate", at: Date.now() });
      if (!silent) toast("REZ launcher est à jour", `Version ${__APP_VERSION__}`);
    }
  } catch (err) {
    const message = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
    set({ kind: "error", message });
    if (!silent) errorToast(err, "Vérification impossible");
  }
}

export function showUpdateModal(info: UpdateInfo): void {
  const notes = info.notes.trim();
  const m = openModal(
    "Mise à jour disponible",
    `<div class="flex items-center gap-4">
       <div class="icon-tile h-14 w-14 shrink-0 [&_.icon]:h-7 [&_.icon]:w-7">${icon.sparkles}</div>
       <div>
         <p class="kicker">Nouvelle version</p>
         <p class="mt-1 font-display text-2xl font-bold tracking-tight">v${esc(info.current_version)} <span class="text-muted">→</span> <span class="text-grad">v${esc(info.version)}</span></p>
       </div>
     </div>
     ${
       notes
         ? `<div class="mt-5 max-h-56 overflow-auto whitespace-pre-wrap rounded-xl border border-white/5 bg-black/30 p-4 text-[13px] leading-relaxed text-muted">${esc(notes)}</div>`
         : ""
     }
     <div data-progress-box class="mt-5 hidden">
       <div class="progress"><i data-bar style="width:0%"></i></div>
       <p data-progress-text class="mt-2 text-xs text-muted tabular-nums">Téléchargement…</p>
     </div>
     <p class="mt-4 text-xs leading-relaxed text-muted">Le paquet est vérifié (signature) puis installé automatiquement. REZ launcher redémarre tout seul ; ta bibliothèque et ton temps de jeu sont conservés.</p>
     <div class="mt-5 flex justify-end gap-2 border-t border-white/5 pt-4">
       <button class="btn btn-ghost" data-close>Plus tard</button>
       <button class="btn btn-primary" data-install>${icon.download}Installer</button>
     </div>`,
  );

  const btn = m.el.querySelector<HTMLButtonElement>("[data-install]")!;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    m.el.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((b) => (b.disabled = true));
    const box = m.el.querySelector<HTMLElement>("[data-progress-box]")!;
    const bar = m.el.querySelector<HTMLElement>("[data-bar]")!;
    const text = m.el.querySelector<HTMLElement>("[data-progress-text]")!;
    box.classList.remove("hidden");
    const unlisten = await events.onUpdateProgress(({ downloaded, total }) => {
      const pct = total ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
      bar.style.width = `${pct ?? 50}%`;
      text.textContent =
        pct === 100
          ? "Installation… REZ launcher va redémarrer."
          : `Téléchargement… ${formatBytes(downloaded)}${total ? ` / ${formatBytes(total)} (${pct} %)` : ""}`;
    });
    try {
      await api.installUpdate();
    } catch (err) {
      unlisten();
      btn.disabled = false;
      m.el.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((b) => (b.disabled = false));
      box.classList.add("hidden");
      errorToast(err, "Mise à jour impossible");
    }
  });
}
