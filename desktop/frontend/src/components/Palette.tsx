import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppWindow, ArrowRight, UserPlus, Users, BellDot, CircleUserRound, Columns2, Copy, ExternalLink, FolderSync, House, Moon, PanelLeft, Play, Plus, Power, RefreshCw, Search, Server, Settings, SquareTerminal, ZoomIn, ZoomOut } from "lucide-react";
import { api, errText } from "../lib/api";
import {
  focusPane,
  getState,
  jumpNeedsYou,
  newTab,
  pickSkin,
  openClaudeTab,
  openLocalTab,
  openSessionTab,
  openShellTab,
  paneFolder,
  paneTitle,
  refreshMachines,
  runOp,
  sessionFor,
  setState,
  setTheme,
  setZoom,
  splitPane,
  toast,
  toggleSidebar,
  useStore,
  type View,
  machineLabel,
  recipeFrom,
  setWorkspace,
  liveClaude,
  restartClaude,
  moveToNewWindow,
  persistent,
} from "../lib/store";
import { launchRecipe, recipeWhere } from "./Recipes";
import { askJoin, normalCode, openJoin, readInvite, shareTab, showCode } from "../lib/collab";
import { askConfirm } from "./ContextMenu";
import { THEMES } from "../lib/themes";
import { resume, toggleDialog, usePastConversations } from "../lib/history";
import { cx, fuzzy, mod, sessionLabel } from "../lib/util";
import { Kbd } from "./ui";
import { BrandIcon, LocalIcon, ProviderIcon, SessionIcon } from "./Brand";
import { PaneIcon } from "./Panes";

interface Cmd {
  id: string;
  group: string;
  title: string;
  hint?: string;
  icon: ReactNode;
  keys?: string;
  weight?: number; // ranking bonus when several commands match equally
  run: () => void;
}

