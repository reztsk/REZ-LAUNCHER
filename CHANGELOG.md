# Changelog

## v0.4.0

- **Profil** : photo de profil et bannière (import, déplacer, zoomer, centrer), pseudo, bio et code ami. **Vitrine** de 6 jeux favoris affichés en boîtes 3D, à épingler depuis le profil ou le menu d'un jeu.
- **Amis sur le réseau local** : ajoute tes potes avec leur code ami ou depuis la liste « Sur ton réseau », vois en direct qui est en ligne, en jeu (et à quoi) ou hors ligne, et consulte leur profil et leur vitrine. Pair-à-pair, sans compte ni serveur, désactivé par défaut.
- **Désinstaller** (menu d'options d'un jeu) : lance le désinstallateur officiel du jeu (entrée Windows « Applications », fenêtre de désinstallation Steam ou `unins000.exe`), attend la fin, puis retire le jeu de la bibliothèque.
- **Jeux et logiciels séparés** : Wallpaper Engine, Crosshair X, Lossless Scaling, overlays, outils de benchmark… vont dans le nouvel onglet **Logiciels**, plus dans tes jeux. Reclassement en un clic depuis le menu d'un jeu.
- **Catégories et ordre libre** : regroupement automatique **par plateforme** (Steam, Epic, EA, Ubisoft, Battle.net, Rockstar, GOG…) ou **par catégorie** perso (FPS, Coop…), et tri **« Mon ordre »** : glisse les jeux pour les réordonner.
- **Launchers mieux détectés** : lecture (seule) du registre Windows et des entrées « Applications » en plus des dossiers habituels et d'AppData. Ajout du **Rockstar Games Launcher**.
- **Mode Boîte 3D réparé** : la grille affiche de vraies boîtes 3D (tranche avec le titre visible), et la boîte s'ouvre toujours côté tranche ; les côtés ne se confondent plus avec le fond.
- **Interface plus sobre** : suppression de tous les halos et reflets lumineux qui suivaient la souris (cartes, boutons, verre).
- Correctif : les animations ne restent plus figées à l'écran après une session de jeu.

## v0.3.0

- **Fenêtre automatique pendant le jeu** : REZ launcher se réduit dans la barre des tâches dès que la fenêtre du jeu apparaît, coupe ses animations, puis revient au premier plan à la fermeture du jeu (réglable dans *Paramètres › Lancement des jeux*).
- **Animation de lancement** : la boîte du jeu s'ouvre en plein écran, une barre de chargement suit le démarrage jusqu'à l'apparition de la fenêtre du jeu (détectée en lecture seule, comme Alt+Tab), puis bascule automatique vers le jeu.
- **Éditeur de jaquette** : importe une image (ou une URL), puis déplace, zoome et centre-la en direct dans le cadre. L'image d'origine n'est jamais modifiée.
- **Une jaquette pour chaque jeu** : les jeux Steam reçoivent automatiquement leur jaquette officielle ; les autres ont une jaquette générée avec leur titre.
- **Mode « Boîte 3D »** : un clic sur un jeu ouvre sa boîte en 3D, à faire tourner à la souris. La face montre la jaquette, la tranche le titre en relief, et le dos une description sur fond flouté.
- **Mode « Carrousel 3D »** : tes jeux en boîtes 3D sur un carrousel horizontal (molette, flèches, glisser).
- **Thèmes** : Acier, Cyber cyan, Néon, Carbone, Ambre, Glacier.
- **Effet verre Apple** : verre givré, reflets qui suivent la souris et bordures lumineuses sur la barre latérale et les catégories.
- Description personnalisable pour chaque jeu (dos de la boîte).

## v0.2.0

GameREZ devient **REZ launcher**.

- **Nouveau design noir & gris** : palette stricte noir / anthracite / blanc / gris acier, nouveau logo REZ / LAUNCHER (app, barre des tâches, installateur).
- **Temps de jeu par jeu** : chaque jaquette affiche le temps joué sur ce jeu (« 42h 15m jouées »), avec sessions et moyenne dans son menu. Le compteur global de la barre latérale est supprimé.
- **Mises à jour automatiques** : vérification au lancement et dans Paramètres, pop-up avec bouton « Installer » (paquet signé, téléchargé et installé tout seul).
- **Détection des nouveaux jeux** : analyse en lecture seule des manifestes Steam, Epic Games, GOG et de tes dossiers de jeux. Pop-up « Veux-tu l'ajouter à la bibliothèque REZ launcher ? ».
- **Guides en carrousel** : chaque launcher a son guide pas-à-pas interactif, avec son vrai logo.
- **Onglet Paramètres** : apparence (taille des jaquettes, animations, effet 3D, fond animé), mises à jour, dossiers de recherche, lancement avec Windows, onglet d'ouverture, vidage du cache.
- Ta bibliothèque GameREZ (jeux, sessions, jaquettes) est importée automatiquement au premier lancement.

## v0.1.0

- Première version publique (GameREZ) : bibliothèque, lancement, chrono de temps de jeu, détection des launchers, guides de rangement.
