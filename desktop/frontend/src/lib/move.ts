// Moving a session to another device from its pane (the cloud button), so it carries on there
// in the same place: the same tab, the same split.
//
// Between this Mac and a machine the session keeps working while its folder and conversations
// are copied over (the backend's PrecopyMove: rsync, only what changed each time). Then the
// move waits for a quiet moment, Claude's turn over and none of its agents at work, so nothing
// in flight is cut short ("Move now" doesn't wait). Only then does the session stop: the last
// changes go over in seconds (MoveSession) and the pane picks the conversation up there. Between
// two machines nothing can go ahead: the session stops and everything goes after.
//
// What stays behind is what each device runs or builds for itself: programs that were running
// (servers, background commands) and dependency folders. A session that was in the middle of
// something is told so as its next message, and goes on; one at rest waits for you. Off this Mac,
// its folder here keeps following what the session writes there (the backend's mirrors).
import { useSyncExternalStore } from "react";
import { api, call, type Session } from "./api";
import { getState, LOCAL, machineLabel, movePaneTo, runOp, sessionFor, tabMachine, toast, updateTab, waitOp, type Tab } from "./store";

interface MoveResult {
  toDir: string; // where the folder is now, on the other device
}

interface Precopy {
  ahead: boolean; // false: this move can't go ahead of time; everything goes after the stop
  toDir: string;
}

/**
 * A pane's move, while there is one. copying: the folder is on its way while the session works;
 * waiting: copied, the move waits for a quiet moment (why says for what); moving: the session
 * stopped and is on its way (the pane let go of it); arriving: attaching there.
 */
export interface Moving {
  to: string;
  phase: "copying" | "waiting" | "moving" | "arriving";
  op?: string; // the operation running now: the copy, or the move
  why?: string;
  now?: boolean; // move as soon as it is copied, whatever it is doing
}

