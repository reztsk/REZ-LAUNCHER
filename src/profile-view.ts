// Profile page: banner + picture (framed in the image editor), bio, friend code
// and a showcase of pinned games displayed as 3D boxes.
import { api, type Game, type ImageFrame, type Profile } from "./api";
import { boxHtml } from "./box3d";
import { openCoverEditor } from "./cover-editor";
import { coverHtml, type CoverLike } from "./covers";
import { esc, formatPlaytime, formatRelative, initials } from "./format";
import { icon } from "./icons";
import { framedThumb } from "./thumbs";
import { errorToast, openModal, toast } from "./ui";

export const SHOWCASE_MAX = 6;

export interface ProfileCtx {
  profile: () => Profile;
  games: () => Game[];
  /** Friend code ("REZ-XXXX-XXXX-XXXX"). */
  code: () => string;
  save: (p: Profile) => Promise<void>;
  openBox: (g: Game) => void;
}

const asCover = (f: ImageFrame, title: string): CoverLike => ({
  title,
  cover_image_url: f.url,
  cover_zoom: f.zoom,
  cover_x: f.x,
  cover_y: f.y,
});

/** Round profile picture (framed image, or initials). */
export function avatarHtml(p: Pick<Profile, "name" | "avatar">, cls = ""): string {
  return `<span class="avatar ${cls}">${
    p.avatar.url ? coverHtml(asCover(p.avatar, p.name), false) : `<b>${esc(initials(p.name))}</b>`
  }</span>`;
}

/** Same, from a friend's shared data URL. */
export function remoteAvatar(name: string, dataUrl: string, cls = ""): string {
  return `<span class="avatar ${cls}">${
    dataUrl ? `<img src="${esc(dataUrl)}" alt="" draggable="false" />` : `<b>${esc(initials(name))}</b>`
  }</span>`;
}

export function showcaseGames(p: Profile, games: Game[]): Game[] {
  return p.showcase.map((id) => games.find((g) => g.id === id)).filter((g): g is Game => !!g);
}

