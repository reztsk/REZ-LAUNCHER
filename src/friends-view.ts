// Friends on the local network: presence (online / in game / offline),
// requests by friend code, live profiles. Opt-in, no account, no server.
import { api, type FriendView, type PeerView, type Presence, type SocialState } from "./api";
import { coverHtml } from "./covers";
import { esc, formatPlaytime } from "./format";
import { icon } from "./icons";
import { remoteAvatar } from "./profile-view";
import { confirmModal, errorToast, openModal, toast } from "./ui";

export interface FriendsCtx {
  social: () => SocialState | null;
  setEnabled: (on: boolean) => Promise<void>;
  refresh: () => Promise<void>;
}

const STATUS_LABEL: Record<Presence, string> = { ingame: "En jeu", online: "En ligne", offline: "Hors ligne" };

export function statusLine(s: Presence, game: string): string {
  return s === "ingame" && game ? `Joue à <b class="text-white/90">${esc(game)}</b>` : STATUS_LABEL[s];
}

function friendRow(f: FriendView): string {
  const actions =
    f.state === "incoming"
      ? `<button class="btn btn-primary btn-sm" data-act="accept">${icon.check}Accepter</button>
         <button class="btn btn-ghost btn-sm" data-act="decline">Refuser</button>`
      : f.state === "outgoing"
        ? `<span class="text-xs text-muted">En attente…</span>
           <button class="btn btn-ghost btn-sm" data-act="remove" title="Annuler la demande">${icon.x}</button>`
        : `<button class="btn btn-ghost btn-sm" data-act="profile" ${f.status === "offline" ? "disabled" : ""}>${icon.user}Profil</button>
           <button class="opt-toggle" data-act="remove" title="Retirer des amis">${icon.trash}</button>`;
  return `
    <div class="fr-row" data-id="${esc(f.id)}">
      <span class="relative shrink-0">${remoteAvatar(f.name, f.avatar)}<i class="presence ${f.status}"></i></span>
      <div class="min-w-0 flex-1">
        <p class="truncate font-semibold">${esc(f.name)}</p>
        <p class="truncate text-xs text-muted">${f.state === "incoming" ? "Veut t'ajouter en ami" : statusLine(f.status, f.game)}</p>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">${actions}</div>
    </div>`;
}

function peerRow(p: PeerView): string {
  return `
    <div class="fr-row" data-id="${esc(p.id)}">
      <span class="relative shrink-0">${remoteAvatar(p.name, "")}<i class="presence ${p.status}"></i></span>
      <div class="min-w-0 flex-1">
        <p class="truncate font-semibold">${esc(p.name)}</p>
        <p class="truncate text-xs text-muted">${statusLine(p.status, p.game)}</p>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <button class="btn btn-ghost btn-sm" data-act="profile">${icon.user}Profil</button>
        <button class="btn btn-primary btn-sm" data-act="add">${icon.userPlus}Ajouter</button>
      </div>
    </div>`;
}

function group(title: string, rows: string[]): string {
  return rows.length
    ? `<div class="mt-6"><p class="label">${title} · ${rows.length}</p><div class="fr-list glass">${rows.join("")}</div></div>`
    : "";
}

