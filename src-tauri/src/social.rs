//! Profile + friends on the LOCAL NETWORK (peer-to-peer, no server, no account).
//!
//! - Presence: every REZ launcher with "Amis" enabled broadcasts a tiny UDP
//!   packet (id, name, status, game) on the LAN every few seconds.
//! - Profiles and friend requests: one short JSON line over TCP, straight to the
//!   other PC. Everything received is size-limited and validated.
//! - Opt-in (off by default); nothing leaves the local network.
//!
//! Unrelated to games: no game file or process is touched.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::db::{Database, Friend};
use crate::error::{AppError, AppResult};
use crate::watcher::Tracker;

pub const UDP_PORT: u16 = 47_777;
pub const TCP_PORT: u16 = 47_778;
const ANNOUNCE_EVERY: Duration = Duration::from_secs(4);
const PEER_TTL: Duration = Duration::from_secs(14);
const IO_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_REQUEST: u64 = 96 * 1024;
const MAX_RESPONSE: u64 = 640 * 1024;
pub const AVATAR_MAX: usize = 64 * 1024;
pub const BANNER_MAX: usize = 256 * 1024;
const PROFILE_KEY: &str = "profile";

// ================================================================ Profile

/// An image + its framing (same model as game covers: zoom around a focal point).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ImageFrame {
    pub url: String,
    pub zoom: f64,
    pub x: f64,
    pub y: f64,
}

impl Default for ImageFrame {
    fn default() -> Self {
        Self {
            url: String::new(),
            zoom: 1.0,
            x: 50.0,
            y: 50.0,
        }
    }
}

impl ImageFrame {
    fn normalized(mut self) -> Self {
        let fix =
            |v: f64, lo: f64, hi: f64, d: f64| if v.is_finite() { v.clamp(lo, hi) } else { d };
        self.url = self.url.trim().to_string();
        self.zoom = fix(self.zoom, 1.0, 4.0, 1.0);
        self.x = fix(self.x, 0.0, 100.0, 50.0);
        self.y = fix(self.y, 0.0, 100.0, 50.0);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Profile {
    /// Random id (12 hex chars), shown as a friend code.
    pub id: String,
    pub name: String,
    pub bio: String,
    pub avatar: ImageFrame,
    pub banner: ImageFrame,
    /// Small framed renders (data URLs) sent to friends.
    pub avatar_thumb: String,
    pub banner_thumb: String,
    /// Pinned games (library ids), in display order.
    pub showcase: Vec<i64>,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "Joueur".into(),
            bio: String::new(),
            avatar: ImageFrame::default(),
            banner: ImageFrame::default(),
            avatar_thumb: String::new(),
            banner_thumb: String::new(),
            showcase: Vec::new(),
        }
    }
}

/// New random id: 12 uppercase hex chars (std only: time + pid + random hasher).
pub fn new_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    h.write_u32(std::process::id());
    format!("{:012X}", h.finish() & 0xFFFF_FFFF_FFFF)
}

pub fn valid_id(id: &str) -> bool {
    id.len() == 12
        && id
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase())
}

/// "REZ-1A2B-3C4D-5E6F"
pub fn friend_code(id: &str) -> String {
    let parts: Vec<&str> = (0..id.len())
        .step_by(4)
        .map(|i| &id[i..(i + 4).min(id.len())])
        .collect();
    format!("REZ-{}", parts.join("-"))
}

/// Accepts "REZ-1A2B-3C4D-5E6F", "1a2b3c4d5e6f", spaces, dashes.
pub fn parse_code(code: &str) -> Option<String> {
    let s: String = code
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_uppercase();
    let s = s.strip_prefix("REZ").unwrap_or(&s).to_string();
    valid_id(&s).then_some(s)
}

/// Printable text, trimmed, at most `max` chars.
pub fn clean_text(s: &str, max: usize) -> String {
    s.chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Keep a data URL only if it is a small base64 PNG/JPEG/WebP image.
pub fn clean_data_url(s: &str, max: usize) -> String {
    let ok = s.len() <= max
        && [
            "data:image/jpeg;base64,",
            "data:image/png;base64,",
            "data:image/webp;base64,",
        ]
        .iter()
        .any(|p| {
            s.strip_prefix(p).is_some_and(|b| {
                !b.is_empty()
                    && b.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'='))
            })
        });
    if ok {
        s.to_string()
    } else {
        String::new()
    }
}

