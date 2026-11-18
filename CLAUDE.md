# Project: GameREZ (launcher de jeux PC open source)

## Stack Technique
- **Backend / Core:** Rust (Tauri v2, `tokio`, `rusqlite` ou `sqlx`, `sysinfo` pour le suivi des processus).
- **Frontend:** TypeScript, Tailwind CSS, et composants animés (Framer Motion / CSS pur pour des animations fluides 60fps).
- **Cible:** Application Desktop Windows ultra-légère, performante et open source (GitHub).

## Philosophie du Projet & Règles d'Or
1. **Zéro Risque / Zéro Ban:** L'application agit strictement comme un lanceur de raccourcis (`std::process::Command`) et un chronométreur de processus. Elle **ne touche jamais** aux fichiers internes des jeux, ne s'injecte pas dans la mémoire, et ne contourne aucun DRM.
2. **Performance & Légèreté:** Pas de lourdeur type Electron brut. Rust gère le gros des I/O (disque, base de données SQLite locale, détection des processus).
3. **Caveman Style (Direct & Concret):** Pas de blabla inutile, pas de longues explications théoriques. Du code propre, typé, fonctionnel, testé et prêt à être commité.

## Structure du Projet (Mental Map)
- `/src-tauri` : Code Rust (commandes Tauri, gestion de la DB SQLite, watcher des processus pour le temps de jeu, ouverture de dossiers natifs).
- `/src` : Frontend UI (Composants, gestion des états des jaquettes, filtres: Installés / Non installés / Launchers).

## Commandes Clés
- `npm run tauri dev` : Lancer l'application en mode développement.
- `npm run tauri build` : Compiler l'application pour la production.
- `cargo test` : Lancer les tests unitaires Rust.