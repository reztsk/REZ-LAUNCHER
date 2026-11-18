// Image editor: import an image, then pan / zoom / centre it inside its frame
// (3:4 game cover, round profile picture or 3:1 profile banner).
// The framing is stored as (zoom, focal x %, focal y %); the image file itself is
// never modified.
import { coverSrc } from "./api";
import { boxHtml, makeRotatable } from "./box3d";
import { coverHtml, type CoverLike } from "./covers";
import { esc } from "./format";
import { framingVars, panFactor } from "./fx-math";
import { icon } from "./icons";
import { errorToast } from "./ui";

export interface CoverEditorOpts {
  /** Native picker; returns the stored path of the imported image, or null. */
  pickImage: () => Promise<string | null>;
  /** Frame shape (default: game cover). */
  shape?: "cover" | "avatar" | "banner";
  heading?: string;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function openCoverEditor(initial: CoverLike, opts: CoverEditorOpts): Promise<CoverLike | null> {
  return new Promise((resolve) => {
    const d: CoverLike = { ...initial };
    const shape = opts.shape ?? "cover";
    const isCover = shape === "cover";
    const layer = document.createElement("div");
    layer.className = "layer ce-layer";
    layer.style.zIndex = "85";
    layer.innerHTML = `
      <div class="layer-bg"></div>
      <div class="ce shape-${shape}" role="dialog" aria-modal="true" aria-label="${esc(opts.heading ?? "Personnaliser la jaquette")}">
        <div class="flex items-center justify-between px-6 pt-5">
          <div>
            <h2 class="font-display text-lg font-bold tracking-tight">${esc(opts.heading ?? "Personnaliser la jaquette")}</h2>
            <p class="text-xs text-muted">${esc(initial.title)}</p>
          </div>
          <button class="opt-toggle" data-act="cancel" title="Fermer">${icon.x}</button>
        </div>
        <div class="ce-body">
          <div>
            <div class="ce-frame shape-${shape}" data-frame></div>
            <p class="mt-2.5 text-center text-[11.5px] text-muted">Glisse pour déplacer · molette pour zoomer · double-clic pour centrer</p>
          </div>
          <div class="flex min-w-0 flex-col gap-4">
            <div>
              <span class="label">Image</span>
              <div class="flex gap-2">
                <button class="btn btn-ghost shrink-0" data-act="import">${icon.image}Importer une image</button>
                <input class="field" data-url placeholder="ou colle une URL https://…" spellcheck="false" />
              </div>
            </div>
            <div>
              <div class="flex items-center justify-between"><span class="label !mb-0">Zoom</span><b class="text-xs tabular-nums" data-zoom-val></b></div>
              <input type="range" class="range mt-2.5" data-zoom min="100" max="400" step="1" />
            </div>
            <div class="flex items-start gap-5">
              <div>
                <span class="label">Position</span>
                <div class="nudge">
                  <span></span><button data-nudge="0,-1" title="Haut">${icon.chevron.replace('class="icon"', 'class="icon" style="transform:rotate(180deg)"')}</button><span></span>
                  <button data-nudge="-1,0" title="Gauche">${icon.chevron.replace('class="icon"', 'class="icon" style="transform:rotate(90deg)"')}</button>
                  <button data-act="center" title="Centrer">${icon.crosshair}</button>
                  <button data-nudge="1,0" title="Droite">${icon.chevron.replace('class="icon"', 'class="icon" style="transform:rotate(-90deg)"')}</button>
                  <span></span><button data-nudge="0,1" title="Bas">${icon.chevron}</button><span></span>
                </div>
              </div>
              <div class="flex flex-1 flex-col gap-2 pt-[22px]">
                <button class="btn btn-ghost btn-sm" data-act="center">${icon.crosshair}Centrer</button>
                <button class="btn btn-ghost btn-sm" data-act="reset">${icon.refresh}Réinitialiser</button>
                <button class="btn btn-ghost btn-sm" data-act="remove">${icon.trash}${isCover ? "Jaquette générée" : "Retirer l'image"}</button>
              </div>
            </div>
            ${isCover ? `<div class="ce-preview" data-preview></div>` : ""}
          </div>
        </div>
        <div class="flex justify-end gap-2 border-t border-white/5 px-6 py-4">
          <button class="btn btn-ghost" data-act="cancel">Annuler</button>
          <button class="btn btn-primary" data-act="apply">${icon.check}Appliquer</button>
        </div>
      </div>`;
    document.body.appendChild(layer);

    const frame = layer.querySelector<HTMLElement>("[data-frame]")!;
    const zoomIn = layer.querySelector<HTMLInputElement>("[data-zoom]")!;
    const zoomVal = layer.querySelector<HTMLElement>("[data-zoom-val]")!;
    const urlIn = layer.querySelector<HTMLInputElement>("[data-url]")!;
    const preview = layer.querySelector<HTMLElement>("[data-preview]");
    urlIn.value = /^https?:/i.test(d.cover_image_url) ? d.cover_image_url : "";

    const hasImage = () => !!coverSrc(d.cover_image_url);

    /** Re-render frame + 3D preview (image changed). */
    const renderImage = () => {
      frame.innerHTML = `${coverHtml(d, false)}<i class="ce-thirds"></i><i class="ce-focus"></i>`;
      frame.classList.toggle("static", !hasImage());
      if (preview) {
        preview.innerHTML = boxHtml(d, { w: 116 });
        makeRotatable(preview.querySelector<HTMLElement>(".box3d")!, { bx: -8, by: 28 });
      }
      layer.querySelectorAll<HTMLButtonElement>("[data-nudge],[data-act=center],[data-act=reset]").forEach((b) => (b.disabled = !hasImage()));
      zoomIn.disabled = !hasImage();
      applyFraming();
    };
    /** Push the current framing to every cover preview (cheap, no re-render). */
    const applyFraming = () => {
      const vars = framingVars(d);
      layer.querySelectorAll<HTMLElement>(".cover-img").forEach((img) => (img.style.cssText = vars));
      const focus = frame.querySelector<HTMLElement>(".ce-focus");
      if (focus) {
        focus.style.left = `${d.cover_x}%`;
        focus.style.top = `${d.cover_y}%`;
      }
      zoomIn.value = String(Math.round(d.cover_zoom * 100));
      zoomIn.style.setProperty("--p", `${((d.cover_zoom - 1) / 3) * 100}%`);
      zoomVal.textContent = `${Math.round(d.cover_zoom * 100)} %`;
    };

    const setZoom = (z: number) => {
      d.cover_zoom = clamp(z, 1, 4);
      applyFraming();
    };
    const move = (dx: number, dy: number) => {
      const img = frame.querySelector<HTMLImageElement>("img.cover-img");
      if (!img || !img.naturalWidth) return;
      const fw = frame.clientWidth;
      const fh = frame.clientHeight;
      const s = Math.max(fw / img.naturalWidth, fh / img.naturalHeight);
      d.cover_x = clamp(d.cover_x + dx * panFactor(fw, img.naturalWidth * s, d.cover_zoom), 0, 100);
      d.cover_y = clamp(d.cover_y + dy * panFactor(fh, img.naturalHeight * s, d.cover_zoom), 0, 100);
      applyFraming();
    };

    // Drag to pan
    let drag: { x: number; y: number } | null = null;
    frame.addEventListener("pointerdown", (e) => {
      if (!hasImage()) return;
      drag = { x: e.clientX, y: e.clientY };
      frame.setPointerCapture(e.pointerId);
      frame.classList.add("dragging");
    });
    frame.addEventListener("pointermove", (e) => {
      if (!drag) return;
      move(e.clientX - drag.x, e.clientY - drag.y);
      drag = { x: e.clientX, y: e.clientY };
    });
    const endDrag = () => {
      drag = null;
      frame.classList.remove("dragging");
    };
    frame.addEventListener("pointerup", endDrag);
    frame.addEventListener("pointercancel", endDrag);
    frame.addEventListener(
      "wheel",
      (e) => {
        if (!hasImage()) return;
        e.preventDefault();
        setZoom(d.cover_zoom * Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
    frame.addEventListener("dblclick", () => {
      d.cover_x = 50;
      d.cover_y = 50;
      applyFraming();
    });
    zoomIn.addEventListener("input", () => setZoom(Number(zoomIn.value) / 100));
    urlIn.addEventListener("change", () => {
      const v = urlIn.value.trim();
      if (v && !/^https:\/\//i.test(v)) {
        errorToast("Utilise une adresse https://", "URL refusée");
        return;
      }
      Object.assign(d, { cover_image_url: v, cover_zoom: 1, cover_x: 50, cover_y: 50 });
      renderImage();
    });

    const finish = (result: CoverLike | null) => {
      document.removeEventListener("keydown", onKey, true);
      layer.classList.add("closing");
      setTimeout(() => layer.remove(), 240);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      const k: Record<string, [number, number]> = { ArrowLeft: [8, 0], ArrowRight: [-8, 0], ArrowUp: [0, 8], ArrowDown: [0, -8] };
      if (e.key === "Escape") finish(null);
      else if (k[e.key] && document.activeElement !== urlIn && hasImage()) move(...k[e.key]);
      else return;
      e.preventDefault();
      e.stopPropagation(); // keep Escape from closing the form underneath
    };
    document.addEventListener("keydown", onKey, true);

    layer.querySelector(".layer-bg")!.addEventListener("click", () => finish(null));
    layer.addEventListener("click", async (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act],[data-nudge]");
      if (!el) return;
      if (el.dataset.nudge) {
        const [x, y] = el.dataset.nudge.split(",").map(Number);
        d.cover_x = clamp(d.cover_x + x * 5, 0, 100);
        d.cover_y = clamp(d.cover_y + y * 5, 0, 100);
        applyFraming();
        return;
      }
      switch (el.dataset.act) {
        case "cancel":
          return finish(null);
        case "apply":
          return finish({ ...d });
        case "center":
          d.cover_x = 50;
          d.cover_y = 50;
          return applyFraming();
        case "reset":
          Object.assign(d, { cover_zoom: 1, cover_x: 50, cover_y: 50 });
          return applyFraming();
        case "remove":
          Object.assign(d, { cover_image_url: "", cover_zoom: 1, cover_x: 50, cover_y: 50 });
          urlIn.value = "";
          return renderImage();
        case "import":
          try {
            const p = await opts.pickImage();
            if (!p) return;
            Object.assign(d, { cover_image_url: p, cover_zoom: 1, cover_x: 50, cover_y: 50 });
            urlIn.value = "";
            renderImage();
          } catch (err) {
            errorToast(err, "Import impossible");
          }
          return;
      }
    });

    renderImage();
  });
}