export function renderProfile(view: HTMLElement, ctx: ProfileCtx): void {
  const p = ctx.profile();
  const games = ctx.games();
  const pinned = showcaseGames(p, games);
  const library = games.filter((g) => g.kind === "game" && g.category !== "launcher");
  const top = [...library].sort((a, b) => b.playtime_minutes - a.playtime_minutes)[0];
  const last = [...library].filter((g) => g.last_played_at).sort((a, b) => b.last_played_at!.localeCompare(a.last_played_at!))[0];

  view.innerHTML = `
    <div class="mx-auto max-w-[1240px] px-10 pb-16 pt-8">
      <section class="pf glass">
        <div class="pf-banner" data-act="banner" title="Modifier la bannière">
          ${p.banner.url ? coverHtml(asCover(p.banner, p.name), false) : `<div class="pf-banner-empty"></div>`}
          <span class="pf-edit">${icon.image}Bannière</span>
        </div>
        <div class="pf-row">
          <button class="pf-avatar" data-act="avatar" title="Modifier la photo de profil">
            ${avatarHtml(p, "xl")}
            <span class="pf-avatar-edit">${icon.image}</span>
          </button>
          <div class="min-w-0 flex-1 pt-3">
            <h1 class="truncate font-display text-[30px] font-bold tracking-tight">${esc(p.name)}</h1>
            <p class="mt-1 max-w-[640px] whitespace-pre-line text-sm text-muted">${p.bio ? esc(p.bio) : "Ajoute une bio depuis « Modifier le profil »."}</p>
          </div>
          <div class="flex shrink-0 items-center gap-2 pt-4">
            <button class="code-chip" data-act="copy" title="Copier ton code ami">${icon.users}<span>${esc(ctx.code())}</span></button>
            <button class="btn btn-ghost" data-act="edit">${icon.edit}Modifier le profil</button>
          </div>
        </div>
      </section>

      <section class="mt-8">
        <div class="flex items-end justify-between gap-4">
          <div>
            <h2 class="font-display text-xl font-bold">Vitrine</h2>
            <p class="mt-0.5 text-sm text-muted">Tes jeux préférés, épinglés sur ton profil (${pinned.length}/${SHOWCASE_MAX}). Tes amis la voient aussi.</p>
          </div>
          <button class="btn btn-ghost" data-act="showcase">${icon.pin}Gérer la vitrine</button>
        </div>
        ${
          pinned.length
            ? `<div class="shelf mt-6">${pinned
                .map(
                  (g, i) => `
              <button class="shelf-item" data-game="${g.id}" style="--i:${i}" title="Voir la boîte 3D">
                ${boxHtml(g, { w: 150, cls: "shelf-box" })}
                <span class="mt-4 block truncate text-sm font-semibold">${esc(g.title)}</span>
                <span class="block text-xs text-muted">${g.playtime_minutes > 0 ? `${formatPlaytime(g.playtime_minutes)} jouées` : "Jamais lancé"}</span>
              </button>`,
                )
                .join("")}</div>`
            : `<div class="empty glass mt-6 flex flex-col items-center rounded-3xl px-8 py-12 text-center">
                <div class="icon-tile h-14 w-14 [&_.icon]:h-7 [&_.icon]:w-7">${icon.pin}</div>
                <h3 class="mt-4 font-display text-lg font-bold">Ta vitrine est vide</h3>
                <p class="mt-1 max-w-md text-sm text-muted">Épingle jusqu'à ${SHOWCASE_MAX} jeux, ici ou depuis le menu d'options d'un jeu.</p>
                <button class="btn btn-primary mt-5" data-act="showcase">${icon.pin}Choisir mes jeux</button>
              </div>`
        }
      </section>

      <section class="mt-8 grid gap-4 md:grid-cols-3">
        <div class="stat glass"><span>Jeux dans la bibliothèque</span><b>${library.length}</b></div>
        <div class="stat glass"><span>Jeu le plus joué</span><b class="truncate">${top && top.playtime_minutes > 0 ? esc(top.title) : "—"}</b>${
          top && top.playtime_minutes > 0 ? `<small>${formatPlaytime(top.playtime_minutes)}</small>` : ""
        }</div>
        <div class="stat glass"><span>Dernier jeu lancé</span><b class="truncate">${last ? esc(last.title) : "—"}</b>${
          last ? `<small>${esc(formatRelative(last.last_played_at))}</small>` : ""
        }</div>
      </section>
    </div>`;

  view.querySelectorAll<HTMLElement>("[data-game]").forEach((b) =>
    b.addEventListener("click", () => {
      const g = games.find((x) => x.id === Number(b.dataset.game));
      if (g) ctx.openBox(g);
    }),
  );
  // Listen on the freshly rendered root: #view itself outlives renders.
  view.firstElementChild!.addEventListener("click", async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "avatar" || act === "banner") return editImage(act, ctx);
    if (act === "edit") return editProfile(ctx);
    if (act === "showcase") return manageShowcase(ctx);
    if (act === "copy") {
      try {
        await navigator.clipboard.writeText(ctx.code());
        toast("Code ami copié", ctx.code());
      } catch {
        toast("Ton code ami", ctx.code());
      }
    }
  });
}

/** Picture or banner: image editor, then a small framed render for friends. */
export async function editImage(which: "avatar" | "banner", ctx: ProfileCtx): Promise<void> {
  const p = ctx.profile();
  const res = await openCoverEditor(asCover(p[which], p.name), {
    pickImage: () => api.pickCover(),
    shape: which,
    heading: which === "avatar" ? "Photo de profil" : "Bannière du profil",
  });
  if (!res) return;
  const frame: ImageFrame = { url: res.cover_image_url, zoom: res.cover_zoom, x: res.cover_x, y: res.cover_y };
  const thumb = which === "avatar" ? await framedThumb(frame, 160, 160) : await framedThumb(frame, 800, 200, 0.78);
  try {
    await ctx.save({ ...p, [which]: frame, [`${which}_thumb`]: thumb });
    toast(which === "avatar" ? "Photo de profil mise à jour" : "Bannière mise à jour");
  } catch (err) {
    errorToast(err, "Enregistrement impossible");
  }
}

