// Sharing a session with people on the tailnet, and joining theirs (see internal/collab).
//
// The person sharing keeps their pane as it is; their app serves the session to the others.
// Everyone in it, the person sharing too, has a presence connection per pane: who is there,
// where each of them points, what they selected, who just typed, the session's size (a
// guest's screen is drawn at it) and the ports it listens on (forwarded to a guest's
// localhost as they appear).
import { useSyncExternalStore } from "react";
import { call, errText, on, type Port } from "./api";
import { focusPane, getState, openJoinedTab, paneForSession, tabMachine, toast, updateTab, type Tab } from "./store";

export interface Person {
  login?: string;
  name: string;
  device?: string;
  avatar?: string;
}
export interface Member {
  id: string; // one per pane showing the session
  who: string; // the person, to change their role or remove them
  name: string;
  login?: string;
  device?: string;
  avatar?: string;
  color: string;
  host?: boolean;
  canType: boolean;
}
export interface SessionInfo {
  title?: string;
  where?: string;
  folder?: string;
  branch?: string;
  agent?: string;
  state?: string;
  gone?: boolean;
  mouse?: boolean;
  alt?: boolean;
  scrollKey?: boolean;
}
export interface ShareInfo {
  id: string;
  title: string;
  by: Person;
  role: "edit" | "view";
  code?: string; // the code they came with, to pass on
  info: SessionInfo;
  cols: number; // the session's size
  rows: number;
}
export interface JoinInfo {
  id: string;
  link: string;
  share: ShareInfo;
  term: string;
  presence: string;
}
export interface ShareView {
  id: string;
  machine: string;
  session: string;
  title: string;
  editCode: string; // 7KX-4PQ: people with it can type
  viewCode: string; // people with it can watch
  editLink: string; // the same as a link: lungo://join/7KX-4PQ
  viewLink: string;
}
export interface ShareState {
  id: string;
  machine: string;
  session: string;
  title: string;
  people: Member[];
}

export const collabApi = {
  share: (machine: string, session: string, title: string) => call<ShareView>("ShareSession", machine, session, title),
  shares: () => call<ShareView[]>("Shares"),
  stop: (id: string) => call<void>("StopSharing", id),
  setRole: (id: string, who: string, canType: boolean) => call<void>("SetShareRole", id, who, canType),
  remove: (id: string, who: string) => call<void>("RemoveFromShare", id, who),
  local: () => call<{ watch: string; presence: string }>("CollabLocal"),
  join: (link: string) => call<JoinInfo>("JoinShare", link),
  leave: (id: string) => call<void>("LeaveShare", id),
  forward: (id: string, port: number) => call<string>("ForwardSharedPort", id, port),
  pendingLink: () => call<string>("PendingLink"),
};

/** A person's initials, for their avatar. */
export const initials = (name: string) =>
  (name.trim().split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("") || "?").toUpperCase();

/** How someone is called in a sentence: their first name. */
export const firstName = (name?: string) => (name ?? "").trim().split(/\s+/)[0] || "Someone";

// ---------- the shares this computer has (any window may run the hub) ----------

let shares: ShareState[] = [];
let local: { watch: string; presence: string } | null = null;
const shareSubs = new Set<() => void>();
const shareSub = (f: () => void) => {
  shareSubs.add(f);
  return () => shareSubs.delete(f);
};

/** Every share of this computer's sessions, with who is in each right now. */
export const useShares = () => useSyncExternalStore(shareSub, () => shares);

export const shareFor = (machine?: string, session?: string, list: ShareState[] = shares) =>
  machine && session ? list.find((s) => s.machine === machine && s.session === session) : undefined;

/** The share of a pane's session, while it is shared. */
export function useShareOf(tab: Tab): ShareState | undefined {
  const list = useShares();
  return tab.kind === "joined" ? undefined : shareFor(tabMachine(tab), tab.session, list);
}

function setShares(next: ShareState[]) {
  const before = shares;
  shares = next;
  shareSubs.forEach((f) => f());
  // Someone came in: the window showing that session says so (or the first window, when none does).
  for (const s of next) {
    const was = new Set((before.find((b) => b.id === s.id)?.people ?? []).map((m) => m.who));
    const came = s.people.filter((m) => !m.host && !was.has(m.who));
    if (!came.length || !before.length) continue;
    const pane = paneForSession(s.machine, s.session);
    if (!pane && !getState().win.primary) continue;
    const names = [...new Set(came.map((m) => firstName(m.name)))].join(" and ");
    toast("info", `${names} joined`, s.title || s.session);
  }
}

