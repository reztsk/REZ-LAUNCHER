// Pure formatting helpers (unit-testable, no DOM).

/** 2535 -> "42h 15m", 45 -> "45m", 0 -> "0m". */
export function formatPlaytime(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return `${h}h ${String(r).padStart(2, "0")}m`;
}

/** Live session clock: 3725 -> "1:02:05". */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Session summary for toasts: 4320 s -> "1h 12m", 40 s -> "40 s". */
export function formatSession(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  return formatPlaytime(Math.round(seconds / 60));
}

export function formatRelative(iso: string | null, now = Date.now()): string {
  if (!iso) return "Jamais";
  const diff = (now - new Date(iso).getTime()) / 1000;
  if (Number.isNaN(diff)) return "—";
  if (diff < 60) return "À l'instant";
  if (diff < 3600) return `Il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `Il y a ${Math.floor(diff / 3600)} h`;
  const days = Math.floor(diff / 86400);
  if (days === 1) return "Hier";
  if (days < 30) return `Il y a ${days} jours`;
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

export function formatBytes(bytes: number): string {
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Escape text for safe interpolation in HTML templates. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Initials for generated covers: "Hollow Knight" -> "HK". */
export function initials(title: string): string {
  const words = title.trim().split(/[\s:\-_]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Deterministic hue from a string, for generated cover gradients. */
export function hueFrom(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