function editProfile(ctx: ProfileCtx): void {
  const p = ctx.profile();
  const m = openModal(
    "Modifier le profil",
    `<form id="pf-form" class="flex flex-col gap-4" autocomplete="off">
      <div><label class="label" for="pf-name">Pseudo</label>
        <input id="pf-name" name="name" class="field" value="${esc(p.name)}" maxlength="32" required autofocus /></div>
      <div><label class="label" for="pf-bio">Bio</label>
        <textarea id="pf-bio" name="bio" class="field !h-24 resize-none !py-2.5 leading-snug" maxlength="200" placeholder="Tes jeux du moment, ton style de jeu…">${esc(p.bio)}</textarea></div>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn btn-ghost btn-sm" data-img="avatar">${icon.image}Photo de profil…</button>
        <button type="button" class="btn btn-ghost btn-sm" data-img="banner">${icon.image}Bannière…</button>
      </div>
      <div class="mt-1 flex justify-end gap-2 border-t border-white/5 pt-4">
        <button type="button" class="btn btn-ghost" data-close>Annuler</button>
        <button type="submit" class="btn btn-primary">${icon.check}Enregistrer</button>
      </div>
    </form>`,
  );
  const form = m.el.querySelector<HTMLFormElement>("#pf-form")!;
  m.el.querySelectorAll<HTMLElement>("[data-img]").forEach((b) =>
    b.addEventListener("click", () => {
      m.close();
      void editImage(b.dataset.img as "avatar" | "banner", ctx);
    }),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await ctx.save({ ...ctx.profile(), name: String(fd.get("name") ?? ""), bio: String(fd.get("bio") ?? "") });
      m.close();
      toast("Profil enregistré");
    } catch (err) {
      errorToast(err, "Enregistrement impossible");
    }
  });
}

/** Pick up to 6 games; the order of selection is the display order. */
export function manageShowcase(ctx: ProfileCtx): void {
  const pickable = ctx
    .games()
    .filter((g) => g.kind === "game" && g.category !== "launcher")
    .sort((a, b) => a.title.localeCompare(b.title, "fr", { sensitivity: "base" }));
  const chosen = [...ctx.profile().showcase].filter((id) => pickable.some((g) => g.id === id));
  const m = openModal(
    "Gérer la vitrine",
    `<p class="text-sm text-muted">Coche jusqu'à ${SHOWCASE_MAX} jeux. L'ordre de sélection est l'ordre d'affichage.</p>
     <div class="sc-list mt-4" id="sc-list"></div>
     <div class="mt-5 flex items-center justify-between gap-2 border-t border-white/5 pt-4">
       <span class="text-xs text-muted" id="sc-count"></span>
       <div class="flex gap-2">
         <button class="btn btn-ghost" data-close>Annuler</button>
         <button class="btn btn-primary" id="sc-save">${icon.check}Enregistrer</button>
       </div>
     </div>`,
    undefined,
    { wide: true },
  );
  const list = m.el.querySelector<HTMLElement>("#sc-list")!;
  const draw = () => {
    list.innerHTML = pickable.length
      ? pickable
          .map((g) => {
            const pos = chosen.indexOf(g.id);
            const full = pos < 0 && chosen.length >= SHOWCASE_MAX;
            return `<button class="sc-item ${pos >= 0 ? "on" : ""}" data-id="${g.id}" ${full ? "disabled" : ""}>
              <span class="cover sc-cover">${coverHtml(g)}</span>
              <span class="min-w-0 flex-1 text-left"><b class="block truncate text-sm">${esc(g.title)}</b>
              <small class="text-xs text-muted">${g.playtime_minutes > 0 ? `${formatPlaytime(g.playtime_minutes)} jouées` : "Jamais lancé"}</small></span>
              <i class="sc-check">${pos >= 0 ? pos + 1 : ""}</i>
            </button>`;
          })
          .join("")
      : `<p class="py-6 text-center text-sm text-muted">Ajoute d'abord des jeux à ta bibliothèque.</p>`;
    m.el.querySelector("#sc-count")!.textContent = `${chosen.length}/${SHOWCASE_MAX} épinglés`;
  };
  list.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    if (!b) return;
    const id = Number(b.dataset.id);
    const i = chosen.indexOf(id);
    if (i >= 0) chosen.splice(i, 1);
    else if (chosen.length < SHOWCASE_MAX) chosen.push(id);
    draw();
  });
  m.el.querySelector("#sc-save")!.addEventListener("click", async () => {
    try {
      await ctx.save({ ...ctx.profile(), showcase: chosen });
      m.close();
      toast("Vitrine mise à jour", `${chosen.length} jeu${chosen.length > 1 ? "x" : ""} épinglé${chosen.length > 1 ? "s" : ""}`);
    } catch (err) {
      errorToast(err, "Enregistrement impossible");
    }
  });
  draw();
}