const moving = new Map<string, Moving>();
const subs = new Set<() => void>();
function set(key: string, m: Moving | null) {
  if (m) moving.set(key, m);
  else moving.delete(key);
  for (const f of subs) f();
}
const patch = (key: string, p: Partial<Moving>) => {
  const m = moving.get(key);
  if (m) set(key, { ...m, ...p });
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

/** Moves that can still be called off or hurried, and a way to end their wait early. */
const control = new Map<string, { cancelled: boolean; wake?: () => void }>();

/** The pane's move, while there is one. */
export const useMoving = (key: string) => useSyncExternalStore(subscribe, () => moving.get(key));

/** The pane let go of its session to move it: it doesn't attach until the session is there. */
export const holdsOff = (key: string) => moving.get(key)?.phase === "moving";

/** The pane shows its session again, where it moved to. */
export function arrived(key: string) {
  if (moving.get(key)?.phase === "arriving") set(key, null);
}

/** A device as a person names it. */
export const deviceName = (d: string) => (d === LOCAL ? "This Mac" : machineLabel(d));
const deviceIn = (d: string) => (d === LOCAL ? "this Mac" : machineLabel(d));

/** Whether a pane's session can move: Claude, in a folder, in a session that outlives the pane. */
export function canMove(tab: Tab, session?: Session): boolean {
  return !!tabMachine(tab) && !!tab.session && !!(tab.claude || session?.claude) && !!(tab.cwd ?? session?.path);
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Waits ms, or less when the move is hurried or called off. */
function pause(key: string, ms: number) {
  return new Promise<void>((res) => {
    const c = control.get(key);
    const t = window.setTimeout(done, ms);
    function done() {
      window.clearTimeout(t);
      if (c) c.wake = undefined;
      res();
    }
    if (c) c.wake = done;
  });
}

/** What a session is in the middle of, that a move now would cut short ("" when nothing). */
async function busyWith(key: string, from: string): Promise<{ why: string; agents: string[] }> {
  const st = getState();
  const tab = st.tabs.find((t) => t.key === key);
  const session = sessionFor(tab, st.sessions.sessions);
  const sid = tab?.sid ?? session?.sid;
  const agents = sid ? await call<string[]>("RunningAgents", from, sid).catch(() => [] as string[]) : [];
  if (agents.length) return { why: `${plural(agents.length, "agent")} at work`, agents };
  if (session?.state === "working") return { why: "Claude is working", agents };
  return { why: "", agents };
}

/** Copies the folder ahead. "no": this move can't go ahead of time. */
async function copyAhead(key: string, from: string, to: string, dir: string, name: string): Promise<"copied" | "no" | "failed"> {
  let op = "";
  try {
    op = await runOp(call<string>("PrecopyMove", from, to, dir), true);
  } catch {
    return "failed"; // couldn't start: runOp said so
  }
  patch(key, { op });
  const end = await waitOp(op);
  if (end.error) {
    if (end.error !== "cancelled") toast("error", `Couldn't copy ${name} to ${deviceIn(to)}`, end.error);
    return "failed";
  }
  return (end.result as Precopy | undefined)?.ahead ? "copied" : "no";
}

/** Sends the pane's session to another device, and goes on there. */
export async function moveSession(tab: Tab, session: Session | undefined, to: string) {
  const key = tab.key;
  const from = tabMachine(tab);
  const dir = tab.cwd ?? session?.path;
  if (!from || !dir || !tab.session || moving.has(key) || from === to) return;
  const name = dir.split("/").filter(Boolean).pop() ?? dir;
  const c = { cancelled: false };
  control.set(key, c);
  set(key, { to, phase: "copying" });

  // While it works: the folder goes ahead, then the move waits for a quiet moment, copying
  // what changed every minute so what is left for the move stays small.
  const ahead = await copyAhead(key, from, to, dir, name);
  if (ahead === "failed" || c.cancelled) {
    if (control.get(key) === c) {
      control.delete(key);
      set(key, null);
    }
    return;
  }
  let cut: string[] = []; // agents a "Move now" stops before they finish
  if (ahead === "copied") {
    let synced = Date.now();
    for (;;) {
      if (c.cancelled) return;
      const now = !!moving.get(key)?.now;
      const busy = await busyWith(key, from);
      if (c.cancelled) return;
      if (now || !busy.why) {
        cut = busy.agents;
        break;
      }
      patch(key, { phase: "waiting", why: busy.why });
      await pause(key, 8_000);
      if (!c.cancelled && !moving.get(key)?.now && Date.now() - synced > 60_000) {
        if ((await copyAhead(key, from, to, dir, name)) === "failed" && c.cancelled) return;
        synced = Date.now();
      }
    }
  }
  control.delete(key);
  await switchOver(key, from, to, dir, cut);
}

/** The move itself: the session stops here, what is left goes over, and the pane picks it up there. */
async function switchOver(key: string, from: string, to: string, dir: string, cut: string[]) {
  const st = getState();
  const tab = st.tabs.find((t) => t.key === key);
  if (!tab?.session) return set(key, null);
  const session = sessionFor(tab, st.sessions.sessions);
  const sid = tab.sid ?? session?.sid;
  const ports = st.ports[from]?.[tab.session]?.length ?? 0;
  const busy = session?.state === "working" || session?.state === "waiting" || ports > 0 || cut.length > 0;
  set(key, { to, phase: "moving" });
  // The pane lets go first: the session ending would otherwise read as the end of the pane.
  if (tab.termId) api.closeTerminal(tab.termId).catch(() => {});
  updateTab(key, { termId: undefined, url: undefined, retry: undefined });

  let op = "";
  let res: MoveResult | undefined;
  try {
    op = await runOp(call<string>("MoveSession", from, tab.session, to, dir), true);
    patch(key, { op });
    const end = await waitOp(op);
    if (!end.error) res = end.result as MoveResult; // a failure says why in its own toast
  } catch {
    /* couldn't start: runOp said so */
  }
  if (!res) {
    // Still where it was. If it had stopped before the send failed, it is made again there
    // from its conversation; if not, the pane just attaches to it again.
    const stopped = !!op && getState().ops[op]?.events.some((e) => e.message.startsWith("Stopping it on"));
    set(key, null);
    if (stopped) movePaneTo(key, from, dir, sid);
    else updateTab(key, { retry: { n: 1, at: Date.now() } });
    return;
  }
  set(key, { to, op, phase: "arriving" });
  const note = busy ? arrivalNote(from, to, res.toDir, ports > 0, cut) : undefined;
  // Its own conversation, by its ID: the newest in the folder could be another pane's.
  movePaneTo(key, to, res.toDir, sid || undefined, note);
  window.setTimeout(() => arrived(key), 45_000); // in case it never shows: the pane says why itself
}

/** Moves now, without waiting for a quiet moment (whatever is at work stops). */
export function moveNow(key: string) {
  patch(key, { now: true });
  control.get(key)?.wake?.();
}

/** Calls a move off before the session stopped: it stays here, and what went ahead is forgotten. */
export function cancelMove(tab: Tab) {
  const key = tab.key;
  const m = moving.get(key);
  const c = control.get(key);
  const from = tabMachine(tab);
  const dir = tab.cwd;
  if (!m || !c || m.phase === "moving" || m.phase === "arriving") return;
  c.cancelled = true;
  c.wake?.();
  control.delete(key);
  if (m.op && getState().ops[m.op]?.info.running) api.cancelOp(m.op).catch(() => {});
  set(key, null);
  if (from && dir) call("DropPrecopy", from, m.to, dir).catch(() => {});
}

/** The next message for a session moved in the middle of its work. */
function arrivalNote(from: string, to: string, dir: string, servers: boolean, cut: string[]): string {
  const was = from === LOCAL ? "this Mac" : from;
  const now = to === LOCAL ? "this Mac" : to;
  return [
    `(This session was just moved from ${was} to ${now}; the folder is now ${dir}.`,
    `Dependency folders such as node_modules and .venv, and everything that was running${servers ? " (dev servers included)" : ""}, stayed behind.`,
    cut.length ? `These agents were stopped before they finished: ${cut.map((a) => `"${a}"`).join(", ")}.` : "",
    `Reinstall and restart what you need, then carry on where you left off.)`,
  ]
    .filter(Boolean)
    .join(" ");
}
