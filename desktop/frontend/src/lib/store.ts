// One small global store (useSyncExternalStore) for everything the views share.
import { useSyncExternalStore } from "react";
import { takePrefs } from "./prefs";
import { geometry, leaves, neighbor, remove, resize as resizeLayout, split as splitLayout, type Dir, type Layout } from "./panes";
import {
  api,
  call,
  errText,
  on,
  type AppInfo,
  type MachineView,
  type OpEnd,
  type OpEvent,
  type OpInfo,
  type Session,
  type SessionsView,
  type SyncResult,
  type Tunnel,
  type ClaudeAccountView,
  type APIKeyView,
  type TickResult,
  type WindowInfo,
  type UpdateInfo,
  type GitInfo,
  type Port,
} from "./api";
import { baseName, isNativeWebview, tildePath } from "./util";
import { installThemes, themeById, type AppTheme } from "./themes";

export type View = "home" | "sessions" | "machines" | "sync" | "keys" | "folders" | "accounts" | "settings"; // "keys" shows Accounts, where the keys are

/** The machine name that sessions on this computer carry. */
export const LOCAL = "@local";

/** A machine's name for display: "this computer" for sessions here. */
export const machineLabel = (machine?: string) => (!machine || machine === LOCAL ? "this computer" : machine);

/**
 * One pane: a terminal on a machine (a named tmux session or a shell) or on this computer.
 * A pane with a session is backed by tmux, there or here: it outlives its connection and
 * the app, and the pane attaches to it again by name.
 */
export interface Tab {
  key: string;
  // joined: someone else's session, shared with you over the tailnet (see lib/collab).
  kind: "session" | "shell" | "local" | "joined";
  machine?: string;
  session?: string; // tmux session name; a local pane has one when tmux is installed here
  title: string; // last-resort name
  termTitle?: string; // what the program in the terminal calls itself (Claude's task name)
  cwd?: string; // folder of the program in front (absolute path on that machine)
  running?: string; // that program's name: zsh, claude, vim…
  claude?: boolean; // Claude Code is running in this pane
  agent?: string; // another coding agent running in this pane: codex | grok | mantis
  sid?: string; // Claude's conversation ID, to resume it if the session is lost
  // How to create the pane's session when it doesn't exist (yet, or any more): where, and
  // whether to start Claude in it — afresh, or resuming a conversation (an ID, or "continue").
  // prompt (Claude's first message) and run (a command for a new shell) are for the first
  // time the session is made only.
  spawn?: { dir?: string; claude?: boolean; agent?: string; resume?: string; flags?: string; prompt?: string; run?: string };
  flags?: string; // how Claude was started in this pane (permission flags), to start it the same way again
  // The connection dropped and the pane is attaching again: which try, when it is due, why.
  retry?: { n: number; at: number; why?: string };
  termId?: string;
  url?: string;
  exited?: boolean;
  error?: string;
  // A joined pane: the invite link, and what it was for (who shares it, what it is called,
  // whether you can type).
  join?: { link: string; id?: string; title?: string; by?: string; role?: string; code?: string }; // code: 7KX-4PQ, to pass on
}

/** The ⌃Tab switcher while it is open: panes most-recent first and the one selected. */
export interface Switcher {
  order: string[]; // what is shown: every tab, or the ones matching what was typed
  all: string[]; // every tab, most recent first
  query: string; // typed while the switcher is up, to narrow it down
  index: number;
  mod: "Control" | "Alt"; // releasing this key commits
  shown: boolean; // the list appears after a short hold; a quick tap just switches
}

/** A tab-bar entry: panes laid out in splits. */
export interface Group {
  id: string;
  layout: Layout;
  focus: string; // focused pane key
  zoom?: boolean; // focused pane fills the group
  pinned?: boolean; // kept at the left of the tab bar as an icon
  ws?: string; // the workspace it belongs to (none: it shows only under "All")
}

/** What you set on a session yourself: a name of your own and a colour. */
export interface Meta {
  name?: string;
  color?: string;
}

/** Colours a session can be tagged with (names are what is stored). */
export const COLORS: { id: string; value: string }[] = [
  { id: "red", value: "#f2555a" },
  { id: "orange", value: "#f5923e" },
  { id: "yellow", value: "#f5c451" },
  { id: "green", value: "#3ecf8e" },
  { id: "blue", value: "#6cb6ff" },
  { id: "purple", value: "#c49bff" },
];
export const colorValue = (id?: string) => COLORS.find((c) => c.id === id)?.value;

export interface OpState {
  info: OpInfo;
  events: OpEvent[];
  end?: OpEnd;
}

export interface Toast {
  id: number;
  kind: "success" | "error" | "info" | "session";
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
  ms: number; // how long it stays
  session?: { machine: string; state: "waiting" | "done"; agent?: string }; // a session that finished or needs you
}

export type Modal =
  | null
  | { type: "new-machine" }
  | { type: "add-machine" }
  | { type: "new-session"; machine?: string; dir?: string }
  | { type: "palette" }
  | { type: "recipes"; edit?: Recipe } // the list, or the form for one (a new one has no id yet)
  | { type: "composer" }
  | { type: "add-claude" } // add a Claude account: browser sign-in or a pasted token
  | { type: "op"; id: string };

/**
 * A recipe: a session you start often, one keystroke away. Where it runs, in which folder,
 * and what it starts with: Claude and a first message, or a shell and a command.
 */
export interface Recipe {
  id: string;
  name: string;
  machine: string; // a machine, LOCAL, or "" for wherever the focused pane is
  dir: string; // "" = the focused pane's folder (when it is on that machine), else home
  kind: "claude" | "shell";
  flags: string; // Claude's permission flags
  prompt: string; // Claude's first message; {clipboard} and {ask} are filled in when it runs
  run: string; // the shell's first command
}

export type Theme = "system" | "dark" | "light";

/** How terminals look beyond the theme; the font size is the zoom level. */
export interface TermPrefs {
  line: "compact" | "normal";
  cursor: "block" | "bar" | "underline";
  blink: boolean;
  footer: boolean; // the folder and branch under each pane
}
export const termLineHeight = (p: TermPrefs) => (p.line === "compact" ? 1 : 1.18);

export interface State {
  info?: AppInfo;
  view: View;
  machines: MachineView[];
  machinesLoaded: boolean;
  machinesKnown: boolean; // the machine list really came in (a failed read doesn't count)
  sessions: SessionsView;
  sessionsLoaded: boolean;
  tabs: Tab[]; // every pane, across groups
  groups: Group[];
  activeGroup?: string;
  activeTab?: string; // focused pane of the active group
  mru: string[]; // pane keys, most recently focused first
  switcher: Switcher | null;
  sidebar: boolean; // sidebar shown
  zoom: number; // zoom level; 0 is the default size
  win: WindowInfo; // this window among the app's instances
  update: UpdateInfo | null; // this version, and a newer one on its way
  winReady: boolean; // the window knows which one it is, so its own layout can be restored
  welcome: boolean; // the welcome is showing (the first time Lungo opens, or from Help)
  localTmux: boolean; // tmux is installed here: local panes are sessions that outlive the app
  git: Record<string, GitInfo>; // repository state of the folders panes are in, by gitKey
  meta: Record<string, Meta>; // your own names and colours for sessions, by metaKey
  workspaces: string[]; // named sets of tabs, in the order they were made
  workspace: string | null; // the one the tab bar shows; null shows every tab
  recipes: Recipe[];
  ports: Record<string, Record<string, Port[]>>; // listening ports, by machine then session
  ops: Record<string, OpState>;
  opOrder: string[];
  tunnels: Tunnel[];
  toasts: Toast[];
  modal: Modal;
  claudeAccounts: ClaudeAccountView[] | null;
  keys: APIKeyView[] | null;
  addKey?: string | null; // open the add-key dialog on the Keys page ("" = pick a service)
  machineSheet?: string;
  watching: string[];
  syncResults: Record<string, SyncResult>;
  theme: Theme; // follow the system, or always the dark / the light theme
  skins: { dark: string; light: string }; // which theme is the dark one and which the light one
  term: TermPrefs;
  linksVersion: number;
}

// ---------- per-window preferences ----------
// The first window ("main") owns the plain keys; windows opened from it get their own copy
// of the layout, zoom and sidebar state. A window closed for good has it cleared by the next
// window to start (see clearForgotten).

const MAIN = "main";
let windowId = MAIN;
const prefKey = (name: string) => (windowId === MAIN ? `sky.${name}` : `sky.${name}.${windowId}`);

function readPref(name: string, inherit = true): string | null {
  try {
    return localStorage.getItem(prefKey(name)) ?? (inherit && windowId !== MAIN ? localStorage.getItem(`sky.${name}`) : null);
  } catch {
    return null; // storage unavailable
  }
}

function writePref(name: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(prefKey(name));
    else localStorage.setItem(prefKey(name), value);
  } catch {
    /* storage unavailable */
  }
}

export const ZOOM_MIN = -3;
export const ZOOM_MAX = 10;
/** Terminal font size for a zoom level: 12px by default, 9–22px across the range. */
export const termFontSize = (zoom: number) => 12 + zoom;
/** Scale of everything around the terminals for a zoom level. */
export const uiScale = (zoom: number) => Math.round((0.94 + zoom * 0.06) * 100) / 100;

function loadZoom(): number {
  const z = parseInt(readPref("zoom") ?? "0", 10);
  return isNaN(z) ? 0 : Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
}

function applyZoom(zoom: number) {
  document.documentElement.style.setProperty("--ui-zoom", String(uiScale(zoom)));
}

function loadTheme(): Theme {
  try {
    const t = localStorage.getItem("sky.theme");
    if (t === "dark" || t === "light" || t === "system") return t;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

function loadSkins(): State["skins"] {
  let dark: string | null = null;
  let light: string | null = null;
  try {
    dark = localStorage.getItem("sky.skin.dark");
    light = localStorage.getItem("sky.skin.light");
  } catch {
    /* storage unavailable */
  }
  return { dark: themeById(dark, true).id, light: themeById(light, false).id };
}

function loadTermPrefs(): TermPrefs {
  const p: TermPrefs = { line: "normal", cursor: "block", blink: true, footer: true };
  try {
    const v = JSON.parse(localStorage.getItem("sky.term") ?? "{}") as Partial<TermPrefs>;
    if (v.line === "compact" || v.line === "normal") p.line = v.line;
    if (v.cursor === "block" || v.cursor === "bar" || v.cursor === "underline") p.cursor = v.cursor;
    if (typeof v.blink === "boolean") p.blink = v.blink;
    if (typeof v.footer === "boolean") p.footer = v.footer;
  } catch {
    /* storage unavailable or a bad value: defaults */
  }
  return p;
}

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return v && typeof v === "object" ? (v as T) : fallback;
  } catch {
    return fallback; // storage unavailable or a bad value
  }
}
function saveJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

