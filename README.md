<p align="center">
  <img src="assets/logo-horizontal-dark.png" alt="GameREZ" width="560" />
</p>

<p align="center">
  <b>Le launcher de jeux PC open source, ultra-léger, qui chronomètre ton temps de jeu à la seconde près.</b><br/>
  Tauri v2 · Rust · TypeScript · Tailwind CSS · SQLite
</p>

---

## Pourquoi GameREZ ?

- **Tous tes jeux au même endroit** : Steam, Epic, GOG, Battle.net, jeux sans launcher… une seule grille de jaquettes.
- **Temps de jeu exact** : un watcher Rust suit le processus du jeu et enregistre chaque session (en secondes) dans une base SQLite locale.
- **Assistant « PC propre »** : un guide pas-à-pas par launcher pour ranger tes disques (`D:\Jeux\BattleNet`, `D:\Jeux\Steam`…), avec création des dossiers en un clic.
- **Léger** : pas d'Electron. Binaire natif de quelques Mo, interface en ~16 Ko de JS gzippé.

## 🛡️ Zéro risque de ban

GameREZ est **strictement** un lanceur de raccourcis et un chronomètre :

| GameREZ fait | GameREZ ne fait **jamais** |
| --- | --- |
| Lancer l'exécutable via l'API de l'OS (`std::process::Command` / ShellExecute) | Injecter du code ou lire/écrire la mémoire d'un jeu |
| Lire la liste des processus (comme le Gestionnaire des tâches) | Modifier, déplacer ou supprimer un fichier de jeu |
| Lire le nom et la version d'un `.exe` (comme Explorer › Propriétés) | Contourner un DRM ou un anti-cheat |

Supprimer un jeu de GameREZ retire uniquement sa fiche : les fichiers sur le disque ne sont pas touchés.

## Fonctionnalités