/// Keep an https URL only (covers shared by friends).
pub fn clean_https(s: &str) -> String {
    let ok = s.starts_with("https://")
        && s.len() <= 600
        && !s
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '\\'));
    if ok {
        s.to_string()
    } else {
        String::new()
    }
}

impl Profile {
    /// Load (an id is created and saved on first use).
    pub fn load(db: &Database) -> Profile {
        let mut p: Profile = db
            .get_setting(PROFILE_KEY)
            .ok()
            .flatten()
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default();
        if !valid_id(&p.id) {
            p.id = new_id();
            let _ = p.save(db);
        }
        p
    }

    pub fn normalized(mut self) -> AppResult<Profile> {
        self.name = clean_text(&self.name, 32);
        if self.name.is_empty() {
            return Err(AppError::Invalid("Choisis un pseudo.".into()));
        }
        self.bio = clean_text(&self.bio, 200);
        self.avatar = self.avatar.normalized();
        self.banner = self.banner.normalized();
        self.avatar_thumb = clean_data_url(&self.avatar_thumb, AVATAR_MAX);
        self.banner_thumb = clean_data_url(&self.banner_thumb, BANNER_MAX);
        let mut seen = std::collections::HashSet::new();
        self.showcase.retain(|id| seen.insert(*id));
        self.showcase.truncate(6);
        Ok(self)
    }

    pub fn save(&self, db: &Database) -> AppResult<()> {
        db.set_setting(
            PROFILE_KEY,
            &serde_json::to_string(self).map_err(|e| AppError::Other(e.to_string()))?,
        )
    }
}

/// Standard base64 (for local images turned into data URLs).
pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            61 as char
        });
        out.push(if c.len() > 2 {
            T[n as usize & 63] as char
        } else {
            61 as char
        });
    }
    out
}

// ============================================================ Wire format

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Presence {
    rez: u8,
    id: String,
    name: String,
    /// "online" | "ingame" | "bye"
    status: String,
    #[serde(default)]
    game: String,
    port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ShowcaseItem {
    pub title: String,
    pub playtime_minutes: i64,
    /// https cover (local images are not shared).
    pub cover: String,
}

/// What a friend sees of your profile.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PublicProfile {
    pub id: String,
    pub name: String,
    pub bio: String,
    pub avatar: String,
    pub banner: String,
    pub status: String,
    pub game: String,
    pub showcase: Vec<ShowcaseItem>,
}

impl PublicProfile {
    fn sanitized(mut self) -> Self {
        self.name = clean_text(&self.name, 32);
        self.bio = clean_text(&self.bio, 200);
        self.avatar = clean_data_url(&self.avatar, AVATAR_MAX);
        self.banner = clean_data_url(&self.banner, BANNER_MAX);
        self.status = if self.status == "ingame" {
            "ingame".into()
        } else {
            "online".into()
        };
        self.game = clean_text(&self.game, 120);
        self.showcase.truncate(6);
        for s in &mut self.showcase {
            s.title = clean_text(&s.title, 120);
            s.cover = clean_https(&s.cover);
            s.playtime_minutes = s.playtime_minutes.max(0);
        }
        self
    }
}

// ================================================================== State

#[derive(Debug, Clone)]
struct Peer {
    name: String,
    status: String,
    game: String,
    addr: SocketAddr,
    seen: Instant,
}

#[derive(Debug, Clone, Serialize)]
pub struct Me {
    pub id: String,
    pub code: String,
    pub name: String,
}