let state: State = {
  view: "sessions",
  machines: [],
  machinesLoaded: false,
  machinesKnown: false,
  // The sessions seen last time, until the first look at the machines (a second or two):
  // the sidebar is full the moment the app opens.
  sessions: loadJSON<SessionsView>("sky.sessions.last", { sessions: [], errors: {}, at: "" }),
  sessionsLoaded: false,
  tabs: [],
  groups: [],
  mru: [],
  switcher: null,
  sidebar: readPref("sidebar") !== "0",
  zoom: loadZoom(),
  win: { id: MAIN, primary: true, count: 1 },
  update: null,
  winReady: false,
  welcome: false,
  localTmux: false,
  git: {},
  meta: loadJSON<Record<string, Meta>>("sky.meta", {}),
  workspaces: loadJSON<string[]>("sky.workspaces", []),
  workspace: null,
  recipes: loadJSON<Recipe[]>("sky.recipes", []),
  ports: {},
  ops: {},
  opOrder: [],
  tunnels: [],
  toasts: [],
  modal: null,
  claudeAccounts: null,
  keys: null,
  watching: [],
  syncResults: {},
  theme: loadTheme(),
  skins: loadSkins(),
  term: loadTermPrefs(),
  linksVersion: 0,
};

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

// Dev checks read the state from a headless browser.
if (import.meta.env.DEV) (window as unknown as { __skyState?: () => State }).__skyState = () => state;

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const prev = state;
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  // A pane that stops being the focused one was last active just now.
  if (state.activeTab !== prev.activeTab && prev.activeTab) lastActive.set(prev.activeTab, Date.now());
  // The most-recently-used order follows focus, wherever focus was changed from.
  if (state.activeTab !== prev.activeTab || state.tabs !== prev.tabs) {
    const mru = nextMru(state);
    if (mru !== state.mru) state = { ...state, mru };
  }
  listeners.forEach((l) => l());
}

const lastActive = new Map<string, number>(); // pane key → when it last was the focused pane

/** When a tab was last looked at: "now" for the one in front, else the time, 0 when not known. */
export function tabLastActive(g: Group, s: State = state): number | "now" {
  const keys = leaves(g.layout);
  if (s.activeTab && keys.includes(s.activeTab)) return "now";
  return Math.max(0, ...keys.map((k) => lastActive.get(k) ?? 0));
}

function nextMru(s: State): string[] {
  const live = new Set(s.tabs.map((t) => t.key));
  let mru = s.mru.filter((k) => live.has(k));
  if (s.activeTab && live.has(s.activeTab) && mru[0] !== s.activeTab) mru = [s.activeTab, ...mru.filter((k) => k !== s.activeTab)];
  for (const t of s.tabs) if (!mru.includes(t.key)) mru.push(t.key);
  return mru.length === s.mru.length && mru.every((k, i) => k === s.mru[i]) ? s.mru : mru;
}

/** Subscribe to a slice. Selectors must return existing references, not new objects. */
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

// ---------- toasts ----------

let toastId = 0;
export function toast(kind: Exclude<Toast["kind"], "session">, title: string, body?: string, action?: Toast["action"]) {
  const id = ++toastId;
  const ms = kind === "error" ? 9000 : 4500;
  setState((s) => ({ toasts: [...s.toasts, { id, kind, title, body, action, ms }].slice(-5) }));
}

/** A session finished or needs you: a click on the notice opens it. One per session at a time. */
export function toastSession(x: Session) {
  const id = ++toastId;
  const waiting = x.state === "waiting";
  const title = state.meta[sessionMetaKey(x.machine, x.name)]?.name || x.title || x.name;
  const agent = x.agent || (x.claude ? "claude" : "");
  const body = waiting ? x.message || "Waiting for you" : "Finished, ready for your next message";
  const run = () => openSessionTab(x.machine, x.name);
  setState((s) => ({
    toasts: [...s.toasts.filter((t) => !(t.kind === "session" && t.title === title && t.session?.machine === x.machine)), { id, kind: "session" as const, title, body, action: { label: "Open", run }, ms: waiting ? 12000 : 6000, session: { machine: x.machine, state: waiting ? ("waiting" as const) : ("done" as const), agent } }].slice(-5),
  }));
}
// Seen the welcome. Its name changes when the welcome should be shown again to everyone.
const WELCOMED = "welcomed.0.1";

