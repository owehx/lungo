// The sidebar: where to go (an icon row), every session that is running, and Claude usage.
// It is built for many sessions at once: rows say what a session is, where it is and how it
// is doing; the list is grouped by what needs you (or by machine), and a filter narrows it.
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  AppWindow,
  ArrowDownToLine,
  BrushCleaning,
  ChevronRight,
  Columns2,
  GitBranch,
  ListTree,
  LayoutGrid,
  Monitor,
  Pencil,
  Plus,
  Rows3,
  Search,
  Server,
  SlidersHorizontal,
  SquareTerminal,
  TerminalSquare,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type { MachineView, Session } from "../lib/api";
import {
  LOCAL,
  getState,
  tabMachine,
  openLocalTab,
  openSessionTab,
  openInNewWindow,
  openHere,
  paneTitle,
  focusGroup,
  restartToUpdate,
  paneForSession,
  placeSessionBy,
  placePaneBy,
  separateGroup,
  closeGroup,
  sessionFor,
  openShellTab,
  opsRunning,
  setState,
  useStore,
  type View,
  type State,
  type Group,
  focusPane,
  isIdleShell,
  paneContext,
  COLORS,
  colorValue,
  machineLabel,
  sessionMetaKey,
  setMeta,
  toast,
  loadSessions,
  visibleGroups,
  openTogether,
  closeTab,
  type Tab,
} from "../lib/store";
import { askJoin, firstName, shareFor, usePresence, useShares } from "../lib/collab";
import { Avatars, JoinedIcon } from "./Share";
import { getDragged, setDragged } from "../lib/drag";
import { openScreen } from "../lib/screen";
import { leaves, type Layout } from "../lib/panes";
import { tabMenu } from "../views/Sessions";
import { appIconSrc } from "../lib/appicons";
import { agentOf, ago, cx, hasAgent, mod, sessionTime, sessionTone, tildePath } from "../lib/util";
import { IconButton, SidebarToggle, WorkingMark, Spinner } from "./ui";
import { AgentIcon, LocalIcon, ProviderIcon } from "./Brand";
import { askConfirm, askText, showMenu, type MenuRow } from "./ContextMenu";
import { agentRows } from "./AgentMenu";
import { api, errText } from "../lib/api";
import { UsageFooter } from "./UsageFooter";
import { NavIcon, type NavIconName } from "./NavIcons";
import { useHealth, useStartsOnDemand } from "../lib/health";

const nav: { id: View & NavIconName; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "sessions", label: "Sessions" },
  { id: "machines", label: "Machines" },
  { id: "sync", label: "Sync" },
  { id: "folders", label: "Projects" },
  { id: "accounts", label: "Accounts and keys" },
  { id: "settings", label: "Settings" },
];

type Mode = "status" | "machine";
const pref = (k: string, fallback: string) => {
  try {
    return localStorage.getItem(k) ?? fallback;
  } catch {
    return fallback;
  }
};
const setPref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
};

/** A Claude session that has ended: only its shell is left in tmux. */
const finished = (s: Session) => s.name.startsWith("claude") && !s.state && !/claude|^node$/.test(s.command);

/** What a session is doing, for grouping and ordering: what needs you comes first. */
type Bucket = "waiting" | "working" | "idle" | "done";
function bucket(s: Session): Bucket {
  if (finished(s)) return "done";
  if (hasAgent(s) && s.state === "waiting") return "waiting";
  if (hasAgent(s) && s.state === "working") return "working";
  return "idle";
}
const BUCKETS: { id: Bucket; label: string }[] = [
  { id: "waiting", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "idle", label: "Idle" },
  { id: "done", label: "Finished" },
];
const rank: Record<Bucket, number> = { waiting: 0, working: 1, idle: 2, done: 3 };
/** Most urgent first, then most recently active. */
const byUrgency = (a: Session, b: Session) => rank[bucket(a)] - rank[bucket(b)] || sessionTime(b) - sessionTime(a);

const keyOf = (s: Session) => `${s.machine}/${s.name}`;

/**
 * Picking several sessions to open together: ⌘-click adds or removes one, ⇧-click takes the
 * range from the last one picked. A plain click opens a session as always.
 */
interface Picking {
  picked: Set<string>;
  click: (e: React.MouseEvent, s: Session) => void;
}
const PickContext = createContext<Picking>({ picked: new Set(), click: () => {} });

