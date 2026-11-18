// Pure maths of the 3D views (no DOM, no imports: unit-tested with node:test).

/** Box slot `o` positions away from the carousel centre (box width `w` px). */
export function slot(o: number, w: number): { x: number; z: number; ry: number; visible: boolean } {
  const a = Math.abs(o);
  const s = Math.sign(o);
  if (a === 0) return { x: 0, z: 70, ry: 0, visible: true };
  return {
    x: s * (w * 1.0 + (a - 1) * w * 0.4),
    z: -w * 0.38 - a * w * 0.2,
    ry: -s * 48,
    visible: a <= 6,
  };
}

/** Cover editor: focal-point % moved per dragged px, for a frame of `frame` px
 *  showing an image rendered `rendered` px wide (object-fit: cover) at `zoom`. */
export function panFactor(frame: number, rendered: number, zoom: number): number {
  const range = frame - rendered * zoom; // ≤ 0: how far the image can travel
  return Math.abs(range) < 0.5 ? 0 : 100 / range;
}

/** CSS variables applying a cover framing (zoom 1..4, focal point 0..100 %). */
export function framingVars(c: { cover_zoom: number; cover_x: number; cover_y: number }): string {
  const z = Number.isFinite(c.cover_zoom) ? Math.min(4, Math.max(1, c.cover_zoom)) : 1;
  const x = Number.isFinite(c.cover_x) ? Math.min(100, Math.max(0, c.cover_x)) : 50;
  const y = Number.isFinite(c.cover_y) ? Math.min(100, Math.max(0, c.cover_y)) : 50;
  return `--cz:${z.toFixed(3)};--cx:${x.toFixed(2)}%;--cy:${y.toFixed(2)}%`;
}