/** The welcome, again (Help ▸ Welcome to Lungo, Settings). */
export function openWelcome() {
  setState({ welcome: true, modal: null });
}
/** Done with the welcome: it doesn't come back by itself. */
export function finishWelcome() {
  writePref(WELCOMED, "1");
  setState({ welcome: false });
}
export function dismissToast(id: number) {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

// ---------- operations ----------

const waiters = new Map<string, ((e: OpEnd) => void)[]>();
const quiet = new Set<string>();

/** Start a backend operation; resolves with its id. quietly = no toast on success. */
export async function runOp(start: Promise<string>, quietly = false): Promise<string> {
  try {
    const id = await start;
    if (quietly) quiet.add(id);
    return id;
  } catch (e) {
    toast("error", "Couldn't start", errText(e));
    throw e;
  }
}

/** Wait for an operation to end. */
export function waitOp(id: string): Promise<OpEnd> {
  const done = state.ops[id]?.end;
  if (done) return Promise.resolve(done);
  return new Promise((res) => {
    waiters.set(id, [...(waiters.get(id) ?? []), res]);
  });
}

export function opsRunning(s: State): number {
  let n = 0;
  for (const id of s.opOrder) if (s.ops[id]?.info.running) n++;
  return n;
}

// ---------- data ----------

let machinesRetry = 0;
/**
 * Reads the machines. A read that fails is tried again, a little later each time, until it
 * works: tabs on machines come back only once the machines are really known, so a failed
 * read never drops them.
 */
export async function loadMachines() {
  try {
    const machines = await api.machines();
    machinesRetry = 0;
    setState({ machines, machinesLoaded: true, machinesKnown: true });
  } catch (e) {
    if (machinesRetry === 0) toast("error", "Couldn't read machines", errText(e));
    setState({ machinesLoaded: true });
    const wait = Math.min(30000, 2000 * 2 ** machinesRetry++);
    window.setTimeout(() => {
      if (!state.machinesKnown) void loadMachines();
    }, wait);
  }
}

export async function refreshMachines() {
  try {
    const machines = await api.refreshMachines();
    setState({ machines, machinesLoaded: true, machinesKnown: true });
  } catch (e) {
    toast("error", "Refresh failed", errText(e));
  }
}

export async function loadSessions() {
  try {
    applySessions(await api.sessions());
  } catch {
    setState({ sessionsLoaded: true });
  }
}

const sessionKey = (s: Session) => `${s.machine}/${s.name}`;
const sameSession = (a: Session, b: Session) =>
  a.activity === b.activity && a.state === b.state && a.message === b.message && a.path === b.path && a.command === b.command &&
  a.attached === b.attached && a.claude === b.claude && a.stateAt === b.stateAt && a.windows === b.windows && a.title === b.title && a.sid === b.sid && a.flags === b.flags && a.branch === b.branch && a.oldLogin === b.oldLogin &&
  a.mouse === b.mouse && a.alt === b.alt && a.scrollKey === b.scrollKey && a.agent === b.agent && a.stale === b.stale;

/**
 * Takes a sessions poll. Sessions that didn't change keep their object (and the whole list
 * keeps its array when nothing did), so a poll every few seconds re-renders only what moved.
 * Panes pick up their folder and running program from their session here.
 */
export function applySessions(v: SessionsView) {
  setState((s) => {
    const old = new Map(s.sessions.sessions.map((x) => [sessionKey(x), x]));
    let same = v.sessions.length === s.sessions.sessions.length;
    const list = v.sessions.map((x, i) => {
      const o = old.get(sessionKey(x));
      const keep = o && sameSession(o, x) ? o : x;
      if (keep !== s.sessions.sessions[i]) same = false;
      return keep;
    });
    const errors = JSON.stringify(v.errors) === JSON.stringify(s.sessions.errors) ? s.sessions.errors : v.errors;
    const sessions = same && errors === s.sessions.errors ? s.sessions : { sessions: same ? s.sessions.sessions : list, errors, at: v.at };
    const by = new Map(sessions.sessions.map((x) => [sessionKey(x), x]));
    let changed = false;
    const now = Date.now();
    const tabs = s.tabs.map((t) => {
      const m = tabMachine(t);
      const x = m && t.session ? by.get(`${m}/${t.session}`) : undefined;
      if (x) aliveAt.set(t.key, now);
      const sid = x?.sid || t.sid;
      const flags = x?.flags ?? t.flags;
      const agent = x && x.agent && x.agent !== "claude" ? x.agent : undefined;
      if (!x || (t.cwd === x.path && t.running === x.command && !!t.claude === x.claude && t.agent === agent && t.sid === sid && t.flags === flags)) return t;
      changed = true;
      return { ...t, cwd: x.path, running: x.command, claude: x.claude, agent, sid, flags };
    });
    return { sessions, sessionsLoaded: true, ...(changed ? { tabs } : {}) };
  });
  keepSessions();
}

let keptAt = 0;
/** Keeps the session list for the next start (not more than every few seconds). */
function keepSessions() {
  if (Date.now() - keptAt < 5000) return;
  keptAt = Date.now();
  saveJSON("sky.sessions.last", { ...state.sessions, errors: {} });
}

// ---------- tabs, panes and groups ----------
// Every terminal is a pane (a Tab). Groups are what the tab bar shows: one or more panes in
// splits. activeTab is the focused pane of the active group.

let tabSeq = 0;
function tabKey() {
  return `t${++tabSeq}`;
}
let groupSeq = 0;
function groupID() {
  return `g${++groupSeq}`;
}

/** Where a pane's tmux session lives: its machine, LOCAL for one here, nothing without tmux. */
export function tabMachine(t: Tab): string | undefined {
  return t.kind === "local" ? (t.session ? LOCAL : undefined) : t.machine;
}

/** Where a pane's folder is looked up for its repository state: the machine and the folder. */
export const gitKey = (t: Tab) => `${t.kind === "local" ? LOCAL : (t.machine ?? "")}\n${t.cwd ?? ""}`;

/** Height of the strip under a pane (folder and branch), before zoom. */
export const PANE_FOOTER = 30;

/** The pane has a tmux session behind it, so it can attach again after any interruption. */
export const persistent = (t: Tab) => !!tabMachine(t) && !!t.session;

export function groupOf(key: string, s: State = state): Group | undefined {
  return s.groups.find((g) => leaves(g.layout).includes(key));
}

/** Focus a pane (and its group). */
export function focusPane(key: string) {
  setState((s) => {
    const g = groupOf(key, s);
    if (!g) return {};
    return { groups: s.groups.map((x) => (x.id === g.id ? { ...x, focus: key } : x)), activeGroup: g.id, activeTab: key, view: "sessions", ...follow(g, s) };
  });
}

export function focusGroup(id: string) {
  const g = state.groups.find((x) => x.id === id);
  if (g) setState({ activeGroup: g.id, activeTab: g.focus, view: "sessions", ...follow(g, state) });
}

// Going to a tab outside the workspace on show (a session that needs you, a search hit)
// takes the tab bar along: to that tab's workspace, or to "All" when it has none.
function follow(g: Group, s: State): Partial<State> {
  if (s.workspace === null || g.ws === s.workspace) return {};
  const workspace = g.ws && s.workspaces.includes(g.ws) ? g.ws : null;
  writePref("workspace", workspace ?? "");
  return { workspace };
}

/** The tabs the tab bar shows: the current workspace's (all of them under "All"), pinned ones first. */
export function visibleGroups(s: State = state): Group[] {
  const list = s.workspace === null ? s.groups : s.groups.filter((g) => g.ws === s.workspace);
  return [...list.filter((g) => g.pinned), ...list.filter((g) => !g.pinned)];
}

/** Opens a pane: next to the focused one (split) or as a new tab. */
function placePane(tab: Tab, where: "group" | Dir = "group") {
  setState((s) => {
    const g = s.activeGroup ? s.groups.find((x) => x.id === s.activeGroup) : undefined;
    if (where !== "group" && g) {
      const layout = splitLayout(g.layout, g.focus, tab.key, where);
      return {
        tabs: [...s.tabs, tab],
        groups: s.groups.map((x) => (x.id === g.id ? { ...x, layout, focus: tab.key, zoom: false } : x)),
        activeTab: tab.key,
        view: "sessions",
      };
    }
    const ng: Group = { id: groupID(), layout: { pane: tab.key }, focus: tab.key, ws: s.workspace ?? undefined };
    return { tabs: [...s.tabs, tab], groups: [...s.groups, ng], activeGroup: ng.id, activeTab: tab.key, view: "sessions" };
  });
}

/** The pane that shows a session, whatever kind it is (a shell pane Claude was started in is that session too). */
export const paneForSession = (machine: string, session: string, s: State = state) => s.tabs.find((t) => tabMachine(t) === machine && t.session === session && !t.exited);

/** A new pane for a session that is running. */
function sessionPane(machine: string, session: string): Tab {
  const known = state.sessions.sessions.find((x) => x.machine === machine && x.name === session);
  const what = { session, title: session, cwd: known?.path, running: known?.command, claude: known?.claude, sid: known?.sid, flags: known?.flags };
  return machine === LOCAL ? { key: tabKey(), kind: "local", ...what } : { key: tabKey(), kind: "session", machine, ...what };
}

export function openSessionTab(machine: string, session: string, where: "group" | Dir = "group") {
  const existing = paneForSession(machine, session);
  if (existing) return focusPane(existing.key);
  // Open in another window: go there. Two windows on one session fight over its size.
  void api
    .focusSession(machine, session)
    .catch(() => false)
    .then((there) => {
      if (!there && !paneForSession(machine, session)) placePane(sessionPane(machine, session), where);
    });
}

/** Brings a session into this window, from the window that shows it when another does. */
export function openHere(machine: string, session: string) {
  const t = paneForSession(machine, session);
  if (t) return focusPane(t.key);
  void api
    .takeSession(machine, session)
    .catch(() => false)
    .then(() => {
      if (!paneForSession(machine, session)) placePane(sessionPane(machine, session));
    });
}

/** Opens a session in a window of its own (taken from the window it is in, if any). */
export function openInNewWindow(machine: string, session: string) {
  const t = paneForSession(machine, session);
  if (t) return moveToNewWindow(t.key);
  void api
    .takeSession(machine, session)
    .catch(() => false)
    .then(() => newWindowWith([sessionPane(machine, session)]));
}

/** Moves a pane into a new window; its session keeps running throughout. */
export function moveToNewWindow(key: string) {
  const t = state.tabs.find((x) => x.key === key);
  if (!t) return;
  newWindowWith([t], () => releaseTab(key));
}

/** Moves a whole tab, its split as it is, into a new window. */
export function moveGroupToNewWindow(id: string) {
  const g = state.groups.find((x) => x.id === id);
  if (!g) return;
  const keys = leaves(g.layout);
  const panes = keys.flatMap((k) => state.tabs.find((t) => t.key === k) ?? []);
  newWindowWith(panes, () => keys.forEach(releaseTab), g.layout, g.focus);
}

function newWindowWith(tabs: Tab[], then?: () => void, split?: Layout, focus?: string) {
  const panes: SavedPane[] = tabs.map((t) => ({ key: t.key, kind: t.kind, machine: t.machine, session: t.session, title: t.title, cwd: t.cwd ?? t.spawn?.dir, sid: t.sid, flags: t.flags, claude: liveClaude(t), agent: t.agent, join: t.join }));
  const layout = { panes, groups: [{ id: "g1", layout: split ?? { pane: tabs[0].key }, focus: focus ?? tabs[0].key }], activeGroup: "g1" };
  api.newWindowWith(JSON.stringify(layout)).then(
    () => then?.(),
    (e) => toast("error", "Couldn't open a window", errText(e)),
  );
}

// ---------- putting sessions together ----------

/** Panes in a grid: up to three side by side, four as two by two, more in rows of three. */
export function gridLayout(keys: string[]): Layout {
  if (keys.length === 1) return { pane: keys[0] };
  const perRow = keys.length <= 3 ? keys.length : keys.length === 4 ? 2 : 3;
  const rows: Layout[] = [];
  for (let i = 0; i < keys.length; i += perRow) {
    const part = keys.slice(i, i + perRow);
    rows.push(part.length === 1 ? { pane: part[0] } : { dir: "row", children: part.map((k) => ({ pane: k })), sizes: part.map(() => 1 / part.length) });
  }
  return rows.length === 1 ? rows[0] : { dir: "col", children: rows, sizes: rows.map(() => 1 / rows.length) };
}

/** Takes panes out of the tabs they are in (a tab left with none goes); the panes stay alive. */
function detach(keys: string[], groups: Group[]): Group[] {
  const out: Group[] = [];
  for (const g of groups) {
    let layout: Layout | null = g.layout;
    for (const k of keys) if (layout && leaves(layout).includes(k)) layout = remove(layout, k);
    if (!layout) continue;
    if (layout === g.layout) out.push(g);
    else out.push({ ...g, layout, focus: leaves(layout).includes(g.focus) ? g.focus : leaves(layout)[0], zoom: false });
  }
  return out;
}

/**
 * Opens sessions together in one new tab, side by side. A session already open somewhere is
 * moved here (its terminal stays connected); the others get new panes.
 */
export function openTogether(list: { machine: string; session: string }[]) {
  if (!list.length) return;
  const keys: string[] = [];
  const fresh: Tab[] = [];
  for (const it of list) {
    const existing = paneForSession(it.machine, it.session);
    if (existing) {
      if (!keys.includes(existing.key)) keys.push(existing.key);
      continue;
    }
    const t = sessionPane(it.machine, it.session);
    fresh.push(t);
    keys.push(t.key);
  }
  setState((s) => {
    const ng: Group = { id: groupID(), layout: gridLayout(keys), focus: keys[0], ws: s.workspace ?? undefined };
    return { tabs: [...s.tabs, ...fresh], groups: [...detach(keys, s.groups), ng], activeGroup: ng.id, activeTab: keys[0], view: "sessions" };
  });
}

/** Takes a pane out of its split into a tab of its own, next to the tab it came from. */
export function moveToOwnTab(key: string) {
  setState((s) => {
    const from = groupOf(key, s);
    if (!from || leaves(from.layout).length < 2) return {};
    const groups = detach([key], s.groups);
    const ng: Group = { id: groupID(), layout: { pane: key }, focus: key, ws: from.ws };
    const at = groups.findIndex((g) => g.id === from.id);
    groups.splice(at + 1, 0, ng);
    return { groups, activeGroup: ng.id, activeTab: key, view: "sessions" };
  });
}

/** Every pane of a tab in a tab of its own. */
export function separateGroup(id: string) {
  setState((s) => {
    const g = s.groups.find((x) => x.id === id);
    if (!g) return {};
    const keys = leaves(g.layout);
    if (keys.length < 2) return {};
    const own = keys.map((k): Group => ({ id: k === g.focus ? g.id : groupID(), layout: { pane: k }, focus: k, ws: g.ws }));
    const groups = s.groups.flatMap((x) => (x.id === id ? own : [x]));
    return { groups, activeGroup: g.id, activeTab: g.focus };
  });
}

/** Moves a pane next to another pane (dir: side by side or stacked; after: right or below). */
export function placePaneBy(key: string, target: string, dir: Dir, after: boolean) {
  if (key === target) return;
  setState((s) => {
    const groups = detach([key], s.groups);
    const g = groupOf(target, { ...s, groups });
    if (!g) return {};
    const layout = splitLayout(g.layout, target, key, dir, after);
    return { groups: groups.map((x) => (x.id === g.id ? { ...x, layout, focus: key, zoom: false } : x)), activeGroup: g.id, activeTab: key, view: "sessions" };
  });
}

/** Puts one tab's panes into another tab, the two arranged in a grid. */
export function combineGroups(fromId: string, intoId: string) {
  setState((s) => {
    const from = s.groups.find((g) => g.id === fromId);
    const into = s.groups.find((g) => g.id === intoId);
    if (!from || !into || from === into) return {};
    const keys = [...leaves(into.layout), ...leaves(from.layout)];
    const groups = s.groups.filter((g) => g.id !== fromId).map((g) => (g.id === intoId ? { ...g, layout: gridLayout(keys), zoom: false } : g));
    return { groups, activeGroup: intoId, activeTab: into.focus, view: "sessions" };
  });
}

/**
 * Puts a session next to a pane (dir: side by side or stacked; after: right or below). If
 * the session is open somewhere already, that pane moves here.
 */
export function placeSessionBy(machine: string, session: string, target: string, dir: Dir, after: boolean) {
  const existing = paneForSession(machine, session);
  if (existing?.key === target) return focusPane(target);
  const t = existing ?? sessionPane(machine, session);
  setState((s) => {
    const groups = existing ? detach([t.key], s.groups) : s.groups;
    const g = groupOf(target, { ...s, groups });
    if (!g) return {};
    const layout = splitLayout(g.layout, target, t.key, dir, after);
    return {
      tabs: existing ? s.tabs : [...s.tabs, t],
      groups: groups.map((x) => (x.id === g.id ? { ...x, layout, focus: t.key, zoom: false } : x)),
      activeGroup: g.id,
      activeTab: t.key,
      view: "sessions",
    };
  });
}

/** tmux sessions behind plain shell panes are named shell-xxxx and cleaned up when idle. */
export const SHELL_PREFIX = "shell-";
const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "-zsh", "-bash"]);
const shellName = () => SHELL_PREFIX + Math.random().toString(16).slice(2, 6);