export function Sidebar() {
  const view = useStore((s) => s.view);
  const machines = useStore((s) => s.machines);
  const sessionsView = useStore((s) => s.sessions);
  const platform = useStore((s) => s.info?.platform);
  const appIcon = useStore((s) => s.info?.appIcon);
  const tabs = useStore((s) => s.tabs);
  const activeTab = useStore((s) => s.activeTab);
  const meta = useStore((s) => s.meta);
  const shown = useStore((s) => s.sidebar);
  const [mode, setModeState] = useState<Mode>(() => (pref("sky.sidebar.mode", "status") === "machine" ? "machine" : "status"));
  const [filter, setFilter] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const setMode = (m: Mode) => {
    setPref("sky.sidebar.mode", m);
    setModeState(m);
  };

  // Each window lists what it has open, like a terminal window its tabs. Everything else that
  // is running (in another window, or in none) waits folded at the bottom: "Other sessions".
  // A shell sitting at its prompt is listed only while a pane here shows it.
  const here = useMemo(() => new Set(tabs.filter((t) => t.session && !t.exited).map((t) => `${tabMachine(t)}/${t.session}`)), [tabs]);
  const hereCount = useMemo(() => sessionsView.sessions.filter((s) => here.has(keyOf(s))).length, [sessionsView, here]);
  const [sessions, others] = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (s: Session) => {
      if (!words.length) return true;
      const text = [meta[sessionMetaKey(s.machine, s.name)]?.name, s.title, s.name, s.path, machineLabel(s.machine), s.branch].join(" ").toLowerCase();
      return words.every((w) => text.includes(w));
    };
    const mine: Session[] = [];
    const rest: Session[] = [];
    for (const s of sessionsView.sessions) {
      if (!match(s)) continue;
      if (here.has(keyOf(s))) mine.push(s);
      else if (!isIdleShell(s)) rest.push(s);
    }
    return [mine, rest.sort(byUrgency)];
  }, [sessionsView, filter, meta, here]);
  // The list by status, worked out when the sessions change (not on every render).
  const byBucket = useMemo(() => {
    const m = Object.fromEntries(BUCKETS.map((b) => [b.id, [] as Session[]])) as Record<Bucket, Session[]>;
    for (const s of sessions) m[bucket(s)].push(s);
    for (const list of Object.values(m)) list.sort(byUrgency);
    return m;
  }, [sessions]);
  const byMachine = useMemo(() => {
    const m: Record<string, Session[]> = {};
    for (const s of sessions) (m[s.machine] ??= []).push(s);
    for (const list of Object.values(m)) list.sort(byUrgency);
    return m;
  }, [sessions]);

  const waiting = sessionsView.sessions.filter((s) => hasAgent(s) && s.state === "waiting").length;
  const activeKey = (() => {
    const t = tabs.find((x) => x.key === activeTab);
    if (!t) return "";
    const m = tabMachine(t);
    // A local pane that isn't one of the sessions listed lights up "This computer" itself.
    if (t.kind === "local" && !(m && (byMachine[LOCAL] ?? []).some((x) => x.name === t.session))) return "local";
    return m ? `${m}/${t.session}` : "";
  })();

  // The rows in the order they are shown, for ⇧-click ranges.
  const ordered = useMemo(() => {
    const order = [...machines.map((m) => m.machine.name), LOCAL];
    if (mode === "machine") return order.flatMap((m) => byMachine[m] ?? []);
    return BUCKETS.flatMap((b) => order.flatMap((m) => (byMachine[m] ?? []).filter((s) => bucket(s) === b.id)));
  }, [machines, byMachine, mode]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  // Sessions that went away leave the selection.
  useEffect(() => {
    const live = new Set(ordered.map(keyOf));
    setPicked((p) => {
      const next = new Set([...p].filter((k) => live.has(k)));
      return next.size === p.size ? p : next;
    });
  }, [ordered]);
  useEffect(() => {
    if (!picked.size) return;
    const key = (e: KeyboardEvent) => {
      // Esc lets go of the selection, unless a terminal has the keyboard (Esc is for Claude there).
      if (e.key === "Escape" && !(document.activeElement as HTMLElement | null)?.closest?.(".xterm")) setPicked(new Set());
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [picked.size]);
  const picking = useMemo<Picking>(
    () => ({
      picked,
      click: (e, s) => {
        const k = keyOf(s);
        if (e.metaKey || e.ctrlKey) {
          const next = new Set(picked);
          if (next.has(k)) next.delete(k);
          else next.add(k);
          anchor.current = k;
          return setPicked(next);
        }
        if (e.shiftKey) {
          const from = ordered.findIndex((x) => keyOf(x) === (anchor.current ?? k));
          const to = ordered.findIndex((x) => keyOf(x) === k);
          if (from >= 0 && to >= 0) {
            const [a, b] = from < to ? [from, to] : [to, from];
            return setPicked(new Set([...picked, ...ordered.slice(a, b + 1).map(keyOf)]));
          }
        }
        anchor.current = k;
        if (picked.size) setPicked(new Set());
        openSessionTab(s.machine, s.name, e.altKey ? "row" : "group");
      },
    }),
    [picked, ordered],
  );
  const pickedList = ordered.filter((s) => picked.has(keyOf(s)));

  const add = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const c = paneContext();
    const where = c.machine ?? LOCAL;
    showMenu({ clientX: r.left, clientY: r.bottom + 4 }, [
      { custom: <div className="px-2.5 pt-1 pb-1 text-[11px] text-subtle">On {where === LOCAL ? "this Mac" : where}{c.dir ? ` · ${folderName(tildePath(c.dir))}` : ""}</div> },
      ...agentRows(where, c.dir),
      { label: "Shell", icon: <TerminalSquare size={13} />, onClick: () => openShellTab(where, "group", c.dir) },
      "sep",
      { label: "New session with options…", icon: <SlidersHorizontal size={13} />, hint: `⇧${mod}T`, onClick: () => setState({ modal: { type: "new-session" } }) },
      ...(where !== LOCAL ? [{ label: "New terminal on this computer", icon: <LocalIcon size={13} />, hint: `${mod}L`, onClick: () => openLocalTab() }] : []),
      { label: "Join a shared session…", icon: <Users size={13} />, hint: `⇧${mod}J`, onClick: () => void askJoin() },
      "sep",
      { label: "New machine…", icon: <Plus size={13} />, hint: `${mod}N`, onClick: () => setState({ modal: { type: "new-machine" } }) },
      { label: "Add an existing machine…", icon: <Server size={13} />, onClick: () => setState({ modal: { type: "add-machine" } }) },
    ]);
  };

  return (
    <aside className={cx("z h-full w-[244px] shrink-0 flex-col border-r border-[color-mix(in_srgb,var(--fg)_5%,transparent)] bg-[var(--sidebar)]", shown ? "flex" : "hidden")}>
      {/* The strip the window buttons sit in on macOS (nothing when the window is full
          screen: they are hidden then); elsewhere, the app's name. */}
      {platform === "darwin" ? (
        <div className="drag flex shrink-0 items-center justify-end pr-2" style={{ height: "var(--lights-h)" }}>
          {/* Beside the window buttons; in full screen (no buttons, no row) it is in the icon row. */}
          <span className="when-windowed">
            <SidebarToggle />
          </span>
        </div>
      ) : (
        <div className="drag flex h-[34px] shrink-0 items-center gap-1.5 px-3 text-[12.5px] font-semibold">
          <img src={appIconSrc(appIcon)} alt="" className="h-4 w-4" /> Lungo
        </div>
      )}

      {/* Where to go: one row of icons, so the rest of the height is for sessions. The
          button that folds the sidebar away sits at its end. */}
      <nav className="flex items-center justify-between px-2">
        {nav.map((n, i) => (
          <button
            key={n.id}
            onClick={() => setState({ view: n.id })}
            title={`${n.label} (⌥${mod}${i + 1})`}
            className={cx("no-drag relative flex h-[28px] w-[28px] items-center justify-center rounded-lg transition-colors", view === n.id || (n.id === "accounts" && view === "keys") ? "text-fg" : "text-subtle hover:bg-hover hover:text-muted")}
          >
            <NavIcon name={n.id} filled={view === n.id || (n.id === "accounts" && view === "keys")} />
            {n.id === "sessions" && waiting > 0 && (
              <span className="absolute -top-[2px] -right-[3px] flex h-[13px] min-w-[13px] items-center justify-center rounded-full bg-warn px-[3px] text-[9px] leading-none font-bold text-black ring-2 ring-[var(--sidebar-solid)]">{waiting}</span>
            )}
          </button>
        ))}
        <span className={platform === "darwin" ? "when-fullscreen" : undefined}>
          <SidebarToggle />
        </span>
      </nav>

      {/* One quiet field: the filter, and at its end how the list is grouped and "new". */}
      <div className="mt-2.5 px-2">
        <div
          onClick={() => input.current?.focus()}
          className="no-drag flex h-[30px] items-center gap-1.5 rounded-lg bg-[color-mix(in_srgb,var(--fg)_5%,transparent)] pr-[3px] pl-2.5 text-subtle transition-colors focus-within:bg-[color-mix(in_srgb,var(--fg)_8%,transparent)]"
        >
          <Search size={12.5} className="shrink-0" />
          <input
            ref={input}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFilter("");
                e.currentTarget.blur();
              }
            }}
            placeholder={`Filter ${hereCount} session${hereCount === 1 ? "" : "s"}`}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-subtle"
          />
          {filter && (
            <button onClick={() => setFilter("")} title="Clear" className="flex size-5 shrink-0 items-center justify-center rounded text-subtle hover:text-fg">
              <X size={11} />
            </button>
          )}
          <span onClick={(e) => e.stopPropagation()} className="flex shrink-0 items-center">
            <IconButton label={mode === "status" ? "Grouped by what needs you. Click to group by machine" : "Grouped by machine. Click to group by what needs you"} className="size-6" onClick={() => setMode(mode === "status" ? "machine" : "status")}>
              {mode === "status" ? <Rows3 size={13} /> : <ListTree size={13} />}
            </IconButton>
            <IconButton label="New session or machine" className="size-6" onClick={add}>
              <Plus size={14} />
            </IconButton>
          </span>
        </div>
      </div>

      <PickContext.Provider value={picking}>
      <div className="mt-1.5 min-h-0 flex-1 overflow-y-auto px-2 pb-2 [scrollbar-width:thin]">
        <SharedWithYou tabs={tabs} activeTab={view === "sessions" ? activeTab : undefined} />
        {mode === "status" ? (
          <>
            {BUCKETS.map((b) => (
              <Section key={b.id} id={b.id} label={b.label} sessions={byBucket[b.id]} machines={machines} activeKey={activeKey} />
            ))}
            {sessions.length === 0 && <div className="px-2 py-6 text-center text-[11.5px] text-subtle">{filter ? (others.length ? "Nothing here matches." : "No session matches.") : others.length ? `Nothing open in this window. ${mod}T starts a session.` : `No sessions running. ${mod}T starts one.`}</div>}
            <OtherSessions sessions={others} machines={machines} filtering={!!filter} activeKey={activeKey} />
          </>
        ) : (
          <>
            {machines.length === 0 && (
              <button
                onClick={() => setState({ modal: { type: "new-machine" } })}
                className="no-drag mt-1 flex w-full items-center gap-2 rounded-lg border border-dashed border-line-strong px-2.5 py-2.5 text-left text-[12.5px] text-muted hover:border-accent hover:text-fg"
              >
                <Plus size={14} /> Create your first machine
              </button>
            )}
            {machines.map((mv) => (
              <MachineGroup key={mv.machine.name} mv={mv} sessions={byMachine[mv.machine.name] ?? []} error={sessionsView.errors[mv.machine.name]} activeKey={activeKey} />
            ))}
            <LocalGroup sessions={byMachine[LOCAL] ?? []} error={sessionsView.errors[LOCAL]} activeKey={activeKey} />
            <OtherSessions sessions={others} machines={machines} filtering={!!filter} activeKey={activeKey} />
          </>
        )}
      </div>

      </PickContext.Provider>
      {pickedList.length > 0 && (
        <div className="anim-fade mx-2 mb-1.5 flex items-center gap-1 rounded-lg bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] py-1 pr-1 pl-2.5">
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg">
            {pickedList.length} selected<span className="text-subtle"> · ⇧-click for a range</span>
          </span>
          <button
            onClick={() => {
              openTogether(pickedList.map((s) => ({ machine: s.machine, session: s.name })));
              setPicked(new Set());
            }}
            title="Open these in one tab, side by side (already open ones move there)"
            className="flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-accent px-2 text-[11.5px] font-medium text-accent-fg hover:brightness-110"
          >
            <LayoutGrid size={12} /> Open together
          </button>
          <button onClick={() => setPicked(new Set())} title="Clear (Esc)" className="flex size-6 shrink-0 items-center justify-center rounded-md text-subtle hover:text-fg">
            <X size={12} />
          </button>
        </div>
      )}
      {mode === "status" && <MachineChips machines={machines} errors={sessionsView.errors} active={activeKey === "local" && view === "sessions"} />}
      <RunningOps />
      <UpdateReady />
      <UsageFooter />
    </aside>
  );
}

