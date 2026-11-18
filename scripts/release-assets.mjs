// Collect the Windows build for a GitHub Release:
//   release-out/assets/REZ-launcher_<v>_x64-setup.exe     NSIS installer (signed for the updater)
//   release-out/assets/REZ-launcher_<v>_x64_portable.exe  standalone exe
//   release-out/assets/latest.json                         updater manifest (signature + URL)
//   release-out/notes.md                                   release body
// Usage (after `npm run tauri build` with TAURI_SIGNING_PRIVATE_KEY set):
//   node scripts/release-assets.mjs
import fs from "node:fs";
import path from "node:path";

const conf = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
const v = conf.version;
const repo = process.env.GITHUB_REPOSITORY || "reztsk/REZ-LAUNCHER";
const nsisDir = "src-tauri/target/release/bundle/nsis";
const out = "release-out";
const assets = path.join(out, "assets");

const setup = fs.readdirSync(nsisDir).find((f) => f.endsWith(`_${v}_x64-setup.exe`));
if (!setup) throw new Error(`No NSIS installer for v${v} in ${nsisDir}`);
const sigFile = path.join(nsisDir, `${setup}.sig`);
if (!fs.existsSync(sigFile)) {
  throw new Error(`Missing ${sigFile}: build with TAURI_SIGNING_PRIVATE_KEY set (updater signature).`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(assets, { recursive: true });

const setupName = `REZ-launcher_${v}_x64-setup.exe`;
const portableName = `REZ-launcher_${v}_x64_portable.exe`;
fs.copyFileSync(path.join(nsisDir, setup), path.join(assets, setupName));
fs.copyFileSync(`src-tauri/target/release/${conf.mainBinaryName}.exe`, path.join(assets, portableName));

// Notes = the "## v<version>" section of CHANGELOG.md.
const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
const section = changelog.split(/^## /m).find((s) => s.startsWith(`v${v}`));
const changes = section ? section.split("\n").slice(1).join("\n").trim() : "";

const url = `https://github.com/${repo}/releases/download/v${v}/${setupName}`;
const signature = fs.readFileSync(sigFile, "utf8").trim();
const manifest = {
  version: v,
  notes: changes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": { signature, url },
    "windows-x86_64-nsis": { signature, url },
  },
};
fs.writeFileSync(path.join(assets, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");

fs.writeFileSync(
  path.join(out, "notes.md"),
  `${changes}

## Télécharger

- **\`${setupName}\`** : installateur Windows (recommandé). Installe REZ launcher pour ton compte (sans droits admin) et crée un raccourci sur le bureau + dans le menu Démarrer.
- **\`${portableName}\`** : version portable, rien à installer (WebView2 requis, déjà présent sur Windows 10/11 à jour).

Déjà installé ? REZ launcher te propose la mise à jour tout seul (pop-up au lancement, ou *Paramètres › Mises à jour*).

Windows SmartScreen peut afficher « Windows a protégé votre ordinateur » car l'exe n'est pas signé : clique sur *Informations complémentaires* puis *Exécuter quand même*.

REZ launcher ne touche jamais aux fichiers ni à la mémoire des jeux : zéro risque de ban.
`,
);

for (const f of fs.readdirSync(assets)) {
  console.log(`${f}  ${fs.statSync(path.join(assets, f)).size} B`);
}