/** An idle shell pane's session: not worth listing next to real sessions. */
export function isIdleShell(s: Session): boolean {
  return s.name.startsWith(SHELL_PREFIX) && SHELLS.has(s.command);
}

/** Someone else's session, from its invite link, in a pane of its own (the one it is in already, if any). */
export function openJoinedTab(j: NonNullable<Tab["join"]>, where: "group" | Dir = "group") {
  const existing = state.tabs.find((t) => t.kind === "joined" && (t.join?.link === j.link || (!!j.id && t.join?.id === j.id)));
  if (existing) {
    if (existing.error) retryNow(existing.key);
    return focusPane(existing.key);
  }
  placePane({ key: tabKey(), kind: "joined", title: j.title || "Shared session", join: j }, where);
}

/** A shell on a machine, in dir when given (home otherwise). */
export function openShellTab(machine: string, where: "group" | Dir = "group", dir?: string, run?: string) {
  if (machine === LOCAL) return openLocalTab(where, dir, false, undefined, undefined, run);
  placePane({ key: tabKey(), kind: "shell", machine, session: shellName(), title: machine, cwd: dir, spawn: { dir, run } }, where);
}

const claudeSessionName = (dir?: string) => `claude-${folderName(dir || "~").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "home"}`;

/** A Claude Code session on a machine in dir: a new tmux session named after the folder. */
/**
 * resume continues an earlier conversation instead of starting a new one: its ID (from the
 * conversation history), or "continue" for the latest one in the folder.
 */
export function openClaudeTab(machine: string, where: "group" | Dir = "group", dir?: string, flags?: string, resume?: string, prompt?: string) {
  if (machine === LOCAL) return openLocalTab(where, dir, true, flags, resume, prompt);
  const session = freeSessionName(machine, claudeSessionName(dir));
  placePane({ key: tabKey(), kind: "session", machine, session, title: session, cwd: dir, claude: true, flags, sid: sessionIdOf(resume), spawn: { dir, claude: true, flags, resume, prompt } }, where);
}

const sessionIdOf = (resume?: string) => (resume && resume !== "continue" ? resume : undefined);

/**
 * A terminal on this computer, in dir when given, running Claude Code first when asked. With
 * tmux installed it is a session like the ones on machines (it survives the app quitting);
 * without, a plain shell that ends with the app.
 */
/** first: Claude's first message, or (for a shell) a command to run once it is up. */
/**
 * A session running a coding agent in dir, on a machine or on this computer: Claude, or
 * Codex, Grok or Mantis (see the engine's Agents). prompt is its first message.
 */
export function openAgentTab(machine: string, agent: string, where: "group" | Dir = "group", dir?: string, prompt?: string) {
  if (agent === "claude") return openClaudeTab(machine, where, dir, undefined, undefined, prompt);
  const name = (base: string) => `${agent}-${folderName(base || "~").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "home"}`;
  if (machine === LOCAL) {
    if (!state.localTmux) return openLocalTab(where, dir); // an agent needs a session to be typed into
    const session = freeSessionName(LOCAL, name(dir ?? ""));
    return placePane({ key: tabKey(), kind: "local", session, title: session, cwd: dir, agent, spawn: { dir, agent, prompt } }, where);
  }
  const session = freeSessionName(machine, name(dir ?? ""));
  placePane({ key: tabKey(), kind: "session", machine, session, title: session, cwd: dir, agent, spawn: { dir, agent, prompt } }, where);
}

export function openLocalTab(where: "group" | Dir = "group", dir?: string, claude = false, flags?: string, resume?: string, first?: string) {
  const session = state.localTmux ? (claude ? freeSessionName(LOCAL, claudeSessionName(dir)) : shellName()) : undefined;
  if (!claude) flags = resume = undefined;
  if (!session) resume = first = undefined; // these need a session to type the command into
  const spawn = { dir, claude, flags, resume, ...(claude ? { prompt: first } : { run: first }) };
  placePane({ key: tabKey(), kind: "local", session, title: "local", cwd: dir, claude, flags, sid: sessionIdOf(resume), spawn }, where);
}

/** base, or base-2, base-3… when a session or an open pane on the machine already has the name. */
function freeSessionName(machine: string, base: string): string {
  const taken = new Set<string>();
  for (const x of state.sessions.sessions) if (x.machine === machine) taken.add(x.name);
  for (const t of state.tabs) if (tabMachine(t) === machine && t.session) taken.add(t.session);
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  return name;
}

/** Where and what a new pane "like this one" should be: same machine, same folder, same kind. */
export interface PaneContext {
  machine?: string; // undefined = this computer
  dir?: string;
  claude: boolean;
  flags?: string; // how that pane's Claude was started
}

export function paneContext(t: Tab | undefined = state.tabs.find((x) => x.key === state.activeTab)): PaneContext {
  if (t) return { machine: t.kind === "local" ? undefined : t.machine, dir: t.cwd ?? t.spawn?.dir, claude: !!t.claude, flags: t.flags };
  // Nothing open: Claude on the first machine that is up, else a terminal here.
  const up = state.machines.find((m) => m.machine.status === "running" || !m.machine.status);
  return up ? { machine: up.machine.name, claude: true } : { claude: false };
}

/**
 * Opens a pane like the focused one: same machine and folder, Claude Code if that pane runs
 * Claude and a shell otherwise (kind overrides that). No questions asked, one round trip.
 */
export function openLike(where: "group" | Dir, kind?: "claude" | "shell", from?: Tab) {
  const c = paneContext(from);
  const claude = kind ? kind === "claude" : c.claude;
  // Claude next to Claude starts the same way (the same permission mode).
  if (!c.machine) return openLocalTab(where, c.dir, claude, c.flags);
  if (claude) return openClaudeTab(c.machine, where, c.dir, c.flags);
  openShellTab(c.machine, where, c.dir);
}

/**
 * ⌘D / ⇧⌘D: split the focused pane with a shell in the same folder, on the same machine.
 * (A Claude beside it is one choice away in the pane's menu; starting one on every split got
 * in the way.)
 */
export function splitPane(dir: Dir, kind: "claude" | "shell" = "shell") {
  openLike(state.activeGroup ? dir : "group", kind);
}

/** ⌘T: a new tab like the focused pane. */
export function newTab() {
  openLike("group");
}

const folderName = (dir: string) => {
  const t = tildePath(dir, state.info?.home);
  return t === "~" || t === "" ? "~" : baseName(t);
};

// A title that only repeats where the pane is (host name, user@host:path, the shell's name)
// says nothing a folder name doesn't say better.
const HOSTY = /^[\w.-]+@[\w.-]+(:.*)?$/;
const GENERIC = /^(claude( code)?|tmux)$/i; // Claude's title before it has a task
const AGENT_STATUS = /^(action required|working|thinking|ready|idle|waiting|done)$/i;
function ownTitle(t: Tab): string {
  let own = t.termTitle?.trim() ?? "";
  if (!own || own === t.machine || HOSTY.test(own) || SHELLS.has(own) || GENERIC.test(own)) return "";
  // Agents dress the title up: a spinner ("[ . ]"), a status and the folder around the task
  // (Codex: "Action Required | Add rate limiting | api"), their own name after it (Grok).
  own = own.replace(/^\[[^\]]{0,5}\]\s*/, "");
  if (own.includes(" | ")) {
    const folder = t.cwd ? folderName(t.cwd) : "";
    own = own
      .split(" | ")
      .map((p) => p.trim())
      .filter((p) => p && !AGENT_STATUS.test(p) && p !== folder)
      .join(" | ");
  }
  own = own.replace(/\s+[-·]\s+(grok|codex|mantis)$/i, "").trim();
  return GENERIC.test(own) ? "" : own;
}

/** The name to show for a pane: what its program calls itself, else its folder. */
export function paneTitle(t: Tab): string {
  if (t.kind === "joined") return state.meta[metaKey(t)]?.name || ownTitle(t) || t.join?.title || t.title;
  return state.meta[metaKey(t)]?.name || ownTitle(t) || (t.cwd ? folderName(t.cwd) : t.kind !== "shell" && t.session && !t.session.startsWith(SHELL_PREFIX) ? t.session : t.title);
}

/** Where your own name and colour for a pane are kept: by its session, so they follow it. */
export const metaKey = (t: Tab) => `${tabMachine(t) ?? "pane"}/${t.session ?? t.key}`;
export const sessionMetaKey = (machine: string, session: string) => `${machine}/${session}`;