/** Sessions other people share with you, open in this window: whose, and what they are doing. */
function SharedWithYou({ tabs, activeTab }: { tabs: Tab[]; activeTab?: string }) {
  const joined = tabs.filter((t) => t.kind === "joined");
  if (!joined.length) return null;
  return (
    <div className="mt-1">
      <div className="flex h-[24px] items-center gap-1.5 pl-2 text-[11.5px] font-medium text-muted">
        Shared with you <span className="text-[10.5px] font-normal text-subtle tabular-nums">{joined.length}</span>
      </div>
      {joined.map((t) => (
        <JoinedRow key={t.key} t={t} active={t.key === activeTab} />
      ))}
    </div>
  );
}

function JoinedRow({ t, active }: { t: Tab; active: boolean }) {
  const info = usePresence(t.key, (s) => s.info);
  const people = usePresence(t.key, (s) => s.people);
  const you = usePresence(t.key, (s) => s.you);
  const others = (people ?? []).filter((m) => m.id !== you && !m.host);
  const state = info?.state === "waiting" ? "needs you" : info?.state === "working" ? "working" : "";
  const by = firstName(people?.find((m) => m.host)?.name ?? t.join?.by);
  return (
    <button
      onClick={() => focusPane(t.key)}
      onContextMenu={(e) => showMenu(e, [{ label: "Leave", onClick: () => closeTab(t.key) }])}
      title={`${paneTitle(t)}\n${by}'s session${info?.where ? ` on ${info.where}` : ""}${info?.folder ? ` · ${info.folder}` : ""}`}
      className={cx("group/row no-drag relative flex w-full items-start gap-2 rounded-md py-[5px] pr-2 pl-2 text-left transition-colors", active ? "bg-active" : "hover:bg-hover", t.error && !active && "opacity-55")}
    >
      <span className="mt-[1px] flex w-[15px] shrink-0 justify-center">
        <JoinedIcon tab={t} size={13} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="flex h-[16px] items-center gap-2">
          <span className={cx("min-w-0 flex-1 truncate text-[12.5px]", active ? "text-fg" : "text-muted group-hover/row:text-fg")}>{paneTitle(t)}</span>
          {others.length > 0 && <Avatars people={others} size={13} max={2} />}
        </span>
        <span className="flex h-[14px] min-w-0 items-center gap-[5px] text-[11px] whitespace-nowrap text-subtle">
          {state && <span className={cx("shrink-0", state === "needs you" ? "text-warn" : "text-ok")}>{state}</span>}
          {state && <span className="opacity-50">·</span>}
          <span className="truncate">
            {t.error ? "ended" : by}
            {info?.folder ? ` · ${info.folder}` : ""}
          </span>
        </span>
      </span>
    </button>
  );
}

/** One group of the list by status: its name, how many, the sessions. Collapsing is remembered. */
function Section({ id, label, sessions, machines, activeKey }: { id: Bucket; label: string; sessions: Session[]; machines: MachineView[]; activeKey: string }) {
  // Finished sessions start folded away: they are there to be tidied, not looked at.
  const [open, setOpenState] = useState(() => pref(`sky.sidebar.open.${id}`, id === "done" ? "0" : "1") === "1");
  if (sessions.length === 0) return null;
  const setOpen = (v: boolean) => {
    setPref(`sky.sidebar.open.${id}`, v ? "1" : "0");
    setOpenState(v);
  };
  return (
    <div className="mt-3 first:mt-1">
      <div className="group flex h-[24px] items-center pr-0.5 pl-2">
        <button onClick={() => setOpen(!open)} className="no-drag flex min-w-0 flex-1 items-center gap-1.5 text-[11.5px] font-medium text-muted hover:text-fg">
          {id === "working" && <WorkingMark size={13} className="text-ok" />}
          <span className={cx(id === "waiting" && "text-warn")}>{label}</span>
          <span className="text-[10.5px] font-normal text-subtle tabular-nums">{sessions.length}</span>
          <ChevronRight size={10} className={cx("shrink-0 text-subtle opacity-0 transition group-hover:opacity-100", open && "rotate-90")} />
        </button>
        {id === "done" && (
          <IconButton label={`End ${sessions.length === 1 ? "this session" : `these ${sessions.length} sessions`} (Claude has left; their conversations stay in the history)`} className="size-5 opacity-0 group-hover:opacity-100" onClick={() => tidy(sessions)}>
            <BrushCleaning size={12} />
          </IconButton>
        )}
      </div>
      {/* Inside a status, by device: the machines in their usual order, this computer last. */}
      {open &&
        [...machines.map((m) => m.machine.name), LOCAL].map((name) => {
          const mine = sessions.filter((s) => s.machine === name);
          if (!mine.length) return null;
          const m = machines.find((x) => x.machine.name === name)?.machine;
          return (
            <div key={name} className="mt-1 first:mt-0">
              <div className="flex h-[22px] items-center gap-2 pl-2 text-[10.5px] text-subtle">
                <span className="flex w-[15px] justify-center opacity-80">{m ? <ProviderIcon provider={m.provider} os={m.os} size={11} /> : <LocalIcon size={11} />}</span>
                <span className="truncate">{m ? m.name : "This Mac"}</span>
                {mine.length > 1 && <span className="tabular-nums opacity-70">{mine.length}</span>}
              </div>
              <SessionRows list={mine} activeKey={activeKey} grouped />
            </div>
          );
        })}
    </div>
  );
}

