// GameREZ brand assets — single source of truth.
// Generates the SVG logos, high-res PNGs and the installer bitmap:
//   node scripts/render-logo.mjs
// Then refresh the app icons with:  npx tauri icon assets/logo-mark-1024.png
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Palette: black & grey only.
// ---------------------------------------------------------------------------
const defs = (p) => `
  <defs>
    <linearGradient id="${p}bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1f1f23"/>
      <stop offset="0.55" stop-color="#0b0b0d"/>
      <stop offset="1" stop-color="#000000"/>
    </linearGradient>
    <radialGradient id="${p}core" cx="0.5" cy="0.45" r="0.55">
      <stop offset="0" stop-color="#2e2e33" stop-opacity="0.95"/>
      <stop offset="1" stop-color="#0b0b0d" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${p}metal" x1="182" y1="150" x2="352" y2="362" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.38" stop-color="#d4d4d8"/>
      <stop offset="0.72" stop-color="#8a8a93"/>
      <stop offset="1" stop-color="#b4b4bb"/>
    </linearGradient>
    <linearGradient id="${p}edge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#e4e4e7"/>
      <stop offset="0.5" stop-color="#8a8a93"/>
      <stop offset="1" stop-color="#3f3f46"/>
    </linearGradient>
    <pattern id="${p}grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M32 0 H0 V32" fill="none" stroke="#ffffff" stroke-opacity="0.045" stroke-width="1.5"/>
    </pattern>
    <filter id="${p}glow" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="7" result="b"/>
      <feFlood flood-color="#ffffff" flood-opacity="0.28"/>
      <feComposite in2="b" operator="in" result="g"/>
      <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="${p}shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="#000000" flood-opacity="0.8"/>
    </filter>
    <clipPath id="${p}clip"><rect width="512" height="512" rx="108"/></clipPath>
  </defs>`;

const HEX = "M256 78 L410.2 167 L410.2 345 L256 434 L101.8 345 L101.8 167 Z";
const HEX_OUTER = "M256 58 L427.5 157 L427.5 355 L256 454 L84.5 355 L84.5 157 Z";
// Chamfered R whose counter is a "play" triangle.
const R =
  "M200 150 H306 L344 188 V234 L314 264 L352 362 H296 L262 274 H236 V362 H182 V168 Z " +
  "M236 182 L304 207 L236 232 Z";

/** Hexagon frame + R, drawn in the 512×512 design space. */
const emblem = (p) => `
  <path d="${HEX}" fill="url(#${p}core)"/>
  <path d="${HEX_OUTER}" fill="none" stroke="#52525b" stroke-width="2" stroke-dasharray="3 9"/>
  <path d="${HEX}" fill="none" stroke="url(#${p}edge)" stroke-width="14" stroke-linejoin="miter" stroke-dasharray="480 54" stroke-dashoffset="-20"/>
  <rect x="249" y="71" width="14" height="14" fill="#e4e4e7" transform="rotate(45 256 78)"/>
  <rect x="249" y="427" width="14" height="14" fill="#52525b" transform="rotate(45 256 434)"/>
  <rect x="140" y="298" width="28" height="6" fill="#71717a"/>
  <rect x="128" y="310" width="16" height="6" fill="#3f3f46"/>
  <rect x="352" y="196" width="34" height="6" fill="#a1a1aa"/>
  <rect x="368" y="208" width="18" height="6" fill="#52525b"/>
  <g filter="url(#${p}shadow)">
    <g filter="url(#${p}glow)">
      <path fill-rule="evenodd" d="${R}" fill="url(#${p}metal)"/>
    </g>
  </g>
  <path fill-rule="evenodd" d="${R}" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="2"/>`;

/** Rounded dark container + grid + HUD corner brackets. */
const container = (p) => `
  <rect width="512" height="512" rx="108" fill="url(#${p}bg)"/>
  <rect width="512" height="512" fill="url(#${p}grid)" clip-path="url(#${p}clip)"/>
  <rect x="5" y="5" width="502" height="502" rx="103" fill="none" stroke="#ffffff" stroke-opacity="0.09" stroke-width="2"/>
  <g fill="none" stroke="#52525b" stroke-width="5" stroke-linecap="square">
    <path d="M58 98 V58 H98"/><path d="M414 58 H454 V98"/>
    <path d="M454 414 V454 H414"/><path d="M98 454 H58 V414"/>
  </g>`;

const markSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>GameREZ</title>${defs("m")}${container("m")}${emblem("m")}
</svg>
`;

const markTransparentSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="40 40 432 432" width="432" height="432">
  <title>GameREZ mark</title>${defs("t")}${emblem("t")}
</svg>
`;

// Wordmark letters (stroked, no font needed), 80 units tall.
const GAME = `
      <path d="M50 6 L14 6 L6 14 L6 66 L14 74 L50 74 L50 42 L30 42"/>
      <path transform="translate(76 0)" d="M6 74 L6 22 L22 6 L34 6 L50 22 L50 74 M6 46 L50 46"/>
      <path transform="translate(152 0)" d="M6 74 L6 6 L28 32 L50 6 L50 74"/>
      <path transform="translate(228 0)" d="M50 6 L6 6 L6 74 L50 74 M6 40 L40 40"/>`;
