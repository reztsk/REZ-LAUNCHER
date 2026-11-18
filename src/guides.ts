// Step-by-step "tidy PC" guides for each launcher.

export interface GuideStep {
  title: string;
  body: string;
  /** Optional action rendered as a button next to the step. */
  action?: { kind: "create_folder"; path: string } | { kind: "download" } | { kind: "rescan" };
}

interface LauncherTips {
  /** Where to change the client's install folder in the installer. */
  installerTip: string;
  /** Where to set the default game library inside the launcher. */
  libraryTip: string;
  /** Library folder (relative to the launcher folder) or null if the client handles it. */
  librarySub: string | null;
}

const TIPS: Record<string, LauncherTips> = {
  steam: {
    installerTip: "Dans l'installateur, à l'étape « Choisir l'emplacement », clique sur « Parcourir… ».",
    libraryTip:
      "Steam range tes jeux dans <code>steamapps\\common</code> à l'intérieur de son dossier. Pour un 2e disque : Steam › Paramètres › Stockage › « Ajouter un lecteur ».",
    librarySub: null,
  },
  epic: {
    installerTip: "Dans l'installateur MSI, clique sur « Modifier » à côté du dossier de destination.",
    libraryTip:
      "À chaque installation de jeu, Epic te demande l'emplacement : clique sur « Parcourir » et choisis le dossier ci-dessous.",
    librarySub: "Games",
  },
  battlenet: {
    installerTip: "Au lancement de l'installateur, clique sur « Modifier » sous « Emplacement d'installation ».",
    libraryTip:
      "Battle.net › Paramètres › Téléchargements › « Emplacement d'installation par défaut » : choisis le dossier ci-dessous.",
    librarySub: "Games",
  },
  ubisoft: {
    installerTip: "Dans l'installateur, à l'étape « Dossier de destination », clique sur « Parcourir… ».",
    libraryTip:
      "Ubisoft Connect › Paramètres › Téléchargements › « Emplacement d'installation des jeux par défaut ».",
    librarySub: "Games",
  },
  gog: {
    installerTip: "Dans l'installateur, clique sur « Options » puis change le dossier d'installation.",
    libraryTip:
      "GOG Galaxy › Paramètres › Installation et mises à jour › « Dossier d'installation des jeux ».",
    librarySub: "Games",
  },
  ea: {
    installerTip: "Dans l'installateur de l'EA app, clique sur « Modifier l'emplacement » avant d'installer.",
    libraryTip: "EA app › Paramètres › Téléchargement › « Emplacement d'installation des jeux ».",
    librarySub: "Games",
  },
  rockstar: {
    installerTip: "Dans l'installateur du Rockstar Games Launcher, choisis « Parcourir » à l'étape du dossier d'installation.",
    libraryTip: "Rockstar Games Launcher › Paramètres › Jeux installés : à chaque installation, choisis le dossier ci-dessous.",
    librarySub: "Games",
  },
};

/** Join a Windows path safely: ("D:\\", "Jeux") -> "D:\\Jeux". */
export function joinWin(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .filter(Boolean)
    .join("\\");
}

export function guideFor(launcherId: string, launcherName: string, folder: string, drive: string): GuideStep[] {
  const tips = TIPS[launcherId] ?? TIPS.steam;
  const driveLabel = drive.replace(/[\\/]+$/, "");
  const root = joinWin(drive, "Jeux");
  const target = joinWin(root, folder);
  const steps: GuideStep[] = [
    {
      title: `Crée un dossier « Jeux » sur ton disque ${driveLabel}`,
      body: `Un seul dossier racine pour tous tes jeux : <code>${root}</code>. Fini les jeux éparpillés dans <code>Program Files</code>.`,
      action: { kind: "create_folder", path: root },
    },
    {
      title: `Crée un sous-dossier « ${folder} »`,
      body: `Chaque launcher a son propre dossier : <code>${target}</code>.`,
      action: { kind: "create_folder", path: target },
    },
    {
      title: `Télécharge ${launcherName} depuis le site officiel`,
      body: "Toujours depuis le site de l'éditeur — jamais depuis un site tiers.",
      action: { kind: "download" },
    },
    {
      title: `Installe-le dans <code>${target}</code>`,
      body: tips.installerTip,
    },
  ];
  if (tips.librarySub) {
    const lib = joinWin(target, tips.librarySub);
    steps.push({
      title: "Règle le dossier de jeux par défaut",
      body: `${tips.libraryTip} Dossier conseillé : <code>${lib}</code>.`,
      action: { kind: "create_folder", path: lib },
    });
  } else {
    steps.push({ title: "Bibliothèque de jeux", body: tips.libraryTip });
  }
  steps.push({
    title: "Ajoute-le à REZ launcher",
    body: "Relance la détection : le launcher apparaîtra comme « Détecté » et tu pourras l'ajouter à ta bibliothèque en un clic.",
    action: { kind: "rescan" },
  });
  return steps;
}