/** What is running (a machine being made, a sync): up to three, each with its latest line. */
function RunningOps() {
  const ops = useStore((s) => s.ops);
  const opOrder = useStore((s) => s.opOrder);
  const running = useStore(opsRunning);
  if (running === 0) return null;
  return (
    <div className="px-2.5 py-2">
      {opOrder
        .filter((id) => ops[id]?.info.running)
        .slice(0, 3)
        .map((id) => {
          const o = ops[id];
          return (
            <button
              key={id}
              onClick={() => setState({ modal: { type: "op", id } })}
              className="no-drag flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-hover"
            >
              <Spinner size={13} className="mt-0.5 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-fg">{o.info.title}</div>
                {o.info.lastLine && <div className="truncate text-[11px] text-subtle">{o.info.lastLine}</div>}
              </div>
            </button>
          );
        })}
    </div>
  );
}

/** A newer Lungo is downloaded: one quiet line, and a restart installs it. */
function UpdateReady() {
  const u = useStore((s) => s.update);
  if (u?.state !== "ready") return null;
  return (
    <div className="anim-fade mx-2 mb-1 flex h-[26px] items-center gap-2 rounded-md pr-1 pl-2 text-[11.5px] text-muted">
      <span className="size-[6px] shrink-0 rounded-full bg-accent" />
      <span className="min-w-0 flex-1 truncate" title={u.notes || undefined}>
        Lungo {u.latest} is ready
      </span>
      <button onClick={restartToUpdate} title="Sessions keep running and every window comes back" className="no-drag shrink-0 rounded px-1.5 py-0.5 font-medium text-accent hover:bg-hover">
        Restart
      </button>
    </div>
  );
}

/**
 * The sessions running that this window doesn't show: in another window, or in none. Folded
 * by default (unfolded while filtering). A click goes to the window that shows one, or opens
 * it here when no window does; "Open in this window" brings one over.
 */
function OtherSessions({ sessions, machines, filtering, activeKey }: { sessions: Session[]; machines: MachineView[]; filtering: boolean; activeKey: string }) {
  const [open, setOpenState] = useState(() => pref("sky.sidebar.open.others", "0") === "1");
  if (sessions.length === 0) return null;
  const shown = open || filtering;
  const needs = sessions.filter((s) => hasAgent(s) && s.state === "waiting").length;
  const setOpen = (v: boolean) => {
    setPref("sky.sidebar.open.others", v ? "1" : "0");
    setOpenState(v);
  };
  return (
    <div className="mt-4">
      <div className="group flex h-[24px] items-center pr-0.5 pl-2">
        <button
          onClick={() => setOpen(!open)}
          title="Running, but not in this window: a click goes to the window that has it, or opens it here"
          className="no-drag flex min-w-0 flex-1 items-center gap-1.5 text-[11.5px] font-medium text-subtle hover:text-fg"
        >
          <span>Other sessions</span>
          <span className="text-[10.5px] font-normal tabular-nums">{sessions.length}</span>
          {needs > 0 && !shown && (
            <span className="flex shrink-0 items-center gap-[3px] text-[10.5px] text-warn tabular-nums" title={`${needs} need${needs === 1 ? "s" : ""} you`}>
              <span className="size-[5px] rounded-full bg-warn" />
              {needs}
            </span>
          )}
          <ChevronRight size={10} className={cx("shrink-0 opacity-0 transition group-hover:opacity-100", shown && "rotate-90")} />
        </button>
      </div>
      {shown &&
        [...machines.map((m) => m.machine.name), LOCAL].map((name) => {
          const mine = sessions.filter((s) => s.machine === name);
          if (!mine.length) return null;
          const m = machines.find((x) => x.machine.name === name)?.machine;
          return (
            <div key={name} className="mt-1 first:mt-0">
              <div className="flex h-[22px] items-center gap-2 pl-2 text-[10.5px] text-subtle">
                <span className="flex w-[15px] justify-center opacity-80">{m ? <ProviderIcon provider={m.provider} os={m.os} size={11} /> : <LocalIcon size={11} />}</span>
                <span className="truncate">{m ? m.name : "This Mac"}</span>
              </div>
              {mine.map((s) => (
                <SessionRow key={`${s.machine}/${s.name}`} s={s} activeKey={activeKey} />
              ))}
            </div>
          );
        })}
    </div>
  );
}

/**
 * The machines, in the list by status: a chip each, so a session on any of them is one
 * click away without the machines taking the list over.
 */
function MachineChips({ machines, errors, active }: { machines: MachineView[]; errors: Record<string, string>; active: boolean }) {
  const menu = (e: React.MouseEvent<HTMLElement>, name: string | null) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu({ clientX: r.left, clientY: r.top - 4 }, [
      ...agentRows(name ?? LOCAL),
      { label: "Shell", icon: <TerminalSquare size={13} />, onClick: () => (name ? openShellTab(name) : openLocalTab()) },
      ...(name && machines.find((x) => x.machine.name === name)?.machine.os === "darwin" ? [{ label: "Its screen", icon: <Monitor size={13} />, onClick: () => openScreen(name) }] : []),
      ...(name ? (["sep", { label: "Machine details", icon: <Server size={13} />, onClick: () => setState({ view: "machines", machineSheet: name }) }] as const) : []),
    ]);
  };
  const chip = "no-drag flex h-[24px] max-w-full items-center gap-1.5 rounded-md px-1.5 text-[11.5px] text-subtle transition-colors hover:bg-hover hover:text-fg";
  return (
    <div className="shrink-0 px-2 pt-1.5 pb-1">
      <div className="flex flex-wrap gap-1">
        {machines.map(({ machine: m }) => {
          const stopped = m.status === "stopped" || m.status === "missing";
          return (
            <button key={m.name} onClick={(e) => menu(e, m.name)} title={stopped ? `${m.name} is stopped` : errors[m.name] ? `${m.name}: can't reach it right now` : `${m.name}: new session, shell, details`} className={cx(chip, (stopped || errors[m.name]) && "opacity-55")}>
              <ProviderIcon provider={m.provider} os={m.os} size={12} />
              <span className="truncate">{m.name}</span>
              <ChipWarn name={m.name} />
            </button>
          );
        })}
        <button onClick={(e) => menu(e, null)} title={errors[LOCAL] ? `This computer: can't read its sessions right now (${errors[LOCAL]})` : "This computer: new session or shell"} className={cx(chip, active && "bg-active text-fg", errors[LOCAL] && "opacity-55")}>
          <LocalIcon size={12} />
          <span className="truncate">This Mac</span>
        </button>
      </div>
    </div>
  );
}