let watching = false;
/** Keeps this window's view of the shares up to date (from wherever the hub runs). */
export function watchShares() {
  if (watching) return;
  watching = true;
  let tries = 0;
  const connect = async () => {
    try {
      local ??= await collabApi.local();
    } catch {
      window.setTimeout(connect, 5000);
      return;
    }
    const ws = new WebSocket(local.watch);
    ws.onopen = () => (tries = 0);
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data as string);
        if (m.t === "shares") setShares(m.shares ?? []);
      } catch {
        /* not for us */
      }
    };
    ws.onclose = () => {
      // The window running the hub went away; another takes over in a moment.
      window.setTimeout(connect, Math.min(10_000, 1000 * ++tries));
    };
  };
  void connect();
  // A lungo:// link opened the app (or was clicked while it runs).
  const pending = () =>
    collabApi.pendingLink().then(
      (link) => void (link && openJoin(link, true)),
      () => {},
    );
  on("collab:link", pending);
  pending();
}

// ---------- sharing ----------

/** Shares a pane's session (or finds its share): its codes and links. */
export async function shareOf(tab: Tab, title: string): Promise<ShareView | undefined> {
  const machine = tabMachine(tab);
  if (!machine || !tab.session) return;
  try {
    return await collabApi.share(machine, tab.session, title);
  } catch (e) {
    toast("error", "Couldn't share this session", errText(e));
  }
}

/** Shares a pane's session and copies its link: one to type along, or to watch. */
export async function shareTab(tab: Tab, title: string, role: "edit" | "view" = "edit") {
  const v = await shareOf(tab, title);
  if (v) await copyLink(v, role, true);
}

/** Copies a share's link; quiet: the panel showing the code says so itself. */
export async function copyLink(v: ShareView, role: "edit" | "view", say = false) {
  await call("CopyText", role === "edit" ? v.editLink : v.viewLink);
  if (!say) return;
  const code = role === "edit" ? v.editCode : v.viewCode;
  toast(
    "success",
    role === "edit" ? "Invite link copied" : "Watch-only link copied",
    role === "edit" ? `Send it, or tell them the code ${code}. They can type in this session, as you.` : `Send it, or tell them the code ${code}. They can watch this session and open its ports.`,
  );
}

// ---------- joining ----------

const joins = new Map<string, JoinInfo>(); // pane key → the share it joined
const justJoined = new Map<string, JoinInfo>(); // link → what joining it said a moment ago

/** What a joined pane joined: asked again each time it connects (the app may have restarted). */
export async function joinOf(tab: Tab): Promise<JoinInfo> {
  const link = tab.join!.link;
  const fresh = justJoined.get(link);
  justJoined.delete(link);
  const j = fresh ?? (await collabApi.join(link));
  joins.set(tab.key, j);
  return j;
}
export const knownJoin = (key: string) => joins.get(key);

/** Joins a share from its code or link, in a pane of its own (it throws when that can't be done). */
export async function joinLink(link: string) {
  const j = await collabApi.join(link);
  justJoined.set(j.link, j); // the pane connects with it rather than asking again
  window.setTimeout(() => justJoined.delete(j.link), 10_000);
  openJoinedTab({ link: j.link, id: j.id, title: j.share.info.title || j.share.title, by: j.share.by.name, role: j.share.role, code: j.share.code });
}

// ---------- codes ----------

/** The characters codes are made of: none that are read as another (0/O, 1/I/L). */
export const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** A code as typed ("7kx-4pq", "7KX 4PQ"): the six characters, or "" when it isn't one. */
export function normalCode(s: string): string {
  const c = s.toUpperCase().replace(/[\s-]/g, "");
  return c.length === 6 && [...c].every((ch) => CODE_CHARS.includes(ch)) ? c : "";
}

