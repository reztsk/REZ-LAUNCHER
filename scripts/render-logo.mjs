// Render SVG brand assets to high-res PNGs: node scripts/render-logo.mjs
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";

const jobs = [
  ["assets/logo-mark.svg", "assets/logo-mark-1024.png", 1024],
  ["assets/logo-mark-transparent.svg", "assets/logo-mark-transparent-1024.png", 1024],
  ["assets/logo-horizontal.svg", "assets/logo-horizontal.png", 2920],
  ["assets/logo-horizontal.svg", "assets/logo-horizontal-dark.png", 2920, "#07070d"],
];
for (const [src, out, width, background] of jobs) {
  const png = new Resvg(readFileSync(src), { fitTo: { mode: "width", value: width }, background }).render().asPng();
  writeFileSync(out, png);
  console.log(`${out} (${png.length} bytes)`);
}