/** A machine's health warning on its chip: a small ring, the words on hover. */
function ChipWarn({ name }: { name: string }) {
  const warn = useWarn(name);
  return warn ? <span title={warn} className="size-[6px] shrink-0 rounded-full border-[1.5px] border-warn" /> : null;
}

/**
 * A device's heading: a small label, not a banner. Its icon and name, what needs you, how
 * many sessions; the buttons for it take the count's place while the pointer is over it.
 */
function GroupHeader({
  open,
  onToggle,
  icon,
  name,
  title,
  dim,
  note,
  warn,
  active,
  needs,
  count,
  actions,
}: {
  open: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  name: string;
  title?: string;
  dim?: boolean;
  note?: string; // "stopped", "offline"
  warn?: string; // a health warning, as a dot with its words on hover
  active?: boolean;
  needs: number;
  count: number;
  actions: React.ReactNode;
}) {
  return (
    <div className={cx("group flex h-[26px] items-center rounded-md pr-1 pl-2", active && "bg-active")}>
      <button onClick={onToggle} title={title} className="no-drag flex h-full min-w-0 flex-1 items-center gap-2 text-left">
        <span className={cx("flex w-[15px] shrink-0 justify-center", dim && "opacity-45")}>{icon}</span>
        <span className={cx("min-w-0 truncate text-[11.5px] font-medium", dim ? "text-subtle" : "text-muted group-hover:text-fg")}>{name}</span>
        {warn && <span title={warn} className="size-[6px] shrink-0 rounded-full border-[1.5px] border-warn" />}
        {note && <span className="shrink-0 text-[10.5px] text-subtle">{note}</span>}
        {/* the rows say it while they are shown; folded, the heading does */}
        {needs > 0 && !open && (
          <span className="flex shrink-0 items-center gap-[3px] text-[10.5px] font-medium text-warn tabular-nums" title={`${needs} need${needs === 1 ? "s" : ""} you`}>
            <span className="size-[5px] rounded-full bg-warn" />
            {needs}
          </span>
        )}
        <ChevronRight size={10} className={cx("shrink-0 text-subtle opacity-0 transition group-hover:opacity-100", open && "rotate-90", count === 0 && "hidden")} />
      </button>
      {count > 0 && <span className="shrink-0 pr-1 text-[10.5px] text-subtle tabular-nums group-hover:hidden">{count}</span>}
      <div className="hidden shrink-0 items-center group-hover:flex">{actions}</div>
    </div>
  );
}

/** The words of a machine's health warnings, when it has any. */
function useWarn(name: string): string | undefined {
  const h = useHealth(name);
  return h && !h.error && h.warnings.length ? h.warnings.join("\n") : undefined;
}

function MachineGroup({ mv, sessions, error, activeKey }: { mv: MachineView; sessions: Session[]; error?: string; activeKey: string }) {
  const m = mv.machine;
  const [open, setOpen] = useState(true);
  const stopped = m.status === "stopped" || m.status === "missing";
  const needs = sessions.filter((s) => hasAgent(s) && s.state === "waiting").length;
  const asleep = !useStartsOnDemand(m.name, m.status) && stopped; // one that stops when idle is started by opening a session
  const warn = useWarn(m.name);
  const offline = !stopped && !!error && sessions.length === 0;
  return (
    <div className="mt-3 first:mt-1">
      <GroupHeader
        open={open}
        onToggle={() => setOpen((o) => !o)}
        icon={<ProviderIcon provider={m.provider} os={m.os} size={13} />}
        name={m.name}
        title={offline ? error : undefined}
        dim={stopped || offline}
        note={stopped ? "stopped" : offline ? (/unreachable|timed out|Connection refused|Operation timed out|No route/i.test(error ?? "") ? "offline" : "can't list") : undefined}
        warn={warn}
        needs={needs}
        count={sessions.length}
        actions={
          <>
            {sessions.some(finished) && (
              <IconButton label={`End ${sessions.filter(finished).length} finished session${sessions.filter(finished).length === 1 ? "" : "s"} (Claude has left them)`} className="size-6" onClick={() => tidy(sessions)}>
                <BrushCleaning size={12} />
              </IconButton>
            )}
            {m.os === "darwin" && !stopped && (
              <IconButton label="See and use its screen" className="size-6" onClick={() => openScreen(m.name)}>
                <Monitor size={12} />
              </IconButton>
            )}
            <IconButton label="Open a shell" className="size-6" disabled={asleep} onClick={() => openShellTab(m.name)}>
              <TerminalSquare size={12} />
            </IconButton>
            <IconButton label="Start an agent here" className="size-6" disabled={asleep} onClick={(e) => agentMenu(e, m.name)}>
              <Plus size={13} />
            </IconButton>
          </>
        }
      />
      {open && (
        <div>
          {!stopped && !error && sessions.length === 0 && (
            <button onClick={() => setState({ modal: { type: "new-session", machine: m.name } })} className="no-drag flex h-[26px] items-center pl-[31px] text-[11.5px] text-subtle hover:text-fg">
              Start a session
            </button>
          )}
          <SessionRows list={sessions} activeKey={activeKey} />
        </div>
      )}
    </div>
  );
}

/** Ends finished sessions (what they said stays in Claude's history). */
async function tidy(sessions: Session[]) {
  const done = sessions.filter(finished);
  await Promise.all(done.map((s) => api.closeShell(s.machine, s.name).catch(() => {})));
  toast("info", `Ended ${done.length} finished session${done.length === 1 ? "" : "s"}`, done.map((s) => s.title || s.name).join(", "));
  window.setTimeout(loadSessions, 800);
}