/** What was pasted or typed, read as an invite: a code (shown as 7KX-4PQ), a whole link, or nothing. */
export function readInvite(s: string): { code?: string; link?: string } {
  const t = s.trim();
  const link = /lungo:\/\/join\/[^\s<>"']+/i.exec(t)?.[0];
  if (link) {
    const code = normalCode(link.replace(/^lungo:\/\/join\//i, "").replace(/\/$/, ""));
    return code ? { code } : { link };
  }
  const code = normalCode(t) || normalCode(/\b[2-9a-hjkmnp-z]{3}-[2-9a-hjkmnp-z]{3}\b/i.exec(t)?.[0] ?? "");
  return code ? { code } : {};
}

export const showCode = (c: string) => (c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c);

// ---------- the join box ----------

export interface JoinAsk {
  value: string; // what it opens with: a code or a link
  go: boolean; // join at once (a link was clicked)
  clip: boolean; // the value was on the clipboard
  n: number;
}
let joinAsk: JoinAsk | null = null;
let joinN = 0;
const joinSubs = new Set<() => void>();

/** The join box: type a code or paste a link. A value starts it with that; go joins at once. */
export function openJoin(value = "", go = false, clip = false) {
  joinAsk = { value, go: go && !!value, clip: clip && !!value, n: ++joinN };
  joinSubs.forEach((f) => f());
}
export function closeJoin() {
  joinAsk = null;
  joinSubs.forEach((f) => f());
}
export const useJoinAsk = () =>
  useSyncExternalStore(
    (f) => {
      joinSubs.add(f);
      return () => joinSubs.delete(f);
    },
    () => joinAsk,
  );

/** Opens the join box with the invite on the clipboard, if there is one. */
export async function askJoin() {
  const clip = await call<string>("ClipboardText").catch(() => "");
  const inv = readInvite(clip);
  openJoin(inv.code ?? inv.link ?? "", false, true);
}

/** A pane that joined a share is closed: the app lets go of it. */
export function leaveJoined(tab: Tab) {
  const id = tab.join?.id ?? joins.get(tab.key)?.id;
  joins.delete(tab.key);
  if (id && !getState().tabs.some((t) => t.key !== tab.key && t.join?.id === id)) void collabApi.leave(id).catch(() => {});
}

// ---------- presence: one connection per pane ----------

export interface Sel {
  a: [number, number]; // column, row on screen
  b: [number, number];
}
/** Where someone points, in cells (and fractions of one: the same spot on every screen). */
export interface Pointer {
  c: number;
  r: number;
  at: number; // when it last moved
}
/** What happened to someone's pointer: it moved, went off the screen, clicked; or "find" (show me where they are). */
export interface PointerNote {
  t: "move" | "gone" | "click" | "find" | "reset";
  id: string;
  at?: "pointer" | "cursor"; // find: where they are, their pointer or where they type
}
export interface PresenceState {
  you?: string;
  role?: "edit" | "view";
  people: Member[];
  sels: Record<string, Sel>;
  typed: Record<string, number>; // who typed, when
  size?: { cols: number; rows: number };
  info?: SessionInfo;
  ports: Port[];
  forwarded: Record<number, string>; // a guest's: the share's port → its address here
}

const EMPTY: PresenceState = { people: [], sels: {}, typed: {}, ports: [], forwarded: {} };
const told = new Set<string>(); // ports already announced as open here: join id and port

class Presence {
  state: PresenceState = EMPTY;
  private ws: WebSocket | null = null;
  private stopped = false;
  /** It was seen out (the share stopped, or they were removed), or closed. */
  get over() {
    return this.stopped;
  }
  private tries = 0;
  private timer?: number;
  private ptrFrame = 0;
  private ptrNext: { c: number; r: number } | null | undefined;
  private ptrSent: { c: number; r: number } | null = null;
  private typedAt = 0;
  readonly subs = new Set<() => void>();
  /** Where everyone else points. It changes many times a second, so it is not React state:
   *  the pointers are moved by their drawing (Presence.tsx), told by onPointer. */
  readonly pointers = new Map<string, Pointer>();
  private pointerSubs = new Set<(n: PointerNote) => void>();

  constructor(
    readonly key: string,
    readonly url: string,
    readonly joined: boolean,
  ) {
    this.connect();
  }

  private set(patch: Partial<PresenceState>) {
    this.state = { ...this.state, ...patch };
    this.subs.forEach((f) => f());
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.tries = 0;
      // The person sharing's pane: the guests' screens take its size now, not at its next change.
      if (!this.joined) this.resized();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.onMessage(ev.data);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws || this.stopped) return;
      this.ws = null;
      if (ev.reason === "stopped" || ev.reason === "removed") return this.ended(ev.reason);
      // Nobody but me is there while I'm away.
      this.pointers.clear();
      this.note({ t: "reset", id: "" });
      this.set({ people: this.state.people.filter((m) => m.id === this.state.you), sels: {} });
      this.timer = window.setTimeout(() => this.connect(), Math.min(8000, 400 * 2 ** this.tries++));
    };
  }

  private onMessage(raw: string) {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const id = m.id as string;
    switch (m.t) {
      case "hello":
        this.set({
          you: m.you as string,
          role: m.role as "edit" | "view",
          people: (m.people as Member[]) ?? [],
          info: m.info as SessionInfo,
          size: sizeOf(m.size),
          ports: (m.ports as Port[]) ?? [],
          sels: {},
        });
        this.pointers.clear();
        this.note({ t: "reset", id: "" });
        this.forwardPorts();
        break;
      case "people": {
        const people = (m.people as Member[]) ?? [];
        const me = people.find((p) => p.id === this.state.you);
        this.set({ people, role: me ? (me.canType ? "edit" : "view") : this.state.role });
        break;
      }
      case "ptr":
      case "click":
        if (typeof m.c === "number" && typeof m.r === "number") {
          // Someone who comes in sees a pointer that was left there a while ago as just that.
          const idle = typeof m.idle === "number" ? m.idle : 0;
          this.pointers.set(id, { c: m.c, r: m.r, at: Date.now() - idle });
          this.note({ t: m.t === "click" ? "click" : "move", id });
        } else if (this.pointers.delete(id)) this.note({ t: "gone", id });
        break;
      case "sel": {
        const sels = { ...this.state.sels };
        if (Array.isArray(m.a) && Array.isArray(m.b)) sels[id] = { a: m.a as [number, number], b: m.b as [number, number] };
        else delete sels[id];
        this.set({ sels });
        break;
      }
      case "typed":
        this.set({ typed: { ...this.state.typed, [id]: Date.now() } });
        break;
      case "size":
        this.set({ size: sizeOf(m) });
        break;
      case "info":
        this.set({ info: m.info as SessionInfo });
        break;
      case "ports":
        this.set({ ports: (m.ports as Port[]) ?? [] });
        this.forwardPorts();
        break;
      case "bye":
        this.ended(m.why as string);
        break;
    }
  }

  // A guest's: every port the session listens on is reachable here too, as it appears.
  private forwardPorts() {
    if (!this.joined) return;
    const id = knownJoin(this.key)?.id;
    if (!id) return;
    for (const p of this.state.ports) {
      if (this.state.forwarded[p.port]) continue;
      collabApi.forward(id, p.port).then(
        (addr) => {
          if (this.state.forwarded[p.port] === addr) return;
          this.set({ forwarded: { ...this.state.forwarded, [p.port]: addr } });
          if (told.has(`${id}:${p.port}`)) return; // said once is enough
          told.add(`${id}:${p.port}`);
          const host = this.state.people.find((x) => x.host)?.name;
          toast("info", `${addr.replace(/^https?:\/\//, "")} is open here`, `${p.process || "A program"} in ${host ? `${firstName(host)}'s` : "the"} session listens on port ${p.port}. Open it in your browser.`, {
            label: "Open",
            run: () => void call("OpenURL", addr),
          });
        },
        () => {},
      );
    }
  }

  private ended(why: string) {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
    if (!this.joined) return;
    const host = firstName(this.state.people.find((x) => x.host)?.name ?? getState().tabs.find((t) => t.key === this.key)?.join?.by);
    updateTab(this.key, { termId: undefined, url: undefined, retry: undefined, error: why === "removed" ? `${host} removed you from this session.` : `${host} stopped sharing this session.` });
  }

  /** Whether anyone else is in the session right now. */
  crowded() {
    return this.state.people.some((m) => m.id !== this.state.you);
  }

  send(v: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(v));
  }

  onPointer(f: (n: PointerNote) => void) {
    this.pointerSubs.add(f);
    return () => void this.pointerSubs.delete(f);
  }

  private note(n: PointerNote) {
    this.pointerSubs.forEach((f) => f(n));
  }

  /** Where my pointer is over the screen, in cells (null: off it). Once a frame at most, and
   *  only when it moved enough to see. */
  pointer(p: { c: number; r: number } | null) {
    this.ptrNext = p;
    if (this.ptrFrame) return;
    this.ptrFrame = requestAnimationFrame(() => {
      this.ptrFrame = 0;
      const n = this.ptrNext;
      const was = this.ptrSent;
      if (n && was && Math.abs(n.c - was.c) < 0.02 && Math.abs(n.r - was.r) < 0.02) return;
      if (!n && !was) return;
      this.ptrSent = n ? { c: n.c, r: n.r } : null;
      this.send(n ? { t: "ptr", c: n.c, r: n.r } : { t: "ptr" });
    });
  }

  /** I clicked there: the others see it land. */
  click(p: { c: number; r: number }) {
    cancelAnimationFrame(this.ptrFrame);
    this.ptrFrame = 0;
    this.ptrSent = p;
    this.send({ t: "click", c: p.c, r: p.r });
  }

  /** Shows on this pane where someone is: their pointer, else where they just typed. */
  find(id: string) {
    const m = this.state.people.find((x) => x.id === id);
    if (!m) return;
    if (this.pointers.has(id)) return this.note({ t: "find", id, at: "pointer" });
    if (Date.now() - (this.state.typed[id] ?? 0) < 15_000) return this.note({ t: "find", id, at: "cursor" });
    toast("info", `${firstName(m.name)} isn't pointing at the screen`, "Their pointer shows here, with their name, as soon as they move it over the session.");
  }

  select(s: Sel | null) {
    this.send(s ? { t: "sel", a: s.a, b: s.b } : { t: "sel" });
  }

  /** The person sharing typed (a guest's typing is seen on its way to the session). */
  typed() {
    if (Date.now() - this.typedAt < 300) return;
    this.typedAt = Date.now();
    this.send({ t: "typed" });
  }

  /** The person sharing's pane changed size: the guests' screens follow. */
  resized() {
    this.send({ t: "size" });
  }

  close() {
    this.stopped = true;
    window.clearTimeout(this.timer);
    cancelAnimationFrame(this.ptrFrame);
    this.ws?.close();
  }
}