/// Someone running REZ launcher on the same network.
#[derive(Debug, Clone, Serialize)]
pub struct PeerView {
    pub id: String,
    pub code: String,
    pub name: String,
    pub status: String,
    pub game: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FriendView {
    pub id: String,
    pub code: String,
    pub name: String,
    pub avatar: String,
    /// "friend" | "incoming" | "outgoing"
    pub state: String,
    /// "offline" | "online" | "ingame"
    pub status: String,
    pub game: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SocialState {
    pub enabled: bool,
    pub error: Option<String>,
    pub me: Me,
    /// On the network, not friends (yet).
    pub peers: Vec<PeerView>,
    pub friends: Vec<FriendView>,
}

/// What the network threads need from the app.
#[derive(Clone)]
pub struct Ctx {
    pub db: Arc<Database>,
    pub tracker: Arc<Tracker>,
    /// Tell the UI something changed (peers, statuses, requests).
    pub notify: Arc<dyn Fn() + Send + Sync>,
}

#[derive(Default)]
pub struct Social {
    on: AtomicBool,
    generation: AtomicU64,
    peers: Mutex<HashMap<String, Peer>>,
    tcp_port: AtomicU16,
    error: Mutex<Option<String>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// ("ingame", title) while a game runs, else ("online", "").
fn my_status(ctx: &Ctx) -> (String, String) {
    match ctx.tracker.list().first() {
        Some(r) => (
            "ingame".into(),
            ctx.db
                .get_game(r.game_id)
                .map(|g| g.title)
                .unwrap_or_default(),
        ),
        None => ("online".into(), String::new()),
    }
}

/// Your profile as friends see it.
pub fn public_profile(ctx: &Ctx) -> PublicProfile {
    let p = Profile::load(&ctx.db);
    let (status, game) = my_status(ctx);
    let showcase = p
        .showcase
        .iter()
        .filter_map(|id| ctx.db.get_game(*id).ok())
        .map(|g| ShowcaseItem {
            title: g.title,
            playtime_minutes: g.playtime_minutes,
            cover: clean_https(&g.cover_image_url),
        })
        .collect();
    PublicProfile {
        id: p.id,
        name: p.name,
        bio: p.bio,
        avatar: p.avatar_thumb,
        banner: p.banner_thumb,
        status,
        game,
        showcase,
    }
}

impl Social {
    pub fn is_on(&self) -> bool {
        self.on.load(Ordering::SeqCst)
    }

    /// Start presence + profile server (no-op if already on).
    pub fn start(self: &Arc<Self>, ctx: Ctx) {
        if self.on.swap(true, Ordering::SeqCst) {
            return;
        }
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *lock(&self.error) = None;
        let me = self.clone();
        let c = ctx.clone();
        std::thread::spawn(move || me.tcp_loop(gen, c));
        let me = self.clone();
        std::thread::spawn(move || me.udp_loop(gen, ctx));
    }

    /// Stop and say goodbye to the network.
    pub fn stop(&self) {
        if !self.on.swap(false, Ordering::SeqCst) {
            return;
        }
        self.generation.fetch_add(1, Ordering::SeqCst);
        lock(&self.peers).clear();
    }

    fn alive(&self, gen: u64) -> bool {
        self.is_on() && self.generation.load(Ordering::SeqCst) == gen
    }

    fn set_error(&self, msg: String, ctx: &Ctx) {
        *lock(&self.error) = Some(msg);
        (ctx.notify)();
    }

    fn tcp_loop(self: Arc<Self>, gen: u64, ctx: Ctx) {
        let listener =
            TcpListener::bind(("0.0.0.0", TCP_PORT)).or_else(|_| TcpListener::bind(("0.0.0.0", 0)));
        let listener = match listener {
            Ok(l) => l,
            Err(e) => return self.set_error(format!("Serveur de profil indisponible : {e}"), &ctx),
        };
        let _ = listener.set_nonblocking(true);
        self.tcp_port.store(
            listener.local_addr().map(|a| a.port()).unwrap_or(0),
            Ordering::SeqCst,
        );
        while self.alive(gen) {
            match listener.accept() {
                Ok((stream, from)) => {
                    let me = self.clone();
                    let c = ctx.clone();
                    std::thread::spawn(move || {
                        let _ = me.serve(stream, from.ip(), &c);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(150));
                }
                Err(_) => std::thread::sleep(Duration::from_millis(400)),
            }
        }
    }

    fn serve(&self, stream: TcpStream, from: IpAddr, ctx: &Ctx) -> std::io::Result<()> {
        stream.set_nonblocking(false)?;
        stream.set_read_timeout(Some(IO_TIMEOUT))?;
        stream.set_write_timeout(Some(IO_TIMEOUT))?;
        let mut line = String::new();
        BufReader::new((&stream).take(MAX_REQUEST)).read_line(&mut line)?;
        let reply = self.handle(&line, from, ctx);
        let mut w = &stream;
        w.write_all(reply.as_bytes())?;
        w.write_all(b"\n")?;
        w.flush()
    }

    /// One request from another REZ launcher -> one JSON reply.
    fn handle(&self, line: &str, from: IpAddr, ctx: &Ctx) -> String {
        let Ok(req) = serde_json::from_str::<serde_json::Value>(line) else {
            return json!({ "ok": false }).to_string();
        };
        let t = req.get("t").and_then(|v| v.as_str()).unwrap_or("");
        if t == "profile" {
            return serde_json::to_string(&public_profile(ctx)).unwrap_or_default();
        }
        let id = req
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        // Requests must come from the address that announces this id on the LAN.
        let known = lock(&self.peers)
            .get(&id)
            .is_some_and(|p| p.addr.ip() == from);
        if !valid_id(&id) || !known {
            return json!({ "ok": false, "error": "inconnu" }).to_string();
        }
        let name = clean_text(req.get("name").and_then(|v| v.as_str()).unwrap_or(""), 32);
        let avatar = clean_data_url(
            req.get("avatar").and_then(|v| v.as_str()).unwrap_or(""),
            AVATAR_MAX,
        );
        let current = ctx.db.friend_state(&id).ok().flatten();
        let reply = match t {
            "friend_req" => {
                // Both asked each other: friends right away.
                let state = match current.as_deref() {
                    Some("outgoing") | Some("friend") => "friend",
                    _ => "incoming",
                };
                let _ = ctx.db.upsert_friend(&id, &name, &avatar, state);
                json!({ "ok": true, "state": state })
            }
            "friend_ok" if current.is_some() => {
                let _ = ctx.db.upsert_friend(&id, &name, &avatar, "friend");
                json!({ "ok": true, "state": "friend" })
            }
            "unfriend" => {
                let _ = ctx.db.remove_friend(&id);
                json!({ "ok": true })
            }
            _ => json!({ "ok": false }),
        };
        (ctx.notify)();
        reply.to_string()
    }

    fn udp_loop(self: Arc<Self>, gen: u64, ctx: Ctx) {
        let sock = match UdpSocket::bind(("0.0.0.0", UDP_PORT)) {
            Ok(s) => s,
            Err(e) => {
                self.on.store(false, Ordering::SeqCst);
                return self.set_error(
                    format!("Réseau local indisponible (port {UDP_PORT} déjà utilisé ?) : {e}"),
                    &ctx,
                );
            }
        };
        let _ = sock.set_broadcast(true);
        let _ = sock.set_read_timeout(Some(Duration::from_millis(500)));
        let broadcast = SocketAddr::from((Ipv4Addr::BROADCAST, UDP_PORT));
        let mut last_sent: Option<Instant> = None;
        let mut last_status = (String::new(), String::new());
        let mut buf = [0u8; 2048];
        while self.alive(gen) {
            let me = Profile::load(&ctx.db);
            let status = my_status(&ctx);
            if last_sent.is_none_or(|t| t.elapsed() >= ANNOUNCE_EVERY) || status != last_status {
                let _ = sock.send_to(&self.packet(&me, &status.0, &status.1), broadcast);
                last_sent = Some(Instant::now());
                last_status = status;
            }
            let mut changed = false;
            if let Ok((n, from)) = sock.recv_from(&mut buf) {
                changed |= self.on_packet(&buf[..n], from.ip(), &me.id, &ctx);
            }
            let mut peers = lock(&self.peers);
            let before = peers.len();
            peers.retain(|_, p| p.seen.elapsed() < PEER_TTL);
            changed |= peers.len() != before;
            drop(peers);
            if changed {
                (ctx.notify)();
            }
        }
        let me = Profile::load(&ctx.db);
        let _ = sock.send_to(&self.packet(&me, "bye", ""), broadcast);
    }

    fn packet(&self, me: &Profile, status: &str, game: &str) -> Vec<u8> {
        serde_json::to_vec(&Presence {
            rez: 1,
            id: me.id.clone(),
            name: me.name.clone(),
            status: status.into(),
            game: game.chars().take(120).collect(),
            port: self.tcp_port.load(Ordering::SeqCst),
        })
        .unwrap_or_default()
    }

    /// Apply one presence packet. Returns true if the UI should refresh.
    fn on_packet(&self, data: &[u8], from: IpAddr, my_id: &str, ctx: &Ctx) -> bool {
        let Ok(p) = serde_json::from_slice::<Presence>(data) else {
            return false;
        };
        if p.rez != 1 || !valid_id(&p.id) || p.id == my_id || p.port == 0 {
            return false;
        }
        let mut peers = lock(&self.peers);
        if p.status == "bye" {
            return peers.remove(&p.id).is_some();
        }
        let name = clean_text(&p.name, 32);
        let status = if p.status == "ingame" {
            "ingame"
        } else {
            "online"
        }
        .to_string();
        let game = clean_text(&p.game, 120);
        let addr = SocketAddr::new(from, p.port);
        let changed = peers.get(&p.id).is_none_or(|old| {
            old.name != name || old.status != status || old.game != game || old.addr != addr
        });
        if changed {
            let _ = ctx.db.refresh_friend(&p.id, &name, "");
        }
        peers.insert(
            p.id,
            Peer {
                name,
                status,
                game,
                addr,
                seen: Instant::now(),
            },
        );
        changed
    }

    pub fn peer_addr(&self, id: &str) -> Option<SocketAddr> {
        lock(&self.peers).get(id).map(|p| p.addr)
    }

    pub fn state(&self, db: &Database) -> SocialState {
        let me = Profile::load(db);
        let friends: Vec<Friend> = db.list_friends().unwrap_or_default();
        let peers = lock(&self.peers).clone();
        let friend_views = friends
            .iter()
            .map(|f| {
                let live = peers.get(&f.id);
                FriendView {
                    id: f.id.clone(),
                    code: friend_code(&f.id),
                    name: f.name.clone(),
                    avatar: f.avatar.clone(),
                    state: f.state.clone(),
                    status: live
                        .map(|p| p.status.clone())
                        .unwrap_or_else(|| "offline".into()),
                    game: live.map(|p| p.game.clone()).unwrap_or_default(),
                }
            })
            .collect();
        let mut peer_views: Vec<PeerView> = peers
            .iter()
            .filter(|(id, _)| !friends.iter().any(|f| &f.id == *id))
            .map(|(id, p)| PeerView {
                id: id.clone(),
                code: friend_code(id),
                name: p.name.clone(),
                status: p.status.clone(),
                game: p.game.clone(),
            })
            .collect();
        peer_views.sort_by_key(|p| p.name.to_lowercase());
        SocialState {
            enabled: self.is_on(),
            error: lock(&self.error).clone(),
            me: Me {
                code: friend_code(&me.id),
                id: me.id,
                name: me.name,
            },
            peers: peer_views,
            friends: friend_views,
        }
    }
}

// ================================================================= Client

/// Send one request to another REZ launcher and read its JSON reply.
pub fn request(addr: SocketAddr, body: &serde_json::Value) -> AppResult<serde_json::Value> {
    let err = |e: std::io::Error| AppError::Other(format!("Ami injoignable : {e}"));
    let stream = TcpStream::connect_timeout(&addr, IO_TIMEOUT).map_err(err)?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).map_err(err)?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).map_err(err)?;
    let mut w = &stream;
    w.write_all(format!("{body}\n").as_bytes()).map_err(err)?;
    let mut line = String::new();
    BufReader::new((&stream).take(MAX_RESPONSE))
        .read_line(&mut line)
        .map_err(err)?;
    serde_json::from_str(&line).map_err(|_| AppError::Other("Réponse invalide.".into()))
}

/// Fetch and sanitize someone's public profile.
pub fn fetch_profile(addr: SocketAddr) -> AppResult<PublicProfile> {
    let v = request(addr, &json!({ "t": "profile" }))?;
    let p: PublicProfile =
        serde_json::from_value(v).map_err(|_| AppError::Other("Profil invalide.".into()))?;
    Ok(p.sanitized())
}

/// Our identity attached to friend requests.
pub fn identity(db: &Database, t: &str) -> serde_json::Value {
    let me = Profile::load(db);
    json!({ "t": t, "id": me.id, "name": me.name, "avatar": me.avatar_thumb })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Ctx {
        Ctx {
            db: Arc::new(Database::open_in_memory().unwrap()),
            tracker: Arc::new(Tracker::default()),
            notify: Arc::new(|| {}),
        }
    }

    #[test]
    fn base64_matches_reference() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn ids_and_codes() {
        let id = new_id();
        assert!(valid_id(&id), "{id}");
        let code = friend_code(&id);
        assert_eq!(code.len(), 18);
        assert_eq!(parse_code(&code).as_deref(), Some(id.as_str()));
        assert_eq!(
            parse_code(&code.to_lowercase().replace('-', " ")).as_deref(),
            Some(id.as_str())
        );
        assert_eq!(parse_code("REZ-1234"), None);
        assert_eq!(parse_code("REZ-ZZZZ-ZZZZ-ZZZZ"), None);
    }

    #[test]
    fn untrusted_values_are_cleaned() {
        assert_eq!(
            clean_data_url("data:image/png;base64,iVBORw0KGgo=", 100),
            "data:image/png;base64,iVBORw0KGgo="
        );
        assert_eq!(
            clean_data_url("data:image/svg+xml;base64,PHN2Zz4=", 100),
            ""
        );
        assert_eq!(clean_data_url("data:image/png;base64,<script>", 100), "");
        assert_eq!(
            clean_data_url(&format!("data:image/png;base64,{}", "A".repeat(200)), 100),
            ""
        );
        assert_eq!(clean_https("https://cdn.x/a.jpg"), "https://cdn.x/a.jpg");
        assert_eq!(clean_https("javascript:alert(1)"), "");
        assert_eq!(clean_https("https://x/\"onerror=1"), "");
        assert_eq!(clean_text("  Rez\u{7}\u{1b}  ", 32), "Rez");
        assert_eq!(clean_text(&"é".repeat(50), 32).chars().count(), 32);
    }

    #[test]
    fn profile_is_created_validated_and_saved() {
        let c = ctx();
        let p = Profile::load(&c.db);
        assert!(valid_id(&p.id));
        assert_eq!(Profile::load(&c.db).id, p.id, "id is stable");
        let mut edit = p.clone();
        edit.name = "   ".into();
        assert!(edit.clone().normalized().is_err());
        edit.name = "REZ".into();
        edit.showcase = vec![3, 3, 1, 2, 4, 5, 6, 7];
        edit.avatar.zoom = 99.0;
        edit.avatar_thumb = "data:text/html;base64,AAAA".into();
        let n = edit.normalized().unwrap();
        assert_eq!(n.showcase, vec![3, 1, 2, 4, 5, 6]);
        assert_eq!(n.avatar.zoom, 4.0);
        assert_eq!(n.avatar_thumb, "");
    }

    #[test]
    fn presence_packets_and_friend_requests() {
        let c = ctx();
        let social = Social::default();
        let me = Profile::load(&c.db);
        let ip: IpAddr = "192.168.1.20".parse().unwrap();
        let pkt = |id: &str, status: &str| {
            serde_json::to_vec(
                &json!({"rez":1,"id":id,"name":"Ami","status":status,"game":"Hades","port":47778}),
            )
            .unwrap()
        };
        let friend = "0A1B2C3D4E5F";
        assert!(
            !social.on_packet(&pkt(&me.id, "online"), ip, &me.id, &c),
            "own packet ignored"
        );
        assert!(!social.on_packet(b"{not json", ip, &me.id, &c));
        assert!(social.on_packet(&pkt(friend, "ingame"), ip, &me.id, &c));
        assert!(
            !social.on_packet(&pkt(friend, "ingame"), ip, &me.id, &c),
            "no change"
        );
        let st = social.state(&c.db);
        assert_eq!(st.peers.len(), 1);
        assert_eq!(
            (st.peers[0].status.as_str(), st.peers[0].game.as_str()),
            ("ingame", "Hades")
        );

        // Request from another IP claiming that id: refused.
        let req = json!({"t":"friend_req","id":friend,"name":"Ami","avatar":""}).to_string();
        let spoof: IpAddr = "192.168.1.66".parse().unwrap();
        assert!(social.handle(&req, spoof, &c).contains("false"));
        // From the right IP: incoming request.
        assert!(social.handle(&req, ip, &c).contains("incoming"));
        assert_eq!(
            c.db.friend_state(friend).unwrap().as_deref(),
            Some("incoming")
        );
        let st = social.state(&c.db);
        assert!(st.peers.is_empty());
        assert_eq!(st.friends[0].status, "ingame");

        // We asked them first -> their request makes us friends.
        c.db.upsert_friend(friend, "Ami", "", "outgoing").unwrap();
        assert!(social.handle(&req, ip, &c).contains("\"friend\""));
        let bye = social.handle(&json!({"t":"unfriend","id":friend}).to_string(), ip, &c);
        assert!(bye.contains("true"));
        assert!(c.db.friend_state(friend).unwrap().is_none());

        assert!(social.on_packet(&pkt(friend, "bye"), ip, &me.id, &c));
        assert!(social.state(&c.db).peers.is_empty());
    }

    #[test]
    fn serves_public_profile_over_tcp() {
        let c = ctx();
        let mut p = Profile::load(&c.db);
        p.name = "Rez".into();
        p.bio = "GG".into();
        p.save(&c.db).unwrap();
        let social = Arc::new(Social::default());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let s2 = social.clone();
        let c2 = c.clone();
        let server = std::thread::spawn(move || {
            let (stream, from) = listener.accept().unwrap();
            s2.serve(stream, from.ip(), &c2).unwrap();
        });
        let got = fetch_profile(addr).unwrap();
        server.join().unwrap();
        assert_eq!(
            (got.name.as_str(), got.bio.as_str(), got.status.as_str()),
            ("Rez", "GG", "online")
        );
        assert_eq!(got.id, p.id);
    }
}
