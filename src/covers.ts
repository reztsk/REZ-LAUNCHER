// Cover rendering shared by the grid, the 3D box, the carousel and the editor.
import { coverSrc } from "./api";
import { esc, hueFrom, initials } from "./format";
import { framingVars } from "./fx-math";

/** What is needed to draw a cover (a Game, or the cover editor's draft). */
export interface CoverLike {
  title: string;
  cover_image_url: string;
  cover_zoom: number;
  cover_x: number;
  cover_y: number;
}

/** Generated cover when a game has no image: steel gradient, accent glow, grid, initials, title. */
export function generatedCover(title: string): string {
  const h = hueFrom(title);
  const l1 = 16 + (h % 18);
  const angle = 120 + (h % 80);
  return `<div class="gen" style="background:
      radial-gradient(circle at 78% 88%, rgb(var(--acc-rgb) / .16), transparent 55%),
      radial-gradient(circle at 25% 15%, rgb(255 255 255 / .16), transparent 55%),
      linear-gradient(${angle}deg, hsl(240 4% ${l1}%), hsl(240 5% 9%) 62%, #050506)">
      <span class="mark" style="background:url(/logo-mark.svg) center/contain no-repeat;aspect-ratio:1"></span>
      <span class="initials">${esc(initials(title))}</span>
      <span class="gen-title">${esc(title)}</span>
    </div>`;
}

/** `<img>` with the user's framing, or the generated cover. */
export function coverHtml(c: CoverLike, lazy = true): string {
  const src = coverSrc(c.cover_image_url);
  return src
    ? `<img class="cover-img" src="${esc(src)}" alt="" ${lazy ? 'loading="lazy"' : ""} draggable="false" data-title="${esc(c.title)}" style="${framingVars(c)}" />`
    : generatedCover(c.title);
}

/** Plain background URL of a cover (for blurred backdrops), or null. */
export function coverBg(c: Pick<CoverLike, "cover_image_url">): string | null {
  const src = coverSrc(c.cover_image_url);
  return src ? `url('${src.replace(/'/g, "%27")}')` : null;
}