- Grille de jaquettes animée (glassmorphism sombre, tilt 3D, transitions fluides) avec filtres **Tous / Installés / Non installés / Launchers**, recherche (`Ctrl+F`) et tri.
- Menu **Options** sous chaque jaquette : temps de jeu total (`42h 15m`), version, dernière session, **Ouvrir l'emplacement**, modifier, supprimer.
- Import d'un jeu via son `.exe` (sélecteur natif ou **glisser-déposer** dans la fenêtre) : titre et version lus automatiquement.
- Jaquette par URL ou image locale (copiée dans le dossier de l'app) ; sinon une jaquette générée.
- Session en direct : badge « En cours » + chrono, toast de fin de session avec le temps ajouté.
- Vue **Launchers** : détection de Steam, Epic Games, Battle.net, Ubisoft Connect, GOG Galaxy, EA app ; bouton **Télécharger** (site officiel uniquement, URLs en liste blanche côté Rust) ; ajout du launcher à la bibliothèque.

### Comment le temps de jeu est mesuré

1. « Jouer » → le backend lance l'exe et ouvre une session dans SQLite.
2. Une tâche `tokio` surveille le PID toutes les 2 s.
3. Beaucoup de jeux passent par un *bootstrapper* qui se ferme tout de suite : GameREZ continue alors de suivre tout processus dont l'exécutable est **dans le dossier d'installation du jeu** (les dossiers génériques comme `steamapps\common` ou `D:\Jeux` sont exclus pour ne pas compter un autre jeu).
4. Toutes les 15 s, la session est sauvegardée (*heartbeat*) : en cas de crash du PC, le temps joué jusque-là est conservé.
5. À la fermeture : durée exacte enregistrée, `playtime_minutes` recalculé depuis la somme des sessions (aucune perte d'arrondi), événement `game-stopped` émis vers l'UI.

> Les **launchers** (Steam, Epic…) restent dans la barre des tâches en permanence : ils sont lancés mais pas chronométrés.

## Installation

1. Va sur la page [**Releases**](https://github.com/reztsk/GameREZ/releases/latest).
2. Télécharge **`GameREZ_x.y.z_x64-setup.exe`** et lance-le.
   - Installation pour ton compte uniquement (pas de droits admin) dans `%LOCALAPPDATA%\GameREZ`.
   - Raccourci **bureau** + menu Démarrer avec l'icône GameREZ.
   - Désinstallation propre depuis *Paramètres › Applications*.
3. Pas envie d'installer ? Prends **`GameREZ_x.y.z_x64_portable.exe`** et lance-le directement.

> L'exe n'est pas signé : si Windows SmartScreen bloque, clique sur *Informations complémentaires* › *Exécuter quand même*.

### Publier une nouvelle version

1. Monte la version dans `src-tauri/tauri.conf.json` (et `package.json`, `Cargo.toml`).
2. `git tag v0.2.0 && git push origin v0.2.0`
3. Le workflow **Release** compile GameREZ sous Windows et publie la release avec l'installateur et l'exe portable.

## Développement

Prérequis : [Node.js](https://nodejs.org) 20+, [Rust](https://rustup.rs) stable, et les [prérequis Tauri](https://tauri.app/start/prerequisites/) (WebView2 + MSVC Build Tools sous Windows).

```bash
npm install
npm run tauri dev      # app en mode développement
npm run tauri build    # installateur dans src-tauri/target/release/bundle/nsis/
npm test               # tests frontend (node:test)
npm run test:rust      # tests Rust (DB, watcher avec vrais processus, détection…)
```

`npm run dev` seul ouvre l'interface dans un navigateur avec des **données de démo** (backend simulé) — pratique pour travailler sur l'UI.

## Architecture

```
├─ assets/                 Logo (SVG sources + PNG haute résolution)
├─ public/                 Logo servi à l'UI
├─ scripts/render-logo.mjs Source du logo : génère SVG, PNG et image de l'installateur (npm run logo)
├─ src/                    Frontend TypeScript + Tailwind
│  ├─ main.ts              Vues Bibliothèque / Launchers, formulaire, événements
│  ├─ api.ts               Bridge typé vers les commandes Tauri
│  ├─ guides.ts            Guides de rangement par launcher
│  ├─ format.ts            Formatage (temps de jeu, dates…)
│  ├─ ui.ts / icons.ts     Modales, toasts, icônes
│  └─ mock.ts              Backend simulé (navigateur uniquement)
└─ src-tauri/              Backend Rust
   └─ src/
      ├─ db.rs             SQLite : tables games + sessions, récupération après crash
      ├─ watcher.rs        Lancement + suivi des processus (tokio, sysinfo)
      ├─ exe_info.rs       Lecture nom/version d'un .exe (API Windows, lecture seule)
      ├─ launchers.rs      Launchers connus, URLs officielles, détection
      └─ commands.rs       Commandes Tauri exposées au frontend
```

### Commandes Tauri

| Commande | Rôle |
| --- | --- |
| `list_games`, `add_game`, `update_game`, `delete_game` | CRUD bibliothèque |
| `launch_game(id)` | Lance le jeu et démarre le chrono |
| `running_games` | Sessions en cours |
| `open_folder(path)` | Ouvre l'explorateur Windows sur le dossier |
| `scan_executable(path?)` | Import d'un `.exe` (sélecteur natif si pas de chemin) |
| `pick_cover` | Choix d'une jaquette locale |
| `list_launchers`, `open_launcher_download(id)` | Détection + page officielle |
| `list_drives`, `create_folder(path)` | Assistant de rangement |

Événements : `game-started`, `game-stopped` (`{ game, session_seconds }`).

### Données

Base SQLite dans `%APPDATA%\io.github.gamerez\gamerez.sqlite3` :

- `games` : `id, title, executable_path, install_dir, cover_image_url, version, playtime_minutes, category ('installed' | 'not_installed' | 'launcher'), added_at, last_played_at`
- `sessions` : `id, game_id, started_at, ended_at, duration_seconds, active`

## Contribuer

Les PR sont bienvenues. Avant d'ouvrir une PR : `npm run build && npm test && npm run test:rust`.
Toute contribution doit respecter la règle d'or : **aucune interaction avec la mémoire ou les fichiers des jeux.**

## Licence

[MIT](LICENSE). Icônes : [Lucide](https://lucide.dev) (ISC).