/** Sets or clears (with an empty value) your name or colour for a session. */
export function setMeta(key: string, patch: Meta) {
  const cur = { ...state.meta[key], ...patch };
  if (!cur.name?.trim()) delete cur.name;
  else cur.name = cur.name.trim();
  if (!cur.color) delete cur.color;
  const meta = { ...state.meta };
  if (Object.keys(cur).length) meta[key] = cur;
  else delete meta[key];
  saveJSON("sky.meta", meta);
  setState({ meta });
}

/**
 * Restarts Claude Code in a pane and resumes its conversation, so it picks up a changed
 * setting or an update. Asks first when Claude is in the middle of something.
 */
export async function restartClaude(t: Tab, confirm: (title: string, body: string) => Promise<boolean>) {
  const machine = tabMachine(t);
  if (!machine || !t.session || !liveClaude(t)) return toast("info", "Claude isn't running in this pane");
  const s = state.sessions.sessions.find((x) => x.machine === machine && x.name === t.session);
  if (s?.state === "working" && !(await confirm(`Restart Claude in ${paneTitle(t)}?`, "It is working right now. Restarting interrupts this turn; the conversation is resumed as it stands."))) return;
  toast("info", `Restarting Claude in ${paneTitle(t)}…`);
  try {
    await api.restartClaude(machine, t.session, t.sid ?? s?.sid ?? "", t.flags ?? s?.flags ?? "");
  } catch (e) {
    toast("error", "Couldn't restart Claude", errText(e));
  }
}

// ---------- recipes ----------