function sizeOf(v: unknown): PresenceState["size"] {
  const s = v as { cols?: number; rows?: number } | undefined;
  return s && s.cols && s.rows ? { cols: s.cols, rows: s.rows } : undefined;
}

const presences = new Map<string, Presence>();
const presenceSubs = new Set<() => void>();

/** The pane's presence connection, while it has one. */
export const presenceOf = (key: string) => presences.get(key);

/** The pane's presence connection, following it as it comes and goes. */
export const usePresenceConn = (key: string) =>
  useSyncExternalStore(
    (f) => {
      presenceSubs.add(f);
      return () => void presenceSubs.delete(f);
    },
    () => presences.get(key),
  );

/** Brings a pane forward and shows where someone in its session is. */
export function findPerson(key: string, id: string) {
  focusPane(key);
  requestAnimationFrame(() => presences.get(key)?.find(id));
}

const clientIds = new Map<string, string>();
/** The pane's name in the share: it keeps its screen across reconnections with it. */
export function clientId(key: string) {
  let id = clientIds.get(key);
  if (!id) {
    id = `${key}-${Math.random().toString(36).slice(2, 8)}`;
    clientIds.set(key, id);
  }
  return id;
}

/** Connects a pane's presence (again, when its address changed); null disconnects it. */
export function linkPresence(key: string, url: string | null, joined: boolean) {
  const cur = presences.get(key);
  if (cur && cur.url === url && !cur.over) return;
  cur?.close();
  presences.delete(key);
  if (url) presences.set(key, new Presence(key, url, joined));
  presenceSubs.forEach((f) => f());
}

