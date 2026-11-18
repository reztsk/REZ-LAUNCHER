// Small UI primitives: toasts and modals.
import { esc } from "./format";
import { icon } from "./icons";

export function toast(title: string, body = "", kind: "info" | "error" = "info", ms = 4200): void {
  const root = document.getElementById("toasts")!;
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<i class="bar"></i><div class="min-w-0"><p class="font-semibold">${esc(title)}</p>${
    body ? `<p class="mt-0.5 text-[13px] text-muted">${esc(body)}</p>` : ""
  }</div>`;
  root.appendChild(el);
  const close = () => {
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  };
  el.addEventListener("click", close);
  setTimeout(close, ms);
}

export function errorToast(err: unknown, title = "Oups"): void {
  toast(title, typeof err === "string" ? err : err instanceof Error ? err.message : String(err), "error", 6000);
}

export interface ModalHandle {
  el: HTMLElement;
  close: () => void;
}

let current: ModalHandle | null = null;

/** Open a modal with trusted HTML content. Returns a handle to wire events / close. */
export function openModal(title: string, contentHtml: string, onClose?: () => void): ModalHandle {
  current?.close();
  const root = document.getElementById("modal-root")!;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="flex items-center justify-between px-6 pt-5">
        <h2 class="font-display text-lg font-bold tracking-tight">${esc(title)}</h2>
        <button class="opt-toggle" data-close title="Fermer">${icon.x}</button>
      </div>
      <div class="px-6 pb-6 pt-4">${contentHtml}</div>
    </div>`;
  root.appendChild(backdrop);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") handle.close();
  };
  const handle: ModalHandle = {
    el: backdrop,
    close: () => {
      if (current === handle) current = null;
      document.removeEventListener("keydown", onKey);
      backdrop.classList.add("closing");
      setTimeout(() => backdrop.remove(), 190);
      onClose?.();
    },
  };
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) handle.close();
  });
  backdrop.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => handle.close()));
  document.addEventListener("keydown", onKey);
  current = handle;
  requestAnimationFrame(() => backdrop.querySelector<HTMLElement>("[autofocus]")?.focus());
  return handle;
}

export function confirmModal(title: string, message: string, confirmLabel: string, danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal(
      title,
      `<p class="text-sm leading-relaxed text-muted">${message}</p>
       <div class="mt-6 flex justify-end gap-2">
         <button class="btn btn-ghost" data-close>Annuler</button>
         <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-ok autofocus>${esc(confirmLabel)}</button>
       </div>`,
      () => {
        if (!answered) resolve(false);
      },
    );
    m.el.querySelector("[data-ok]")!.addEventListener("click", () => {
      answered = true;
      resolve(true);
      m.close();
    });
  });
}