const REZ = `
      <path d="M6 74 L6 6 L42 6 L50 14 L50 32 L42 40 L6 40 M30 40 L50 74"/>
      <path d="M126 6 L82 6 L82 74 L126 74 M82 40 L116 40"/>
      <path d="M158 6 L202 6 L158 74 L202 74"/>`;
const wordDefs = (p) => `
    <linearGradient id="${p}wm" x1="0" y1="0" x2="208" y2="80" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff"/><stop offset="0.6" stop-color="#d4d4d8"/><stop offset="1" stop-color="#9f9fa8"/>
    </linearGradient>
    <filter id="${p}wglow" x="-20%" y="-30%" width="140%" height="160%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="2.5" result="b"/>
      <feFlood flood-color="#ffffff" flood-opacity="0.35"/>
      <feComposite in2="b" operator="in" result="g"/>
      <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>`;
const wordmark = (p, game = "#8a8a93") => `
    <g fill="none" stroke-width="12" stroke-linejoin="miter" stroke-linecap="butt">
      <g stroke="${game}">${GAME}
      </g>
      <g transform="translate(304 0)" stroke="url(#${p}wm)" filter="url(#${p}wglow)">${REZ}
      </g>
    </g>`;

const horizontalSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1460 400" width="1460" height="400">
  <title>GameREZ</title>
  <defs>${wordDefs("h")}</defs>
  <svg x="30" y="30" width="340" height="340" viewBox="0 0 512 512">${defs("h")}${container("h")}${emblem("h")}
  </svg>
  <g transform="translate(430 128) scale(1.8)">${wordmark("h")}
    <path d="M0 98 H512" stroke="#3f3f46" stroke-width="2"/>
    <path d="M0 98 H120" stroke="#a1a1aa" stroke-width="2"/>
  </g>
</svg>
`;

// NSIS welcome/finish sidebar: 164×314 (rendered ×2 then stored as BMP at 1×).
const installerSidebarSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 164 314" width="164" height="314">
  <defs>
    <linearGradient id="sbg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#18181b"/><stop offset="1" stop-color="#000000"/>
    </linearGradient>
    <pattern id="sgrid" width="12" height="12" patternUnits="userSpaceOnUse">
      <path d="M12 0 H0 V12" fill="none" stroke="#ffffff" stroke-opacity="0.04" stroke-width="0.6"/>
    </pattern>${wordDefs("s")}
  </defs>
  <rect width="164" height="314" fill="url(#sbg)"/>
  <rect width="164" height="314" fill="url(#sgrid)"/>
  <svg x="27" y="58" width="110" height="110" viewBox="0 0 512 512">${defs("s")}${container("s")}${emblem("s")}
  </svg>
  <g transform="translate(22 196) scale(0.234)">${wordmark("s")}
  </g>
  <path d="M22 226 H142" stroke="#3f3f46" stroke-width="1"/>
  <path d="M22 226 H55" stroke="#a1a1aa" stroke-width="1"/>
  <g fill="#52525b"><rect x="19" y="290" width="4" height="4"/><rect x="27" y="290" width="4" height="4"/><rect x="35" y="290" width="4" height="4" fill="#a1a1aa"/></g>
</svg>
`;

// ---------------------------------------------------------------------------
const svgs = {
  "assets/logo-mark.svg": markSvg(),
  "assets/logo-mark-transparent.svg": markTransparentSvg(),
  "assets/logo-horizontal.svg": horizontalSvg(),
  "public/logo-mark.svg": markTransparentSvg(),
  "public/favicon.svg": markSvg(),
};
for (const [path, svg] of Object.entries(svgs)) writeFileSync(path, svg);

const render = (svg, width, background) =>
  new Resvg(svg, { fitTo: { mode: "width", value: width }, background }).render();

const pngs = [
  ["assets/logo-mark-1024.png", svgs["assets/logo-mark.svg"], 1024],
  ["assets/logo-mark-transparent-1024.png", svgs["assets/logo-mark-transparent.svg"], 1024],
  ["assets/logo-horizontal.png", svgs["assets/logo-horizontal.svg"], 2920],
  ["assets/logo-horizontal-dark.png", svgs["assets/logo-horizontal.svg"], 2920, "#09090b"],
];
for (const [out, svg, width, bg] of pngs) {
  const png = render(svg, width, bg).asPng();
  writeFileSync(out, png);
  console.log(`${out} (${png.length} bytes)`);
}

/** Encode RGBA pixels (opaque) as a 24-bit bottom-up BMP, the format NSIS expects. */
function toBmp(rgba, w, h) {
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + rowSize * h;
  const b = Buffer.alloc(size);
  b.write("BM", 0);
  b.writeUInt32LE(size, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18);
  b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(rowSize * h, 34);
  b.writeInt32LE(2835, 38);
  b.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    const row = 54 + (h - 1 - y) * rowSize;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      b[row + x * 3] = rgba[i + 2];
      b[row + x * 3 + 1] = rgba[i + 1];
      b[row + x * 3 + 2] = rgba[i];
    }
  }
  return b;
}

const sidebar = render(installerSidebarSvg(), 164, "#000000");
writeFileSync("src-tauri/installer/sidebar.bmp", toBmp(sidebar.pixels, sidebar.width, sidebar.height));
writeFileSync("assets/installer-sidebar.png", render(installerSidebarSvg(), 328, "#000000").asPng());
console.log("src-tauri/installer/sidebar.bmp");