/** The presence address of a pane: the hub's own for the person sharing, the app's proxy for a guest. */
export async function presenceURL(tab: Tab, share: ShareState | undefined): Promise<string | null> {
  if (tab.kind === "joined") {
    const j = knownJoin(tab.key);
    return j ? `${j.presence}&c=${encodeURIComponent(clientId(tab.key))}` : null;
  }
  if (!share) return null;
  local ??= await collabApi.local();
  return `${local.presence.replace("%s", encodeURIComponent(share.id))}&c=${encodeURIComponent(clientId(tab.key))}`;
}

/** A part of a pane's presence; re-renders only when that part changes. */
export function usePresence<T>(key: string, pick: (s: PresenceState) => T): T | undefined {
  return useSyncExternalStore(
    (f) => {
      // Follow the pane's connection as it comes and goes.
      let p = presences.get(key);
      p?.subs.add(f);
      const swap = () => {
        const next = presences.get(key);
        if (next === p) return;
        p?.subs.delete(f);
        p = next;
        p?.subs.add(f);
        f();
      };
      presenceSubs.add(swap);
      return () => {
        p?.subs.delete(f);
        presenceSubs.delete(swap);
      };
    },
    () => {
      const p = presences.get(key);
      return p ? pick(p.state) : undefined;
    },
  );
}

export { EMPTY as emptyPresence };