export function saveRecipe(r: Recipe) {
  const id = r.id || `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const next = { ...r, id, name: r.name.trim() || "Untitled" };
  const recipes = state.recipes.some((x) => x.id === id) ? state.recipes.map((x) => (x.id === id ? next : x)) : [...state.recipes, next];
  saveJSON("sky.recipes", recipes);
  setState({ recipes });
}

export function removeRecipe(id: string) {
  const recipes = state.recipes.filter((x) => x.id !== id);
  saveJSON("sky.recipes", recipes);
  setState({ recipes });
}

/** A recipe made from a pane: where it is, what it runs. */
export function recipeFrom(t?: Tab): Recipe {
  const c = paneContext(t);
  return { id: "", name: t ? paneTitle(t) : "", machine: t ? (c.machine ?? LOCAL) : "", dir: c.dir ?? "", kind: c.claude ? "claude" : "shell", flags: c.flags ?? "", prompt: "", run: "" };
}

/**
 * Runs a recipe: a new tab on its machine, in its folder, Claude with its first message or a
 * shell with its command. fill gives the values for {clipboard} and {ask} in the message.
 */
export function runRecipe(r: Recipe, fill: { clipboard?: string; ask?: string } = {}, where: "group" | Dir = "group") {
  const here = paneContext();
  const machine = r.machine || here.machine || LOCAL;
  if (machine !== LOCAL) {
    const m = state.machines.find((x) => x.machine.name === machine)?.machine;
    if (!m) return toast("error", `${r.name}: there is no machine named ${machine}`);
  }
  // No folder of its own: the focused pane's, when the recipe runs where that pane is.
  const dir = r.dir || ((here.machine ?? LOCAL) === machine ? here.dir : undefined);
  const text = (r.kind === "claude" ? r.prompt : r.run).replaceAll("{clipboard}", fill.clipboard ?? "").replaceAll("{ask}", fill.ask ?? "").trim();
  if (r.kind === "claude") openClaudeTab(machine, where, dir, r.flags || undefined, undefined, text || undefined);
  else openShellTab(machine, where, dir, text || undefined);
}

// ---------- pins and workspaces ----------

export function togglePin(id: string) {
  setState((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, pinned: !g.pinned } : g)) }));
}

/** Shows one workspace's tabs (null: every tab) and goes to the tab last used in it. */
export function setWorkspace(name: string | null) {
  if (name !== null && !state.workspaces.includes(name)) return;
  writePref("workspace", name ?? "");
  setState((s) => {
    const inside = (g: Group) => name === null || g.ws === name;
    const cur = s.groups.find((g) => g.id === s.activeGroup);
    if (cur && inside(cur)) return { workspace: name };
    const next = s.mru.map((k) => groupOf(k, s)).find((g) => g && inside(g)) ?? s.groups.find(inside);
    return { workspace: name, activeGroup: next?.id, activeTab: next?.focus };
  });
}

/** Makes a workspace (moving a tab into it when given) and shows it. */
export function addWorkspace(name: string, withGroup?: string): boolean {
  name = name.trim();
  if (!name || state.workspaces.includes(name)) return false;
  const workspaces = [...state.workspaces, name];
  saveJSON("sky.workspaces", workspaces);
  setState((s) => ({ workspaces, groups: withGroup ? s.groups.map((g) => (g.id === withGroup ? { ...g, ws: name } : g)) : s.groups }));
  setWorkspace(name);
  return true;
}

export function renameWorkspace(from: string, to: string): boolean {
  to = to.trim();
  if (!to || to === from || state.workspaces.includes(to)) return false;
  const workspaces = state.workspaces.map((w) => (w === from ? to : w));
  saveJSON("sky.workspaces", workspaces);
  if (state.workspace === from) writePref("workspace", to);
  setState((s) => ({ workspaces, workspace: s.workspace === from ? to : s.workspace, groups: s.groups.map((g) => (g.ws === from ? { ...g, ws: to } : g)) }));
  return true;
}

/** Removes a workspace; its tabs stay open and show under "All". */
export function removeWorkspace(name: string) {
  const workspaces = state.workspaces.filter((w) => w !== name);
  saveJSON("sky.workspaces", workspaces);
  if (state.workspace === name) writePref("workspace", "");
  setState((s) => ({ workspaces, workspace: s.workspace === name ? null : s.workspace, groups: s.groups.map((g) => (g.ws === name ? { ...g, ws: undefined } : g)) }));
}

/** Files a tab under a workspace (undefined: under none). */
export function moveToWorkspace(id: string, ws?: string) {
  setState((s) => {
    const groups = s.groups.map((g) => (g.id === id ? { ...g, ws } : g));
    // The tab left the workspace on show: go to the next one that is still in it.
    if (s.workspace !== null && ws !== s.workspace && s.activeGroup === id) {
      const next = s.mru.map((k) => groupOf(k, { ...s, groups })).find((g) => g && g.ws === s.workspace);
      return { groups, activeGroup: next?.id, activeTab: next?.focus };
    }
    return { groups };
  });
}

/** Closes every other tab the tab bar shows (sessions keep running). */
export function closeOtherGroups(id: string) {
  for (const g of visibleGroups()) if (g.id !== id && !g.pinned) closeGroup(g.id);
}

/** What tells a pane apart from another in the same folder: its session, or what a shell is running. */
export function paneDetail(t: Tab): string {
  if (t.kind === "session" || (t.kind === "local" && t.session && !t.session.startsWith(SHELL_PREFIX))) return t.session ?? "";
  return t.running && !SHELLS.has(t.running) ? t.running : "";
}

/** The folder a pane is in, for display ("~/code/api"); empty when unknown. */
export function paneFolder(t: Tab): string {
  return t.cwd ? tildePath(t.cwd, state.info?.home) : "";
}

export function updateTab(key: string, patch: Partial<Tab>) {
  setState((s) => ({ tabs: s.tabs.map((t) => (t.key === key ? { ...t, ...patch } : t)) }));
}

/** Closes one pane; its group closes with its last pane. Sessions keep running in tmux. */
export function closeTab(key: string) {
  const t = state.tabs.find((x) => x.key === key);
  // A shell pane's session goes with it, and so does a Claude session's once Claude has
  // left it (the backend checks that only an idle shell is in it; anything running stays).
  const m = t && tabMachine(t);
  if (t && m && t.session && (t.kind === "shell" || t.session.startsWith(SHELL_PREFIX) || (t.session.startsWith("claude") && !liveClaude(t) && !!t.running)))
    api.closeShell(m, t.session).catch(() => {});
  // A joined pane leaves the share (its forwarded ports close), unless another pane is in it.
  if (t?.kind === "joined" && t.join?.id && !state.tabs.some((x) => x.key !== key && x.join?.id === t.join?.id)) call("LeaveShare", t.join.id).catch(() => {});
  releaseTab(key);
}

/** Takes a pane away, leaving its session as it is (closing it, or moving it to another window). */
function releaseTab(key: string) {
  const t = state.tabs.find((x) => x.key === key);
  if (t?.termId) api.closeTerminal(t.termId).catch(() => {});
  setState((s) => {
    const tabs = s.tabs.filter((x) => x.key !== key);
    const g = groupOf(key, s);
    if (!g) return { tabs };
    const next = remove(g.layout, key);
    if (!next) {
      const idx = s.groups.findIndex((x) => x.id === g.id);
      const groups = s.groups.filter((x) => x.id !== g.id);
      let activeGroup = s.activeGroup;
      let activeTab = s.activeTab;
      if (activeGroup === g.id) {
        const shown = visibleGroups(s);
        const at = shown.findIndex((x) => x.id === g.id);
        const ng = at >= 0 ? (shown[at + 1] ?? shown[at - 1]) : (groups[idx] ?? groups[idx - 1]);
        activeGroup = ng?.id;
        activeTab = ng?.focus;
      }
      return { tabs, groups, activeGroup, activeTab };
    }
    let focus = g.focus;
    if (focus === key) focus = neighbor(g.layout, key, "left") ?? neighbor(g.layout, key, "up") ?? neighbor(g.layout, key, "right") ?? neighbor(g.layout, key, "down") ?? leaves(next)[0];
    if (!leaves(next).includes(focus)) focus = leaves(next)[0];
    const groups = s.groups.map((x) => (x.id === g.id ? { ...x, layout: next, focus, zoom: false } : x));
    return { tabs, groups, activeTab: s.activeGroup === g.id ? focus : s.activeTab };
  });
}

/** Closes every pane in a group. */
export function closeGroup(id: string) {
  const g = state.groups.find((x) => x.id === id);
  if (!g) return;
  for (const k of leaves(g.layout)) closeTab(k);
}

export function moveFocus(dir: "left" | "right" | "up" | "down") {
  const g = state.groups.find((x) => x.id === state.activeGroup);
  if (!g) return;
  const n = neighbor(g.layout, g.focus, dir);
  if (n) focusPane(n);
}

export function toggleZoom() {
  setState((s) => ({ groups: s.groups.map((g) => (g.id === s.activeGroup && leaves(g.layout).length > 1 ? { ...g, zoom: !g.zoom } : g)) }));
}

export function resizeGroup(id: string, path: number[], sizes: number[]) {
  setState((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, layout: resizeLayout(g.layout, path, sizes) } : g)) }));
}

export { geometry };

/** Claude Code is running in the pane right now (not just a session that once ran it). */
export function liveClaude(t: Tab): boolean {
  if (!t.claude) return false;
  if (!t.running) return !!t.spawn?.claude; // just opened: not polled yet
  return /claude/.test(t.running) || t.running === "node";
}

/** How to bring a pane's session back if it is gone: same folder, and Claude's conversation. */
function respawn(t: Tab): Tab["spawn"] {
  // A pane that never got as far as attaching is still to be made the way it was asked for.
  if (!everAttached.has(t.key) && t.spawn) return t.spawn;
  const dir = t.cwd ?? t.spawn?.dir;
  if (liveClaude(t)) return { dir, claude: true, flags: t.flags, resume: t.sid || t.spawn?.resume || (t.running ? "continue" : undefined) };
  if (t.agent) return { dir, agent: t.agent, resume: "continue" }; // another agent picks its latest conversation here back up
  return { dir };
}

// Waits between tries while a pane can't attach: quick at first (a wake, a network change),
// then slow (the machine is off, the laptop is offline). It never gives up: the session is
// still there, and the moment the connection works the pane is back.
const RETRY = [300, 800, 1500, 3000, 6000, 12000, 20000, 30000];
const attachedAt = new Map<string, number>(); // pane key → when it last attached fine
const everAttached = new Set<string>(); // panes that have shown their session at least once
const aliveAt = new Map<string, number>(); // pane key → when its session was last known to exist

/**
 * When a pane's session was last known to exist, in unix seconds; 0 when it never was (a new
 * pane) or when it doesn't matter. The machine uses it to tell a session that was ended on
 * purpose (not made again) from one lost to a restart (brought back). A plain shell pane
 * always gets its shell back: there is nothing in it to end on purpose but the pane itself.
 */
export function sessionSeen(t: Tab): number {
  if (!t.session || t.session.startsWith(SHELL_PREFIX)) return 0;
  return Math.floor((aliveAt.get(t.key) ?? 0) / 1000);
}

/** The pane attached: it is live again. */
export function paneAttached(key: string) {
  attachedAt.set(key, Date.now());
  everAttached.add(key);
  aliveAt.set(key, Date.now());
  const t = state.tabs.find((x) => x.key === key);
  if (!t) return;
  // The session exists now: its first message or command has been given and is not repeated.
  const spawn = t.spawn?.prompt || t.spawn?.run ? { ...t.spawn, prompt: undefined, run: undefined } : t.spawn;
  if (t.retry || spawn !== t.spawn) updateTab(key, { retry: undefined, spawn });
}

/** The pane's connection is gone (or never came up): let go of it and attach again shortly. */
export function dropTab(key: string, why?: string) {
  const t = state.tabs.find((x) => x.key === key);
  if (!t) return;
  if (t.termId) api.closeTerminal(t.termId).catch(() => {});
  // A pane that was up for a while starts over at quick tries; one that keeps failing backs off.
  const fresh = !t.retry && Date.now() - (attachedAt.get(key) ?? 0) > 8000;
  const n = fresh ? 1 : (t.retry?.n ?? 1) + 1;
  updateTab(key, { termId: undefined, url: undefined, exited: false, error: undefined, spawn: respawn(t), retry: { n, at: Date.now() + RETRY[Math.min(n, RETRY.length) - 1], why: why || t.retry?.why } });
}

/** Attach again right now (a wake, a click on "Retry", a machine that just came up). */
export function retryNow(key: string) {
  const t = state.tabs.find((x) => x.key === key);
  if (!t) return;
  if (t.termId) api.closeTerminal(t.termId).catch(() => {});
  attachedAt.delete(key);
  updateTab(key, { termId: undefined, url: undefined, exited: false, error: undefined, spawn: respawn(t), retry: { n: 1, at: Date.now() + 150, why: t.retry?.why } });
}

/**
 * Points a pane at a Claude session on machine, in dir, where the pane is: the same place in
 * the same tab. It is what a session moved to another device goes on in (see lib/move): a
 * new session there, picking resume up (with prompt as its next message). The pane's old
 * session is gone already; the pane starts over as one that never attached.
 */
export function movePaneTo(key: string, machine: string, dir: string, resume?: string, prompt?: string) {
  const t = state.tabs.find((x) => x.key === key);
  if (!t) return;
  if (t.termId) api.closeTerminal(t.termId).catch(() => {});
  aliveAt.delete(key); // not a session last seen a moment ago (that would read as ended on purpose)
  everAttached.delete(key);
  attachedAt.delete(key);
  const local = machine === LOCAL;
  const session = local && !state.localTmux ? undefined : freeSessionName(machine, claudeSessionName(dir));
  updateTab(key, {
    kind: local ? "local" : "session",
    machine: local ? undefined : machine,
    session,
    title: session ?? "local",
    cwd: dir,
    running: undefined,
    claude: true,
    agent: undefined,
    sid: sessionIdOf(resume),
    spawn: { dir, claude: true, flags: t.flags, resume, prompt },
    termId: undefined,
    url: undefined,
    exited: false,
    error: undefined,
    retry: { n: 1, at: Date.now() }, // attach now
  });
}

export function reattachTab(key: string) {
  const t = state.tabs.find((x) => x.key === key);
  if (!t) return;
  if (persistent(t) || t.kind === "joined") return retryNow(key);
  if (t.termId) api.closeTerminal(t.termId).catch(() => {});
  // Without tmux a local pane gets a fresh shell where the old one was.
  updateTab(key, { termId: undefined, url: undefined, exited: false, error: undefined, spawn: { dir: t.cwd ?? t.spawn?.dir }, claude: false });
}

// ---------- switching ----------


/**
 * ⌃Tab / ⌥Tab: step through tabs most-recent first, like the app switcher. The first step
 * selects the previous tab, so a quick tap flips between the last two. (⌥⌘arrows move between panes inside a tab.)
 */
export function switchStep(delta: 1 | -1, mod: Switcher["mod"]) {
  const cur = state.switcher;
  if (cur) {
    const n = cur.order.length;
    setState({ switcher: { ...cur, index: (cur.index + delta + n) % n } });
    return;
  }
  // One entry per tab the tab bar shows, most recently used first: the pane that tab would show.
  const shown = new Set(visibleGroups().map((g) => g.id));
  const order: string[] = [];
  const seen = new Set<string>();
  for (const k of state.mru) {
    const g = groupOf(k);
    if (!g || seen.has(g.id) || !shown.has(g.id)) continue;
    seen.add(g.id);
    order.push(g.focus);
  }
  if (order.length < 2) return;
  // Shown at once: the previews are what the switcher is for.
  setState({ switcher: { order, all: order, query: "", index: delta > 0 ? 1 : order.length - 1, mod, shown: true } });
}

/**
 * Typing while the switcher is up narrows it to the tabs whose name, folder, machine or
 * session contains every word typed. Nothing matching leaves the last match on show.
 */
export function switchType(key: string) {
  const sw = state.switcher;
  if (!sw) return;
  const query = key === "Backspace" ? sw.query.slice(0, -1) : sw.query + key;
  if (query === sw.query) return;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = (k: string) => {
    const g = groupOf(k);
    const panes = g ? state.tabs.filter((t) => leaves(g.layout).includes(t.key)) : [];
    return panes.map((t) => [paneTitle(t), paneFolder(t), machineLabel(tabMachine(t) ?? LOCAL), t.session ?? ""].join(" ")).join(" ").toLowerCase();
  };
  const order = words.length ? sw.all.filter((k) => words.every((w) => text(k).includes(w))) : sw.all;
  if (!order.length) return setState({ switcher: { ...sw, query, shown: true } });
  const keep = order.indexOf(sw.order[sw.index]);
  setState({ switcher: { ...sw, query, order, index: words.length ? Math.max(0, keep) : Math.max(0, keep), shown: true } });
}

/**
 * Arrow keys in the switcher: left and right step through the tabs, up and down go to the
 * preview above or below (the nearest one in that row; the rows are centred, so that is by
 * where the cards are, not by counting).
 */
export function switchMove(dir: "left" | "right" | "up" | "down") {
  const sw = state.switcher;
  if (!sw) return;
  const step = dir === "right" || dir === "down" ? 1 : -1;
  const cards = [...document.querySelectorAll<HTMLElement>("[data-switch-card]")];
  const cur = cards[sw.index];
  if (dir === "left" || dir === "right" || !cur || cards.length !== sw.order.length) {
    // An arrow means "let me look": show the previews now rather than after the hold.
    if (!sw.shown) setState({ switcher: { ...sw, shown: true } });
    return switchStep(step, sw.mod);
  }
  const at = cur.getBoundingClientRect();
  const mid = at.left + at.width / 2;
  const pick = (want: (dy: number) => boolean) => {
    let best = -1;
    let score = Infinity;
    cards.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const dy = r.top - at.top;
      if (!want(dy)) return;
      const sc = Math.abs(dy) * 10000 + Math.abs(r.left + r.width / 2 - mid); // the nearest row, then the nearest card in it
      if (sc < score) {
        score = sc;
        best = i;
      }
    });
    return best;
  };
  let to = pick((dy) => (dir === "down" ? dy > 2 : dy < -2));
  if (to < 0) {
    // Past the last row: come round to the row at the other end, or step along a single row.
    const rows = new Set(cards.map((el) => Math.round(el.getBoundingClientRect().top)));
    if (rows.size < 2) return switchStep(step, sw.mod);
    const edge = dir === "down" ? Math.min(...rows) : Math.max(...rows);
    to = pick((dy) => Math.abs(at.top + dy - edge) < 2);
  }
  if (to >= 0 && to !== sw.index) setState({ switcher: { ...sw, index: to } });
}

export function switchSelect(index: number) {
  if (state.switcher) setState({ switcher: { ...state.switcher, index } });
}

/** Go to the selected pane and close the switcher. */
export function switchCommit() {
  const sw = state.switcher;
  if (!sw) return;
  setState({ switcher: null });
  focusPane(sw.order[sw.index]);
}

export function switchCancel() {
  if (state.switcher) setState({ switcher: null });
}

/** Claude sessions waiting on the user, in a stable order. */
export function needsYou(s: State = state): Session[] {
  return s.sessions.sessions.filter((x) => x.claude && x.state === "waiting");
}

/** ⌘J: go to the next Claude session that needs you (cycles through them). */
export function jumpNeedsYou() {
  const list = needsYou();
  if (list.length === 0) {
    toast("info", "Nothing needs you");
    return;
  }
  const cur = state.tabs.find((t) => t.key === state.activeTab);
  const at = list.findIndex((x) => cur && x.machine === tabMachine(cur) && x.name === cur.session);
  const next = list[(at + 1) % list.length];
  openSessionTab(next.machine, next.name);
}

// ---------- sidebar, zoom, windows ----------

export function toggleSidebar() {
  writePref("sidebar", state.sidebar ? "0" : "1");
  setState({ sidebar: !state.sidebar });
}

export function setZoom(zoom: number) {
  const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(zoom)));
  writePref("zoom", String(z));
  applyZoom(z);
  if (z !== state.zoom) setState({ zoom: z });
}

/** Learns which window this is; windows opened from the first one keep their own preferences. */
export async function initWindow() {
  applyZoom(state.zoom);
  try {
    const win = await api.windowInfo();
    windowId = win.id;
    const zoom = loadZoom();
    applyZoom(zoom);
    // The hidden window of a headless dev run opens nothing: its saved layout would attach
    // to the user's real sessions from a window nobody sees.
    dormant = !!win.headless && isNativeWebview();
    clearForgotten(win.forgotten ?? []);
    const [layout, tmux] = await Promise.all([dormant ? "" : api.windowLayout().catch(() => ""), api.localTmux().catch(() => null)]);
    opening = layout;
    const ws = readPref("workspace", false);
    setState({ win, zoom, sidebar: readPref("sidebar") !== "0", winReady: true, welcome: !dormant && windowId === MAIN && readPref(WELCOMED) === null, localTmux: !!tmux?.installed, workspace: ws && state.workspaces.includes(ws) ? ws : null });
  } catch {
    setState({ winReady: true }); // a browser without the backend: stay "main"
  }
}

/** Clears what windows closed for good left in storage: their tabs and their own settings. */
function clearForgotten(ids: string[]) {
  const gone = ids.filter((id) => id !== windowId);
  if (!gone.length) return;
  try {
    for (const id of gone) {
      // The first window's zoom and sidebar are every new window's defaults: they stay.
      const names = id === MAIN ? [LAYOUT, "workspace"] : [LAYOUT, "workspace", "zoom", "sidebar"];
      for (const name of names) localStorage.removeItem(id === MAIN ? `sky.${name}` : `sky.${name}.${id}`);
    }
  } catch {
    return; // storage unavailable: try again next time
  }
  api.windowsCleared(gone).catch(() => {});
}

// What this window opens with, from the app: panes handed to it by another window, else its
// own tabs from last time. (Page storage is only the fallback, for tabs from before: windows
// are separate processes, and only one of them gets its page storage written to disk.)
let opening = "";

// Layout persistence: every tab and pane comes back when the app reopens. Panes attach to
// their sessions again by name; a session that is gone (the machine restarted, this computer
// did) is made again in the folder it was in, with Claude resuming its conversation.
const LAYOUT = "layout.v1";
type SavedPane = Pick<Tab, "key" | "kind" | "machine" | "session" | "title" | "cwd" | "sid" | "flags" | "agent" | "join"> & { claude?: boolean; seen?: number; at?: number };

let dormant = false;
let keptShells = "";
let keptLayout = "";

export function saveLayout() {
  if (dormant) return;
  const panes: SavedPane[] = state.tabs.map((t) => ({ key: t.key, kind: t.kind, machine: t.machine, session: t.session, title: t.title, cwd: t.cwd ?? t.spawn?.dir, sid: t.sid, flags: t.flags, claude: liveClaude(t), agent: t.agent, join: t.join, seen: aliveAt.get(t.key), at: t.key === state.activeTab ? Date.now() : lastActive.get(t.key) }));
  const groups = state.groups.map((g) => ({ ...g, zoom: false }));
  const layout = JSON.stringify({ panes, groups, activeGroup: state.activeGroup });
  if (layout !== keptLayout) {
    keptLayout = layout;
    api.saveWindowLayout(layout).catch(() => {});
  }
  // The sessions these panes show: another window asked to show one sends the user here,
  // and the shells among them are not for tidying up, attached right now or not.
  const keys = [...new Set(state.tabs.flatMap((t) => (tabMachine(t) && t.session ? [`${tabMachine(t)}/${t.session}`] : [])))].sort();
  const sig = keys.join("\n");
  if (sig !== keptShells) {
    keptShells = sig;
    api.windowSessions(keys).catch(() => {});
  }
}

type SavedLayout = { panes: SavedPane[]; groups: Group[]; activeGroup?: string };

/** A layout with its panes under other names. */
const renameLeaves = (l: Layout, name: (k: string) => string): Layout => ("pane" in l ? { pane: name(l.pane) } : { ...l, children: l.children.map((c) => renameLeaves(c, name)) });

/**
 * A saved layout made to join tabs that are open already: every pane and tab gets a new name,
 * and a pane whose session is open here already is left out.
 */
function rekey(saved: SavedLayout): SavedLayout {
  const names = new Map<string, string>();
  const panes = saved.panes.filter((p) => !(p.session && paneForSession(p.kind === "local" ? LOCAL : (p.machine ?? ""), p.session)));
  for (const p of panes) names.set(p.key, tabKey());
  const ids = new Map<string, string>();
  const groups: Group[] = [];
  for (const g of saved.groups ?? []) {
    let layout: Layout | null = g.layout;
    for (const k of leaves(g.layout)) if (!names.has(k)) layout = layout && remove(layout, k);
    if (!layout) continue;
    const id = groupID();
    ids.set(g.id, id);
    groups.push({ ...g, id, layout: renameLeaves(layout, (k) => names.get(k) ?? k), focus: names.get(g.focus) ?? names.get(leaves(layout)[0]) ?? "" });
  }
  return { panes: panes.map((p) => ({ ...p, key: names.get(p.key)! })), groups, activeGroup: saved.activeGroup && ids.get(saved.activeGroup) };
}

export function restoreLayout(machineNames: string[]) {
  try {
    const raw = opening || readPref(LAYOUT, false);
    opening = "";
    if (!raw || dormant) return;
    // Tabs opened before the saved ones came back stay; the saved ones join them.
    const before = state.tabs.length > 0;
    let saved = JSON.parse(raw) as SavedLayout;
    if (before) saved = rekey(saved);
    const known = new Set(machineNames);
    const kinds = new Set(["session", "shell", "local", "joined"]);
    const panes = saved.panes.filter((p) => kinds.has(p.kind) && (p.kind === "local" || (p.kind === "joined" ? !!p.join?.link : p.machine && known.has(p.machine))));
    const keep = new Set(panes.map((p) => p.key));
    const groups: Group[] = [];
    for (const g of saved.groups ?? []) {
      let layout: Layout | null = g.layout;
      for (const k of leaves(g.layout)) if (!keep.has(k)) layout = layout && remove(layout, k);
      if (layout) groups.push({ ...g, layout, focus: keep.has(g.focus) ? g.focus : leaves(layout)[0], zoom: false, ws: g.ws && state.workspaces.includes(g.ws) ? g.ws : undefined });
    }
    const used = new Set(groups.flatMap((g) => leaves(g.layout)));
    // Claude panes per machine and folder: "the latest conversation in the folder" is only
    // safe where a single Claude was working.
    const sharing = new Map<string, number>();
    for (const p of panes) if (p.claude) sharing.set(`${p.machine ?? LOCAL}\n${p.cwd}`, (sharing.get(`${p.machine ?? LOCAL}\n${p.cwd}`) ?? 0) + 1);
    const tabs = panes
      .filter((p) => used.has(p.key))
      .map(({ claude, seen, at, ...p }): Tab => {
        if (seen) aliveAt.set(p.key, seen);
        if (at) lastActive.set(p.key, at);
        // If the session is gone it comes back where it was; Claude picks its conversation up
        // (by its ID; without one, the folder's latest only when no other Claude shares it).
        const alone = (sharing.get(`${p.machine ?? LOCAL}\n${p.cwd}`) ?? 0) <= 1;
        const resume = p.sid || (alone ? "continue" : undefined);
        const spawn: Tab["spawn"] = claude ? { dir: p.cwd, claude: true, resume, flags: p.flags } : p.agent ? { dir: p.cwd, agent: p.agent, resume: "continue" } : { dir: p.cwd };
        if (p.kind === "session") return { ...p, claude, spawn };
        if (p.kind === "joined") return { ...p, claude: undefined, sid: undefined }; // joins again when it is shown
        // Every shell pane has a session name, so none opens an anonymous shell on a machine.
        if (p.kind === "shell") return { ...p, session: p.session || shellName(), spawn };
        // Without tmux here a local pane is a new shell in the folder it was in.
        if (!state.localTmux) return { ...p, session: undefined, sid: undefined, flags: undefined, spawn: { dir: p.cwd } };
        return { ...p, session: p.session || shellName(), claude, spawn };
      });
    tabSeq = Math.max(tabSeq, ...tabs.map((t) => Number(t.key.slice(1)) || 0));
    groupSeq = Math.max(groupSeq, ...groups.map((g) => Number(g.id.slice(1)) || 0));
    if (!tabs.length) return;
    if (before) {
      // What is open stays in front; the saved tabs join it.
      setState((s) => ({ tabs: [...s.tabs, ...tabs], groups: [...s.groups, ...groups] }));
      return;
    }
    const active = groups.find((g) => g.id === saved.activeGroup) ?? groups[0];
    // The tab in front decides the workspace on show, so the app opens on what was open.
    const workspace = state.workspace !== null && active.ws !== state.workspace ? (active.ws ?? null) : state.workspace;
    setState({ tabs, groups, activeGroup: active.id, activeTab: active.focus, workspace });
  } catch {
    /* ignore a bad saved layout */
  } finally {
    // The layout is kept from now on; not before, so a window that hasn't brought its tabs
    // back yet can't write over them.
    layoutRestored = true;
    saveLayoutSoon();
  }
}

// ---------- keeping the layout ----------

let layoutRestored = false;
let layoutTimer: number | undefined;

function saveLayoutSoon() {
  if (!layoutRestored) return;
  window.clearTimeout(layoutTimer);
  layoutTimer = window.setTimeout(flushLayout, 300);
}

function flushLayout() {
  window.clearTimeout(layoutTimer);
  layoutTimer = undefined;
  if (layoutRestored) saveLayout();
}

/**
 * Keeps the layout saved: soon after tabs, splits or the tab in front change, and at once when
 * the window goes away (whatever is still waiting is written then). Outside React, so nothing
 * re-renders for it.
 */
function watchLayout() {
  let tabs = state.tabs;
  let groups = state.groups;
  let active = state.activeGroup;
  listeners.add(() => {
    if (state.tabs === tabs && state.groups === groups && state.activeGroup === active) return;
    tabs = state.tabs;
    groups = state.groups;
    active = state.activeGroup;
    saveLayoutSoon();
  });
  const now = () => {
    if (layoutTimer !== undefined) flushLayout();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") now();
  });
  window.addEventListener("pagehide", now);
}

export function sessionFor(tab: Tab | undefined, sessions: Session[]): Session | undefined {
  if (!tab?.session) return undefined;
  const m = tabMachine(tab);
  return sessions.find((s) => s.machine === m && s.name === tab.session);
}

// ---------- theme ----------

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem("sky.theme", theme);
  } catch {
    /* storage unavailable */
  }
  setState({ theme });
  applyTheme(theme);
}

/** Shows the theme for the mode: data-theme says dark or light, data-skin which theme. */
export function applyTheme(theme: Theme) {
  installThemes();
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.skin = themeById(dark ? state.skins.dark : state.skins.light, dark).id;
}

/** The theme on screen right now. */
export function activeSkin(): AppTheme {
  const root = document.documentElement;
  const dark = root.dataset.theme !== "light";
  return themeById(root.dataset.skin, dark);
}

/**
 * Picks a theme. It becomes the dark or the light theme (whichever it is); unless the app
 * follows the system, it is also shown right away.
 */
export function pickSkin(id: string) {
  const t = themeById(id, true).id === id ? themeById(id, true) : themeById(id, false);
  const skins = { ...state.skins, [t.dark ? "dark" : "light"]: t.id };
  const theme: Theme = state.theme === "system" ? "system" : t.dark ? "dark" : "light";
  try {
    localStorage.setItem(`sky.skin.${t.dark ? "dark" : "light"}`, t.id);
    localStorage.setItem("sky.theme", theme);
  } catch {
    /* storage unavailable */
  }
  setState({ skins, theme });
  applyTheme(theme);
}

export function setTermPrefs(patch: Partial<TermPrefs>) {
  const term = { ...state.term, ...patch };
  try {
    localStorage.setItem("sky.term", JSON.stringify(term));
  } catch {
    /* storage unavailable */
  }
  setState({ term });
}

// Following the system: switch when macOS switches.
try {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "system") applyTheme("system");
  });
} catch {
  /* no matchMedia */
}

export function isDark(): boolean {
  return document.documentElement.dataset.theme !== "light";
}

// ---------- wiring backend events ----------

let wired = false;
// Lines from running operations come in bursts (a build prints hundreds a second): they are
// taken in together, once a frame, instead of one re-render each.
let opQueue: OpEvent[] = [];
let opQueued = false;
function takeOpEvents() {
  opQueued = false;
  if (!opQueue.length) return;
  const batch = opQueue;
  opQueue = [];
  const byOp = new Map<string, OpEvent[]>();
  for (const ev of batch) {
    const list = byOp.get(ev.op);
    if (list) list.push(ev);
    else byOp.set(ev.op, [ev]);
  }
  setState((s) => {
    const ops = { ...s.ops };
    for (const [id, evs] of byOp) {
      const cur = ops[id];
      if (!cur) continue;
      let events = [...cur.events, ...evs];
      if (events.length > 3000) events = events.slice(-2000);
      const step = evs.findLast((e) => e.level !== "log");
      ops[id] = { ...cur, info: step ? { ...cur.info, lastLine: step.message } : cur.info, events };
    }
    return { ops };
  });
}

export function wireEvents() {
  watchLayout();
  if (wired) return;
  wired = true;
  on<string>("app-icon", (appIcon) => setState((s) => (s.info ? { info: { ...s.info, appIcon } } : {})));
  on<OpInfo>("op:start", (info) => {
    setState((s) => ({
      ops: { ...s.ops, [info.id]: { info, events: [] } },
      opOrder: [info.id, ...s.opOrder.filter((x) => x !== info.id)].slice(0, 60),
    }));
  });
  on<OpEvent>("op", (ev) => {
    opQueue.push(ev);
    if (opQueued) return;
    opQueued = true;
    // Once a frame, or soon in a window that isn't drawing frames (hidden).
    requestAnimationFrame(takeOpEvents);
    window.setTimeout(takeOpEvents, 100);
  });
  on<OpEnd>("op:end", (end) => {
    takeOpEvents(); // its last lines first
    const cur = state.ops[end.op];
    setState((s) => {
      const c = s.ops[end.op];
      if (!c) return {};
      return { ops: { ...s.ops, [end.op]: { ...c, end, info: { ...c.info, running: false, error: end.error } } } };
    });
    const title = cur?.info.title ?? "Operation";
    if (end.error) {
      toast("error", `${title} failed`, end.error, { label: "Details", run: () => setState({ modal: { type: "op", id: end.op } }) });
    } else if (!quiet.has(end.op)) {
      toast("success", `${title} — done`);
    }
    quiet.delete(end.op);
    (waiters.get(end.op) ?? []).forEach((w) => w(end));
    waiters.delete(end.op);
  });
  on<Session>("session:attention", (s) => toastSession(s));
  on<MachineView[]>("machines", (machines) => {
    const isUp = (m: MachineView) => m.machine.status === "running" || !m.machine.status;
    const wasUp = new Set(state.machines.filter(isUp).map((m) => m.machine.name));
    setState({ machines, machinesLoaded: true, machinesKnown: true });
    // A machine that just came up: panes waiting on it attach now, not at their next try.
    const cameUp = new Set(machines.filter((m) => isUp(m) && !wasUp.has(m.machine.name)).map((m) => m.machine.name));
    for (const t of state.tabs) if (t.retry && t.machine && cameUp.has(t.machine)) retryNow(t.key);
  });
  // The computer slept: every connection to a machine is dead, whatever it still claims.
  // Panes attach again to the same sessions, which kept running. (Local panes never left.)
  on<{ slept: number }>("wake", () => {
    for (const t of state.tabs) if (t.kind !== "local" && (t.termId || t.retry)) retryNow(t.key);
  });
  on<APIKeyView[]>("keys", (keys) => setState({ keys: keys ?? [] }));
  on<ClaudeAccountView[]>("claude:accounts", (claudeAccounts) => setState({ claudeAccounts: claudeAccounts ?? [] }));
  // A /login here switched to an account the pool doesn't have: its browser approval opened.
  on<string>("claude:adding", (email) => {
    toast("info", `Adding ${email}`, "Approve it in the browser window that opened. Once added, sessions use it, and switching back to it never needs a sign-in again.", {
      label: "Accounts",
      run: () => setState({ view: "accounts" }),
    });
  });
  on<TickResult>("claude:switched", (r) => {
    const why = r.followed ? "Claude Code on this Mac signed in to it with /login." : `${r.from}: ${r.reason}.`;
    toast("info", `Sessions now use ${r.to}`, `${why}${r.restarted ? ` Resumed ${r.restarted} session${r.restarted === 1 ? "" : "s"}.` : ""}`, {
      label: "Accounts",
      run: () => setState({ view: "accounts" }),
    });
  });
  on<SessionsView>("sessions", applySessions);
  // Settings another window changed (see lib/prefs): into this page's storage, and the ones
  // on screen take effect at once.
  on<Record<string, string>>("prefs", (prefs) => {
    const changed = takePrefs(prefs ?? {});
    if (changed.has("sky.meta")) setState({ meta: loadJSON<Record<string, Meta>>("sky.meta", {}) });
    if (changed.has("sky.workspaces")) {
      const workspaces = loadJSON<string[]>("sky.workspaces", []);
      setState((s) => ({
        workspaces,
        workspace: s.workspace !== null && !workspaces.includes(s.workspace) ? null : s.workspace,
        groups: s.groups.map((g) => (g.ws && !workspaces.includes(g.ws) ? { ...g, ws: undefined } : g)),
      }));
    }
    if (changed.has("sky.theme") || changed.has("sky.skin.dark") || changed.has("sky.skin.light")) {
      setState({ theme: loadTheme(), skins: loadSkins() });
      applyTheme(state.theme);
    }
    if (changed.has("sky.term")) setState({ term: loadTermPrefs() });
  });
  on<UpdateInfo>("update", (update) => setState({ update }));
  api.updateInfo().then((update) => setState({ update }), () => {});
  // Another window sent the user here for a session this one shows, or took it.
  on<{ verb: string; machine: string; session: string }>("window-ask", ({ verb, machine, session }) => {
    const t = paneForSession(machine, session);
    if (!t) return;
    if (verb === "show") focusPane(t.key);
    if (verb === "release") releaseTab(t.key);
  });
  // Sessions moved onto the account machines switched to (restarted with their conversation).
  on<{ count: number; names: string; account: string }>("claude:moved", (m) => {
    toast("info", `${m.count === 1 ? "A session" : `${m.count} sessions`} moved to ${m.account || "the new account"}`, `${m.names} restarted on the new login, conversation kept.`);
  });
  on<Tunnel[]>("tunnels", (tunnels) => setState({ tunnels: tunnels ?? [] }));
  on<Record<string, SyncResult>>("sync:results", (syncResults) => setState({ syncResults: syncResults ?? {} }));
  on<{ id: string; on: boolean; error?: string }>("watch", (w) => {
    setState((s) => {
      const has = s.watching.includes(w.id);
      if (w.on && !has) return { watching: [...s.watching, w.id] };
      if (!w.on && has) return { watching: s.watching.filter((x) => x !== w.id) };
      return {};
    });
    if (w.error) toast("error", "Folder watch stopped", w.error);
  });
}

/** Installs the downloaded update: every window quits and comes back on the new version. */
export function restartToUpdate() {
  api.restartToUpdate().catch((e) => toast("error", "Couldn't update", errText(e)));
}