/** The menu on a session: open it, your own name and colour for it, end it. */
function sessionMenu(s: Session): MenuRow[] {
  const key = sessionMetaKey(s.machine, s.name);
  const meta = getState().meta[key];
  return [
    { label: "Open", icon: <SquareTerminal size={13} />, onClick: () => openSessionTab(s.machine, s.name) },
    { label: "Open in a split", icon: <Columns2 size={13} />, hint: "⌥-click", onClick: () => openSessionTab(s.machine, s.name, "row") },
    ...(paneForSession(s.machine, s.name) ? [] : [{ label: "Open in this window", icon: <ArrowDownToLine size={13} />, onClick: () => openHere(s.machine, s.name) }]),
    { label: "Open in new window", icon: <AppWindow size={13} />, onClick: () => openInNewWindow(s.machine, s.name) },
    "sep",
    {
      label: "Rename…",
      icon: <Pencil size={13} />,
      onClick: async () => {
        const name = await askText({ title: "Name this session", value: meta?.name ?? "", placeholder: s.title || s.name });
        if (name !== null) setMeta(key, { name });
      },
    },
    {
      custom: (
        <div className="flex h-7 items-center gap-1.5 px-2">
          <span className="mr-1 flex w-4 justify-center text-[12.5px] text-subtle">●</span>
          {COLORS.map((c) => (
            <button
              key={c.id}
              title={c.id}
              onClick={() => setMeta(key, { color: meta?.color === c.id ? "" : c.id })}
              className={cx("size-[15px] rounded-full transition-transform hover:scale-110", meta?.color === c.id && "ring-2 ring-[var(--fg)] ring-offset-2 ring-offset-[var(--raised)]")}
              style={{ background: c.value }}
            />
          ))}
        </div>
      ),
    },
    "sep",
    {
      label: finished(s) ? "End session" : "End session…",
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: async () => {
        // A session that is still doing something asks first; a finished one just goes.
        if (!finished(s) && !(await askConfirm({ title: `End ${meta?.name || s.title || s.name}?`, body: "Whatever is running in it stops. A Claude conversation can be resumed later from its history.", confirm: "End session", danger: true }))) return;
        api.killSession(s.machine, s.name).then(
          () => window.setTimeout(loadSessions, 500),
          (e) => toast("error", "Couldn't end the session", errText(e)),
        );
      },
    },
  ];
}

/**
 * The tab shortcut that goes to each session (⌘3), for sessions open in one of the first nine
 * tabs. Worked out once whenever the tabs change, not by every row on every change.
 */
let shortcutsFor: { tabs: State["tabs"]; groups: State["groups"]; workspace: State["workspace"]; map: Map<string, string> } | null = null;
function tabShortcuts(x: State): Map<string, string> {
  if (shortcutsFor && shortcutsFor.tabs === x.tabs && shortcutsFor.groups === x.groups && shortcutsFor.workspace === x.workspace) return shortcutsFor.map;
  const map = new Map<string, string>();
  if (mod.length === 1) {
    // only where the shortcut is one glyph
    const panes = new Map(x.tabs.map((t) => [t.key, t]));
    visibleGroups(x)
      .slice(0, 9)
      .forEach((g, i) => {
        for (const k of leaves(g.layout)) {
          const t = panes.get(k);
          const m = t && tabMachine(t);
          if (m && t.session && !map.has(`${m}/${t.session}`)) map.set(`${m}/${t.session}`, `${mod}${i + 1}`);
        }
      });
  }
  shortcutsFor = { tabs: x.tabs, groups: x.groups, workspace: x.workspace, map };
  return map;
}

// One clock for every "5m" on screen, moving every 20 seconds while any is shown.
let clockNow = Date.now();
const clockSubs = new Set<() => void>();
let clockTimer: number | undefined;
function subscribeClock(fn: () => void) {
  clockSubs.add(fn);
  if (clockTimer === undefined) {
    clockNow = Date.now();
    clockTimer = window.setInterval(() => {
      clockNow = Date.now();
      clockSubs.forEach((f) => f());
    }, 20000);
  }
  return () => {
    clockSubs.delete(fn);
    if (clockSubs.size) return;
    window.clearInterval(clockTimer);
    clockTimer = undefined;
  };
}

/** How long ago something happened ("5m"), kept current without re-drawing the row around it. */
function Ago({ t }: { t: number }) {
  const now = useSyncExternalStore(subscribeClock, () => clockNow);
  return <>{ago(new Date(t || now).toISOString(), now)}</>;
}

/**
 * What a session is: Claude's mark, or a terminal for a shell. The mark is quiet while the
 * session only waits for its next prompt, so the ones doing something stand out.
 */
function SessionMark({ s }: { s: Session }) {
  const tone = sessionTone(s);
  return (
    <span className="flex h-[16px] w-[15px] shrink-0 items-center justify-center">
      <AgentIcon agent={agentOf(s)} size={hasAgent(s) ? 14 : 13} className={cx("transition-opacity", tone === "idle" && "opacity-45")} />
    </span>
  );
}

/**
 * A folder as the row names it: the project folder itself (creed, skybuild), with the one
 * above it when the name alone says little (skyux/api). Nothing for the home folder.
 */
function folderName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  const base = parts.pop();
  if (!base || base === "~") return "";
  const parent = parts.pop();
  return base.length <= 4 && parent && parent !== "~" ? `${parent}/${base}` : base;
}

const mainBranch = (b?: string) => !b || b === "main" || b === "master";

/**
 * One session, always two lines. First what it is called (your name for it, Claude's, or the
 * session's). Under it where and when: how it is doing if it works or needs you, its folder,
 * its branch when that isn't the main one, and when it last did something. The shortcut of
 * the tab it is open in shows while the pointer is over the row. grouped: it sits under a
 * status heading, which already says "needs you" or "working".
 */
/**
 * The rows of a list of sessions. Sessions open together in one tab (split panes) are shown as
 * that tab: its name and ⊞ count as in the tab bar, its sessions nested under it. A click on
 * the name goes to the tab. The group sits where the list puts its most urgent session.
 */
function SessionRows({ list, activeKey, grouped }: { list: Session[]; activeKey: string; grouped?: boolean }) {
  const tabs = useStore((x) => x.tabs);
  const groups = useStore((x) => x.groups);
  const activeGroup = useStore((x) => x.activeGroup);
  const view = useStore((x) => x.view);
  const runs = useMemo(() => {
    // The tab of each session that shares its tab with another, and its place in the tab.
    const paneSession = new Map<string, string>();
    for (const t of tabs) {
      const m = tabMachine(t);
      if (m && t.session) paneSession.set(t.key, `${m}/${t.session}`);
    }
    const tabOf = new Map<string, { id: string; at: number }>();
    for (const g of groups) {
      const keys = [...new Set(leaves(g.layout).flatMap((k) => paneSession.get(k) ?? []))];
      if (keys.length < 2) continue;
      keys.forEach((k, at) => tabOf.has(k) || tabOf.set(k, { id: g.id, at }));
    }
    const out: { group?: Group; title?: string; panes?: number; rows: Session[] }[] = [];
    const placed = new Set<string>();
    for (const s of list) {
      if (placed.has(keyOf(s))) continue;
      const t = tabOf.get(keyOf(s));
      const rows = t ? list.filter((x) => tabOf.get(keyOf(x))?.id === t.id).sort((a, b) => tabOf.get(keyOf(a))!.at - tabOf.get(keyOf(b))!.at) : [s];
      rows.forEach((x) => placed.add(keyOf(x)));
      const g = t && rows.length > 1 ? groups.find((x) => x.id === t.id) : undefined;
      const focus = g && tabs.find((x) => x.key === g.focus);
      out.push(g ? { group: g, title: focus ? paneTitle(focus) : "", panes: leaves(g.layout).length, rows } : { rows });
    }
    return out;
  }, [list, tabs, groups]);
  return (
    <>
      {runs.map((r) =>
        r.group ? (
          <TabGroup key={r.group.id} group={r.group} title={r.title ?? ""} rows={r.rows} activeKey={activeKey} grouped={grouped} front={r.group.id === activeGroup && view === "sessions"} />
        ) : (
          <SessionRow key={keyOf(r.rows[0])} s={r.rows[0]} activeKey={activeKey} grouped={grouped} />
        ),
      )}
    </>
  );
}