export function renderFriends(view: HTMLElement, ctx: FriendsCtx): void {
  const st = ctx.social();
  if (!st) {
    view.innerHTML = `<div class="grid h-full place-items-center text-sm text-muted"><span class="flex items-center gap-2"><span class="animate-spin">${icon.refresh}</span>Chargement…</span></div>`;
    void ctx.refresh();
    return;
  }
  const friends = st.friends.filter((f) => f.state === "friend");
  const order: Presence[] = ["ingame", "online", "offline"];
  friends.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.name.localeCompare(b.name, "fr"));
  const requests = st.friends.filter((f) => f.state !== "friend");
  const online = friends.filter((f) => f.status !== "offline").length;

  view.innerHTML = `
    <div class="mx-auto max-w-[980px] px-10 pb-16 pt-8">
      <header class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 class="font-display text-[34px] font-bold tracking-tight">Amis</h1>
          <p class="mt-1 text-sm text-muted">${
            st.enabled ? `${online} ami${online > 1 ? "s" : ""} en ligne · réseau local, sans compte ni serveur` : "Réseau local, sans compte ni serveur."
          }</p>
        </div>
        <label class="flex items-center gap-3 text-sm">
          <span class="text-muted">${st.enabled ? "Visible sur le réseau" : "Désactivé"}</span>
          <button class="switch" role="switch" aria-checked="${st.enabled}" data-act="toggle" aria-label="Activer les amis"></button>
        </label>
      </header>

      ${st.error ? `<div class="fr-error mt-5">${icon.info}<span>${esc(st.error)}</span></div>` : ""}

      ${
        st.enabled
          ? ""
          : `<section class="glass mt-6 rounded-3xl p-7">
              <div class="flex items-start gap-5">
                <div class="icon-tile h-14 w-14 shrink-0 [&_.icon]:h-7 [&_.icon]:w-7">${icon.users}</div>
                <div>
                  <h2 class="font-display text-xl font-bold">Joue avec tes potes du même réseau</h2>
                  <p class="mt-2 max-w-[620px] text-sm leading-relaxed text-muted">
                    Une fois activé, REZ launcher annonce ton pseudo et ton statut (en ligne, en jeu) aux autres REZ launcher de ton réseau local (même box / même Wi-Fi), et peut leur montrer ton profil et ta vitrine. Rien ne sort de ton réseau, aucun compte n'est créé.
                    Windows peut te demander d'autoriser REZ launcher dans le pare-feu : choisis « Réseaux privés ».
                  </p>
                  <button class="btn btn-primary mt-5" data-act="toggle">${icon.users}Activer les amis</button>
                </div>
              </div>
            </section>`
      }

      <section class="mt-6 grid gap-4 md:grid-cols-[1fr_1.2fr]">
        <div class="glass rounded-2xl p-5">
          <p class="label">Ton code ami</p>
          <div class="flex items-center gap-2">
            <code class="code-big">${esc(st.me.code)}</code>
            <button class="opt-toggle" data-act="copy" title="Copier">${icon.copy}</button>
          </div>
          <p class="mt-2 text-xs text-muted">Donne-le à un ami sur le même réseau pour qu'il t'ajoute.</p>
        </div>
        <form class="glass rounded-2xl p-5" id="fr-add" autocomplete="off">
          <label class="label" for="fr-code">Ajouter avec un code</label>
          <div class="flex gap-2">
            <input id="fr-code" class="field" placeholder="REZ-XXXX-XXXX-XXXX" spellcheck="false" ${st.enabled ? "" : "disabled"} />
            <button class="btn btn-primary shrink-0" ${st.enabled ? "" : "disabled"}>${icon.userPlus}Ajouter</button>
          </div>
          <p class="mt-2 text-xs text-muted">Ton ami doit avoir REZ launcher ouvert, avec les amis activés.</p>
        </form>
      </section>

      ${group("Demandes", requests.map(friendRow))}
      ${group("Amis", friends.map(friendRow))}
      ${st.enabled ? group("Sur ton réseau", st.peers.map(peerRow)) : ""}
      ${
        st.enabled && !friends.length && !requests.length && !st.peers.length
          ? `<p class="mt-10 text-center text-sm text-muted">Personne d'autre n'utilise REZ launcher sur ton réseau pour l'instant.</p>`
          : ""
      }
    </div>`;

  view.querySelector<HTMLFormElement>("#fr-add")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = view.querySelector<HTMLInputElement>("#fr-code")!;
    const code = input.value.trim();
    if (!code) return;
    try {
      const res = await api.addFriend(code);
      input.value = "";
      toast(res === "friend" ? "Vous êtes amis !" : "Demande envoyée", res === "friend" ? "" : "Elle s'affiche chez ton ami.");
    } catch (err) {
      errorToast(err, "Ajout impossible");
    }
  });

  // Listen on the freshly rendered root: #view itself outlives renders.
  view.firstElementChild!.addEventListener("click", async (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!el) return;
    const id = el.closest<HTMLElement>("[data-id]")?.dataset.id ?? "";
    const who = st.friends.find((f) => f.id === id) ?? st.peers.find((p) => p.id === id);
    try {
      switch (el.dataset.act) {
        case "toggle":
          return await ctx.setEnabled(!st.enabled);
        case "copy":
          try {
            await navigator.clipboard.writeText(st.me.code);
            toast("Code ami copié", st.me.code);
          } catch {
            toast("Ton code ami", st.me.code);
          }
          return;
        case "add":
          await api.addFriend(id);
          return toast("Demande envoyée", who?.name ?? "");
        case "accept":
          await api.answerFriend(id, true);
          return toast("Nouvel ami", who?.name ?? "");
        case "decline":
          return await api.answerFriend(id, false);
        case "remove": {
          const pending = who && "state" in who && who.state !== "friend";
          if (!pending) {
            const ok = await confirmModal("Retirer cet ami ?", `<b class="text-white">${esc(who?.name ?? "")}</b> ne verra plus ton statut dans sa liste d'amis.`, "Retirer");
            if (!ok) return;
          }
          return await api.removeFriend(id);
        }
        case "profile":
          return await showFriendProfile(id);
      }
    } catch (err) {
      errorToast(err);
    }
  });
}

/** Live profile of someone on the network. */
export async function showFriendProfile(id: string): Promise<void> {
  const p = await api.friendProfile(id);
  openModal(
    p.name,
    `<div class="pf-mini">
      <div class="pf-mini-banner">${p.banner ? `<img src="${esc(p.banner)}" alt="" />` : ""}</div>
      <div class="flex items-end gap-4 px-1">
        ${remoteAvatar(p.name, p.avatar, "lg pf-mini-avatar")}
        <div class="min-w-0 pb-1">
          <p class="truncate font-display text-xl font-bold">${esc(p.name)}</p>
          <p class="text-xs text-muted"><i class="presence inline ${p.status}"></i> ${statusLine(p.status, p.game)}</p>
        </div>
      </div>
      ${p.bio ? `<p class="mt-4 whitespace-pre-line text-sm text-muted">${esc(p.bio)}</p>` : ""}
      <p class="label mt-6">Vitrine</p>
      ${
        p.showcase.length
          ? `<div class="grid grid-cols-3 gap-3">${p.showcase
              .map(
                (s) => `<div><div class="cover">${coverHtml({ title: s.title, cover_image_url: s.cover, cover_zoom: 1, cover_x: 50, cover_y: 50 })}</div>
                  <p class="mt-1.5 truncate text-xs font-semibold">${esc(s.title)}</p>
                  <p class="text-[11px] text-muted">${s.playtime_minutes > 0 ? formatPlaytime(s.playtime_minutes) : "—"}</p></div>`,
              )
              .join("")}</div>`
          : `<p class="text-sm text-muted">Vitrine vide.</p>`
      }
    </div>`,
  );
}