export function Palette({ onClose }: { onClose: () => void }) {
  const machines = useStore((s) => s.machines);
  const sessions = useStore((s) => s.sessions.sessions);
  const tabs = useStore((s) => s.tabs);
  const past = usePastConversations(); // read when the palette opens
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const cmds = useMemo<Cmd[]>(() => {
    const go = (v: View, title: string, icon: ReactNode, keys?: string): Cmd => ({ id: `go-${v}`, group: "Go to", title, icon, keys, run: () => setState({ view: v, modal: null }) });
    const act = (id: string, title: string, icon: ReactNode, run: () => void, keys?: string): Cmd => ({
      id,
      group: "Actions",
      title,
      icon,
      keys,
      run: () => {
        setState({ modal: null });
        run();
      },
    });
    const list: Cmd[] = [
      act("new-tab", "New tab like this one", <Plus size={14} />, newTab, `${mod}T`),
      act("split-right", "Split right", <Columns2 size={14} />, () => splitPane("row"), `${mod}D`),
      act("split-down", "Split down", <Columns2 size={14} className="rotate-90" />, () => splitPane("col"), `⇧${mod}D`),
      act("split-claude", "Split with Claude here", <BrandIcon name="claude" size={14} />, () => splitPane("row", "claude")),
      act("split-shell", "Split with shell here", <SquareTerminal size={14} />, () => splitPane("row", "shell")),
      { id: "new-session", group: "Actions", title: "New session with options…", icon: <BrandIcon name="claude" size={14} />, keys: `⇧${mod}T`, run: () => setState({ modal: { type: "new-session" } }) },
      act("local", "Terminal on this computer", <LocalIcon size={14} className="text-fg" />, () => openLocalTab(), `${mod}L`),
      act("needs-you", "Next session that needs you", <BellDot size={14} />, jumpNeedsYou, `${mod}J`),
      act("new-window", "New window", <AppWindow size={14} />, () => api.newWindow().catch((e) => toast("error", "Couldn't open a window", errText(e))), `⇧${mod}N`),
      act("move-window", "Move this pane to a new window", <AppWindow size={14} />, () => {
        const key = getState().activeTab;
        if (key) moveToNewWindow(key);
      }),
      act("sidebar", "Toggle sidebar", <PanelLeft size={14} />, toggleSidebar, `${mod}B`),
      act("zoom-in", "Zoom in", <ZoomIn size={14} />, () => setZoom(getState().zoom + 1), `${mod}+`),
      act("zoom-out", "Zoom out", <ZoomOut size={14} />, () => setZoom(getState().zoom - 1), `${mod}−`),
      act("zoom-reset", "Actual size", <ZoomIn size={14} />, () => setZoom(0), `${mod}0`),
      { id: "new-machine", group: "Actions", title: "New machine…", icon: <Plus size={14} />, keys: `${mod}N`, run: () => setState({ modal: { type: "new-machine" } }) },
      { id: "add-machine", group: "Actions", title: "Add an existing machine…", icon: <Server size={14} />, run: () => setState({ modal: { type: "add-machine" } }) },
      act("sync-all", "Sync all machines", <RefreshCw size={14} />, () => runOp(api.sync([]))),
      act("refresh", "Refresh machine status", <RefreshCw size={14} />, refreshMachines),
      act("theme", "Toggle light / dark", <Moon size={14} />, () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light")),
      act("history", "Conversation history…", <BrandIcon name="claude" size={14} />, () => toggleDialog("history"), `${mod}Y`),
      act("search-all", "Search everything…", <Search size={14} />, () => toggleDialog("search"), `⇧${mod}F`),
      go("home", "Home", <House size={14} />),
      go("sessions", "Sessions", <SquareTerminal size={14} />),
      go("machines", "Machines", <Server size={14} />),
      go("sync", "Sync", <RefreshCw size={14} />),
      go("folders", "Projects", <FolderSync size={14} />),
      go("accounts", "Accounts and keys", <CircleUserRound size={14} />),
      go("settings", "Settings", <Settings size={14} />),
    ];
    for (const t of THEMES) {
      list.push({ id: `theme-${t.id}`, group: "Theme", weight: -20, title: `Theme: ${t.name}`, icon: <Moon size={14} />, run: () => { setState({ modal: null }); pickSkin(t.id); } });
    }
    for (const t of tabs) {
      list.push({
        id: `tab-${t.key}`,
        group: "Open panes",
        weight: 60,
        title: paneTitle(t),
        hint: [paneFolder(t), t.machine ?? "this computer"].filter(Boolean).join(" · "),
        icon: <PaneIcon tab={t} session={sessionFor(t, sessions)} size={14} />,
        run: () => {
          setState({ modal: null });
          focusPane(t.key);
        },
      });
    }
    // Recipes by name, and the things around them.
    for (const r of getState().recipes)
      list.push({ id: `recipe-${r.id}`, group: "Recipes", weight: 55, title: r.name, hint: recipeWhere(r), icon: r.kind === "claude" ? <BrandIcon name="claude" size={14} /> : <SquareTerminal size={14} />, run: () => void launchRecipe(r) });
    list.push({ id: "recipes", group: "Actions", title: "Recipes…", icon: <Play size={14} />, keys: `⇧${mod}R`, run: () => setState({ modal: { type: "recipes" } }) });
    list.push({ id: "recipe-new", group: "Actions", title: "Save this pane as a recipe…", icon: <Plus size={14} />, run: () => setState({ modal: { type: "recipes", edit: recipeFrom(getState().tabs.find((t) => t.key === getState().activeTab)) } }) });
    {
      const cur = getState().tabs.find((t) => t.key === getState().activeTab);
      if (cur && liveClaude(cur) && cur.session)
        list.push({ id: "restart-claude", group: "Actions", title: "Restart Claude here, keep the conversation", hint: "picks up changed settings", icon: <RefreshCw size={14} />, run: () => { setState({ modal: null }); void restartClaude(cur, (title, body) => askConfirm({ title, body, confirm: "Restart", danger: true })); } });
    }
    {
      // Sessions shared over the tailnet: share the one in front, or join someone's.
      const cur = getState().tabs.find((t) => t.key === getState().activeTab);
      if (cur && cur.kind !== "joined" && persistent(cur)) {
        list.push({ id: "share", group: "Actions", title: "Share this session", hint: "copies its link, says its code", icon: <UserPlus size={14} />, run: () => { setState({ modal: null }); void shareTab(cur, paneTitle(cur), "edit"); } });
        list.push({ id: "share-view", group: "Actions", title: "Share this session to watch only", hint: "copies a watch-only link", icon: <UserPlus size={14} />, run: () => { setState({ modal: null }); void shareTab(cur, paneTitle(cur), "view"); } });
      }
      list.push({ id: "join", group: "Actions", title: "Join a shared session…", hint: "with a code or a link", icon: <Users size={14} />, keys: `⇧${mod}J`, run: () => { setState({ modal: null }); void askJoin(); } });
    }
    list.push({ id: "composer", group: "Actions", title: "Write a prompt…", icon: <SquareTerminal size={14} />, keys: `${mod}E`, run: () => setState({ modal: { type: "composer" } }) });
    for (const w of getState().workspaces) list.push({ id: `ws-${w}`, group: "Workspaces", title: `Workspace: ${w}`, icon: <AppWindow size={14} />, run: () => { setState({ modal: null, view: "sessions" }); setWorkspace(w); } });
    if (getState().workspaces.length) list.push({ id: "ws-all", group: "Workspaces", title: "Workspace: all tabs", icon: <AppWindow size={14} />, keys: `⇧${mod}0`, run: () => { setState({ modal: null, view: "sessions" }); setWorkspace(null); } });
    for (const s of sessions) {
      list.push({
        id: `s-${s.machine}-${s.name}`,
        group: "Sessions",
        weight: 50,
        title: s.title || s.name,
        hint: `${s.title ? `${s.name} · ` : ""}${machineLabel(s.machine)} · ${sessionLabel(s)}`,
        icon: <SessionIcon s={s} size={14} />,
        run: () => {
          setState({ modal: null });
          openSessionTab(s.machine, s.name);
        },
      });
    }
    for (const mv of machines) {
      const m = mv.machine;
      const stopped = m.status === "stopped";
      const cloud = m.provider !== "ssh";
      list.push(
        { id: `shell-${m.name}`, group: m.name, weight: 40, title: `Shell on ${m.name}`, icon: <ProviderIcon provider={m.provider} os={m.os} size={14} className="text-fg" />, run: () => { setState({ modal: null }); openShellTab(m.name); } },
        { id: `ns-${m.name}`, group: m.name, weight: 30, title: `New Claude session on ${m.name}`, icon: <BrandIcon name="claude" size={14} />, run: () => { setState({ modal: null }); openClaudeTab(m.name); } },
        { id: `copy-${m.name}`, group: m.name, title: `Copy “${mv.sshShort}”`, icon: <Copy size={14} />, run: () => { api.copy(mv.sshShort); toast("info", "Copied", mv.sshShort); setState({ modal: null }); } },
        { id: `ext-${m.name}`, group: m.name, title: `Open ${m.name} in Terminal app`, icon: <ExternalLink size={14} />, run: () => { setState({ modal: null }); api.connect(m.name).catch((e) => toast("error", "Couldn't open", errText(e))); } },
        { id: `det-${m.name}`, group: m.name, title: `${m.name} details`, icon: <ArrowRight size={14} />, run: () => setState({ modal: null, machineSheet: m.name, view: "machines" }) },
        { id: `sync-${m.name}`, group: m.name, title: `Sync ${m.name}`, icon: <RefreshCw size={14} />, run: () => { setState({ modal: null }); runOp(api.sync([m.name])); } },
      );
      if (cloud)
        list.push(
          stopped
            ? { id: `start-${m.name}`, group: m.name, title: `Start ${m.name}`, icon: <Play size={14} />, run: () => { setState({ modal: null }); runOp(api.startMachine(m.name)); } }
            : { id: `stop-${m.name}`, group: m.name, title: `Stop ${m.name}`, icon: <Power size={14} />, run: () => { setState({ modal: null }); runOp(api.stopMachine(m.name)); } },
        );
    }
    // Past conversations to pick up again: found by typing "resume" or a few words of one.
    for (const c of past) {
      if (!c.auto) list.push({ id: `resume-${c.machine}-${c.id}`, group: "Resume", weight: -10, title: `Resume: ${c.title}`, hint: c.where, icon: <BrandIcon name="claude" size={14} />, run: () => resume(c) });
    }
    return list;
  }, [machines, sessions, tabs, past]);

  const shown = useMemo(() => {
    // A code (codes always have a digit: a word is never taken for one) or a link pasted.
    const inv = /^\s*lungo:\/\/join\//i.test(q) ? readInvite(q) : /\d/.test(q) && normalCode(q) ? { code: normalCode(q) } : null;
    if (inv && (inv.code || inv.link)) {
      const what = inv.code ?? inv.link!;
      const join: Cmd = { id: "join-link", group: "Actions", title: inv.code ? `Join session ${showCode(inv.code)}` : "Join this shared session", hint: inv.code ? "looks for it on your tailnet" : what.replace(/\?.*$/, ""), icon: <Users size={14} />, run: () => { setState({ modal: null }); openJoin(what, true); } };
      return [join];
    }
    if (!q.trim()) {
      return cmds.filter((c) => c.group !== "Theme" && (c.group !== "Open panes" || tabs.length < 8)).slice(0, 70);
    }
    return cmds
      .map((c) => {
        const s = Math.max(fuzzy(q, c.title), fuzzy(q, `${c.group} ${c.title} ${c.hint ?? ""}`) - 50);
        return { c, s: s < 0 ? s : s + (c.weight ?? 0) };
      })
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.c);
  }, [cmds, q, tabs.length]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => Math.min(shown.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      shown[sel]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup = "";
  return (
    <div className="z anim-fade fixed inset-0 z-50 flex items-start justify-center bg-[var(--overlay)] px-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="anim-in w-[600px] max-w-full overflow-hidden rounded-2xl border border-line-strong bg-raised shadow-pop">
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search size={15} className="text-subtle" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search sessions, machines, commands…"
            className="h-12 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-subtle"
            spellCheck={false}
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
          {shown.length === 0 && <div className="px-3 py-8 text-center text-[12.5px] text-subtle">No matches</div>}
          {shown.map((c, i) => {
            const header = c.group !== lastGroup;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header && <div className="px-2.5 pt-2.5 pb-1 text-[11px] font-medium text-subtle">{c.group}</div>}
                <button
                  data-i={i}
                  onMouseMove={() => i !== sel && setSel(i)} // the browser moves the mouse itself as rows change under it
                  onClick={() => c.run()}
                  className={cx("flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-left text-[13px]", i === sel ? "bg-active text-fg" : "text-fg")}
                >
                  <span className="flex w-4 justify-center text-subtle">{c.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  {c.hint && <span className="truncate text-[11.5px] text-subtle">{c.hint}</span>}
                  {c.keys && <Kbd>{c.keys}</Kbd>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