/**
 * A tab with several sessions, shown as that tab: a small map of its split (the focused pane
 * solid, one that needs you amber, one working green), its name, and what its sessions share
 * (folder, branch), so their rows only say what differs. It acts like the tab: a click goes
 * there, right-click is the tab's menu, the chevron folds it (folded, it still says what
 * needs you), and a session dropped on it joins the split.
 */
function TabGroup({ group: g, title, rows, activeKey, grouped, front }: { group: Group; title: string; rows: Session[]; activeKey: string; grouped?: boolean; front: boolean }) {
  const tabs = useStore((x) => x.tabs);
  const sessions = useStore((x) => x.sessions.sessions);
  const home = useStore((x) => x.info?.home);
  const [folded, setFolded] = useState(false);
  const [over, setOver] = useState(false);
  const panes = leaves(g.layout);
  const needs = rows.filter((s) => hasAgent(s) && s.state === "waiting").length;
  const working = rows.some((s) => hasAgent(s) && s.state === "working");
  // What every session in the tab shares goes on the heading, once.
  const folders = new Set(rows.map((s) => folderName(tildePath(s.path, s.machine === LOCAL ? home : undefined))));
  const branches = new Set(rows.map((s) => s.branch ?? ""));
  const folder = folders.size === 1 ? [...folders][0] : "";
  const shared = folders.size === 1 && branches.size === 1;
  // The heading is the folder the tab works in (the focused pane's, when they differ).
  const focusSession = sessionFor(tabs.find((t) => t.key === g.focus), sessions) ?? rows[0];
  const name = folder || folderName(tildePath(focusSession.path, focusSession.machine === LOCAL ? home : undefined)) || title;
  const tone = (key: string): "waiting" | "working" | "" => {
    const x = sessionFor(tabs.find((t) => t.key === key), sessions);
    return x && hasAgent(x) && (x.state === "waiting" || x.state === "working") ? x.state : "";
  };
  const focusTab = tabs.find((t) => t.key === g.focus);
  const drop = (e: React.DragEvent) => {
    const d = getDragged();
    setOver(false);
    if (!d) return;
    e.preventDefault();
    const target = panes[panes.length - 1];
    if (d.pane) placePaneBy(d.pane, target, "row", true);
    else if (d.machine && d.session) {
      if (!paneForSession(d.machine, d.session)) void api.takeSession(d.machine, d.session).catch(() => false);
      placeSessionBy(d.machine, d.session, target, "row", true);
    }
    setDragged(null);
  };
  return (
    <div className="my-[3px]">
      <div
        onClick={() => focusGroup(g.id)}
        onContextMenu={(e) => focusTab && showMenu(e, tabMenu(g, focusTab))}
        onDragOver={(e) => {
          if (getDragged()) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        title={`One tab, ${panes.length} panes side by side. Click to go to it, right-click for the tab's menu, drop a session here to add it.`}
        className={cx(
          "group/tab no-drag flex h-[26px] cursor-default items-center gap-2 rounded-md pr-1 pl-2 transition-colors",
          over ? "bg-[color-mix(in_srgb,var(--accent)_18%,transparent)]" : "hover:bg-hover",
        )}
      >
        <span className="flex w-[15px] shrink-0 justify-center">
          <LayoutMap layout={g.layout} focus={g.focus} tone={tone} front={front} />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11.5px]">
          <span className={cx("min-w-0 truncate font-medium", front ? "text-fg" : "text-muted group-hover/tab:text-fg")}>{name}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setFolded(!folded);
            }}
            title={folded ? "Show its sessions" : "Fold"}
            className="flex size-4 shrink-0 items-center justify-center rounded text-subtle opacity-0 group-hover/tab:opacity-100 hover:text-fg"
          >
            <ChevronRight size={10} className={cx("transition", !folded && "rotate-90")} />
          </button>
        </span>
        {/* Folded, it still says what needs you; otherwise the pane count, and the tab's buttons on hover. */}
        <span className="flex shrink-0 items-center gap-1 pr-1 text-[10.5px] text-subtle tabular-nums group-hover/tab:hidden">
          {folded && needs > 0 ? (
            <span className="flex items-center gap-[3px] font-medium text-warn">
              <span className="size-[5px] rounded-full bg-warn" />
              {needs}
            </span>
          ) : folded && working ? (
            <WorkingMark size={12} className="text-ok" />
          ) : (
            panes.length
          )}
        </span>
        <span className="hidden shrink-0 items-center group-hover/tab:flex" onClick={(e) => e.stopPropagation()}>
          <IconButton label="Separate into tabs" className="size-6" onClick={() => separateGroup(g.id)}>
            <Columns2 size={12} />
          </IconButton>
          <IconButton label="Close this tab (sessions keep running)" className="size-6" onClick={() => closeGroup(g.id)}>
            <X size={12} />
          </IconButton>
        </span>
      </div>
      {!folded && (
        // A line down from the heading that curves into each session (╰), and stops at the last.
        <div className="ml-[15px]">
          {rows.map((s, i) => {
            const line = front ? "border-[color-mix(in_srgb,var(--fg)_38%,transparent)]" : "border-[color-mix(in_srgb,var(--fg)_17%,transparent)]";
            return (
              <div key={keyOf(s)} className="relative pl-[10px]">
                <span className={cx("pointer-events-none absolute top-0 left-0 z-[1] h-[13px] w-[15px] rounded-bl-[8px] border-b border-l", line)} />
                {i < rows.length - 1 && <span className={cx("pointer-events-none absolute top-[6px] bottom-0 left-0 border-l", line)} />}
                <SessionRow s={s} activeKey={activeKey} grouped={grouped} where={!shared} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A tab's split in miniature: a block per pane, laid out as the panes are. */
function LayoutMap({ layout, focus, tone, front }: { layout: Layout; focus: string; tone: (key: string) => "waiting" | "working" | ""; front: boolean }) {
  const W = 15;
  const H = 11;
  const gap = 1.5;
  const blocks: { key: string; x: number; y: number; w: number; h: number }[] = [];
  const walk = (l: Layout, x: number, y: number, w: number, h: number) => {
    if ("pane" in l) {
      blocks.push({ key: l.pane, x, y, w, h });
      return;
    }
    const row = l.dir === "row";
    const room = (row ? w : h) - gap * (l.children.length - 1);
    let at = row ? x : y;
    l.children.forEach((c, i) => {
      const size = room * (l.sizes[i] ?? 1 / l.children.length);
      if (row) walk(c, at, y, size, h);
      else walk(c, x, at, w, size);
      at += size + gap;
    });
  };
  walk(layout, 0, 0, W, H);
  const fill = (key: string) => {
    const t = tone(key);
    if (t === "waiting") return "var(--amber)";
    if (t === "working") return "var(--green)";
    return key === focus ? `color-mix(in srgb, var(--fg) ${front ? 85 : 55}%, transparent)` : "color-mix(in srgb, var(--fg) 22%, transparent)";
  };
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
      {blocks.map((b) => (
        <rect key={b.key} x={b.x} y={b.y} width={Math.max(b.w, 1)} height={Math.max(b.h, 1)} rx={1.5} style={{ fill: fill(b.key) }} />
      ))}
    </svg>
  );
}

// A row draws again only when its own session or its place changes, not on every poll.
const SessionRow = memo(function SessionRow({ s, activeKey, grouped, where = true }: { s: Session; activeKey: string; grouped?: boolean; where?: boolean }) {
  const view = useStore((x) => x.view);
  const meta = useStore((x) => x.meta[sessionMetaKey(s.machine, s.name)]);
  const home = useStore((x) => x.info?.home);
  const shortcut = useStore((x) => tabShortcuts(x).get(keyOf(s)) ?? "");
  const active = activeKey === `${s.machine}/${s.name}` && view === "sessions";
  const shares = useShares();
  const guests = shareFor(s.machine, s.name, shares)?.people.filter((m) => !m.host) ?? [];
  const { picked, click } = useContext(PickContext);
  const isPicked = picked.has(keyOf(s));
  const color = colorValue(meta?.color);
  const b = bucket(s);
  const shell = isIdleShell(s); // a shell at its prompt, open in a pane
  const own = folderName(tildePath(s.path, s.machine === LOCAL ? home : undefined));
  const title = meta?.name || (shell ? own || "~" : s.title || s.name);
  // The folder is on every row, in a tab's group too; the branch the group shares is left off.
  const folder = own;
  const branchShown = where && !mainBranch(s.branch);
  const state = grouped ? "" : b === "waiting" ? "needs you" : b === "working" ? "working" : b === "done" ? "ended" : "";
  const dot = <span className="opacity-50">·</span>;
  return (
    <button
      onMouseDown={(e) => {
        // ⌘ or ⇧ picks on the press itself: a draggable row would otherwise take a press that
        // moves a pixel as the start of a drag, and no click would follow.
        if (e.button === 0 && (e.metaKey || e.ctrlKey || e.shiftKey)) {
          e.preventDefault();
          click(e, s);
        }
      }}
      onClick={(e) => {
        if (!(e.metaKey || e.ctrlKey || e.shiftKey)) click(e, s);
      }}
      onContextMenu={(e) => showMenu(e, sessionMenu(s))}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", title);
        setDragged({ machine: s.machine, session: s.name });
      }}
      onDragEnd={() => setDragged(null)}
      title={`${s.stale ? `Last known: can't reach ${machineLabel(s.machine)} right now\n` : ""}${title}\n${machineLabel(s.machine)} · ${s.path}${s.branch ? ` · ${s.branch}` : ""}\n${s.message || s.name}${s.oldLogin && s.claude ? "\nStill on the previous account's login: moves to the current one as soon as it is idle." : ""}\n⌘-click to pick several · drag onto a pane to put it beside · right-click for more`}
      className={cx(
        "group/row no-drag relative flex w-full items-start gap-2 rounded-md py-[5px] pr-2 pl-2 text-left transition-colors",
        isPicked ? "bg-[color-mix(in_srgb,var(--accent)_16%,transparent)]" : active ? "bg-active" : "hover:bg-hover",
        (b === "done" || s.stale) && !active && "opacity-55",
      )}
    >
      {color && <span className="absolute top-[8px] bottom-[8px] left-0 w-[2px] rounded-full" style={{ background: color }} />}
      <SessionMark s={s} />
      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="flex h-[16px] items-center gap-2">
          <span className={cx("min-w-0 flex-1 truncate text-[12.5px]", active || b === "waiting" || b === "working" ? "text-fg" : "text-muted group-hover/row:text-fg")}>{title}</span>
          {guests.length > 0 && (
            <span className="shrink-0" title={`Shared: ${guests.map((m) => firstName(m.name)).join(", ")} here`}>
              <Avatars people={guests} size={13} max={2} />
            </span>
          )}
          {shortcut && <span className="hidden shrink-0 text-[10.5px] text-subtle tabular-nums group-hover/row:inline">{shortcut}</span>}
        </span>
        <span className="flex h-[14px] min-w-0 items-center gap-[5px] text-[11px] whitespace-nowrap text-subtle">
          {state && (
            <>
              <span className={cx("flex shrink-0 items-center gap-[5px]", b === "waiting" ? "text-warn" : b === "working" ? "text-ok" : undefined)}>
                {/* working is the mark alone, so the folder keeps the room */}
                {b === "working" ? <WorkingMark size={13} /> : b === "waiting" ? <span className="size-[5px] rounded-full bg-warn" /> : null}
                {b !== "working" && state}
              </span>
              {(folder || branchShown) && dot}
            </>
          )}
          {/* the folder keeps its room; a long branch is what gets cut */}
          {shell ? <span className="shrink-0">{s.command}</span> : folder && <span className="max-w-[62%] shrink-0 truncate">{folder}</span>}
          {branchShown && (
            <span className="flex min-w-0 items-center gap-[2px]">
              <GitBranch size={9.5} className="shrink-0 opacity-80" />
              <span className="truncate">{s.branch}</span>
            </span>
          )}
          {!state && (
            <>
              {(folder || branchShown) && dot}
              <span className="shrink-0 tabular-nums">
                <Ago t={sessionTime(s)} />
              </span>
            </>
          )}
        </span>
      </span>
    </button>
  );
});

/** The agents to start on a device, under the button that asked. */
function agentMenu(e: React.MouseEvent<HTMLElement>, machine: string) {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  showMenu({ clientX: r.left, clientY: r.bottom + 4 }, agentRows(machine));
}

/** This computer: a click opens a terminal here; its running sessions are listed like a machine's. */
function LocalGroup({ sessions, error, activeKey }: { sessions: Session[]; error?: string; activeKey: string }) {
  const view = useStore((s) => s.view);
  const [open, setOpen] = useState(true);
  const needs = sessions.filter((s) => hasAgent(s) && s.state === "waiting").length;
  const active = activeKey === "local" && view === "sessions";
  const openHere = () => {
    const t = getState().tabs.find((x) => x.kind === "local" && !x.exited);
    if (t) focusPane(t.key);
    else openLocalTab();
  };
  return (
    <div className="mt-3 first:mt-1">
      <GroupHeader
        open={open && sessions.length > 0}
        onToggle={() => (sessions.length ? setOpen((o) => !o) : openHere())}
        icon={<LocalIcon size={13} className="text-muted" />}
        name="This Mac"
        title="This computer: sessions here keep running when Lungo quits"
        active={active}
        needs={needs}
        count={sessions.length}
        actions={
          <>
            {sessions.some(finished) && (
              <IconButton label={`End ${sessions.filter(finished).length} finished session${sessions.filter(finished).length === 1 ? "" : "s"} (Claude has left them)`} className="size-6" onClick={() => tidy(sessions)}>
                <BrushCleaning size={12} />
              </IconButton>
            )}
            <IconButton label={`New terminal here (${mod}L)`} className="size-6" onClick={() => openLocalTab()}>
              <TerminalSquare size={12} />
            </IconButton>
            <IconButton label="Start an agent here" className="size-6" onClick={(e) => agentMenu(e, LOCAL)}>
              <Plus size={13} />
            </IconButton>
          </>
        }
      />
      {/* tmux here couldn't be read: say so, rather than look like nothing is running */}
      {error && (
        <div title={error} className="truncate pl-[31px] text-[11px] leading-[20px] text-subtle">
          Can't read this Mac's sessions right now
        </div>
      )}
      {open && <SessionRows list={sessions} activeKey={activeKey} />}
    </div>
  );
}
