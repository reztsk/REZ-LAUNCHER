// Accent themes (colour duos / gradients). The CSS for each lives in styles.css
// under :root[data-theme="…"]; this list drives the picker in Paramètres.
import type { ThemeId } from "./api";

export interface ThemeDef {
  id: ThemeId;
  name: string;
  hint: string;
  /** Swatch preview: [light, mid, deep]. */
  stops: [string, string, string];
}

export const THEMES: ThemeDef[] = [
  { id: "steel", name: "Acier", hint: "Noir & gris acier pur", stops: ["#ffffff", "#d4d4d8", "#71717a"] },
  { id: "cyan", name: "Cyber cyan", hint: "Cyan électrique sur gris sombre", stops: ["#cffafe", "#22d3ee", "#0e7490"] },
  { id: "neon", name: "Néon", hint: "Vert néon minimaliste", stops: ["#ecfccb", "#a3e635", "#3f6212"] },
  { id: "carbon", name: "Carbone", hint: "Carbone & argent bleuté", stops: ["#f8fafc", "#94a3b8", "#334155"] },
  { id: "ember", name: "Ambre", hint: "Ambre chaud sur graphite", stops: ["#fef3c7", "#fbbf24", "#b45309"] },
  { id: "glacier", name: "Glacier", hint: "Bleu glacier & blanc", stops: ["#e0f2fe", "#7dd3fc", "#2563eb"] },
];
