// Small framed renders of the profile picture / banner (data URLs sent to friends).
import { api, type ImageFrame } from "./api";

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (/^https?:/i.test(src)) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image"));
    img.src = src;
  });
}

/** Draw `f` exactly like the CSS framing (object-fit: cover + zoom around the focal point). */
export async function framedThumb(f: ImageFrame, w: number, h: number, quality = 0.82): Promise<string> {
  if (!f.url) return "";
  try {
    const src = /^(data:|https?:)/i.test(f.url) ? f.url : await api.imageDataUrl(f.url);
    const img = await load(src);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    const iw = img.naturalWidth || w;
    const ih = img.naturalHeight || h;
    const s = Math.max(w / iw, h / ih);
    const dw = iw * s;
    const dh = ih * s;
    const ox = (w * f.x) / 100;
    const oy = (h * f.y) / 100;
    ctx.translate(ox, oy);
    ctx.scale(f.zoom, f.zoom);
    ctx.translate(-ox, -oy);
    ctx.drawImage(img, ((w - dw) * f.x) / 100, ((h - dh) * f.y) / 100, dw, dh);
    return c.toDataURL("image/jpeg", quality);
  } catch {
    return ""; // remote image without CORS, unreadable file…: friends see initials
  }
}
