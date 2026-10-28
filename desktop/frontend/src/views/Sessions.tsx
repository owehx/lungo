import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, AppWindow, BellDot, Columns2, Copy, ExternalLink, Layers, Maximize2, Minimize2, MoreHorizontal, Pencil, Pin, PinOff, Plus, RotateCcw, Rows2, Search, SquareTerminal, Trash2, X } from "lucide-react";
import { api, call, errText, type Session } from "../lib/api";
import { closeGroup, closeTab, focusGroup, getState, isIdleShell, jumpNeedsYou, loadSessions, needsYou, newTab, openLocalTab, openSessionTab, openShellTab, paneFolder, paneTitle, reattachTab, sessionFor, setState, splitPane, toast, toggleZoom, updateTab, useStore, type Group, type Tab, persistent, tabMachine, machineLabel, SHELL_PREFIX, gitKey, visibleGroups, setWorkspace, addWorkspace, renameWorkspace, removeWorkspace, moveToWorkspace, closeOtherGroups, togglePin, metaKey, setMeta, colorValue, COLORS, recipeFrom, liveClaude, restartClaude, placeSessionBy, combineGroups, placePaneBy, moveToOwnTab, separateGroup, moveGroupToNewWindow, openAgentTab, LOCAL } from "../lib/store";
import { AGENT_NAMES, ago, baseName, cx, hasAgent, mod, sessionLabel, tildePath } from "../lib/util";
import { DividerHandle, PaneFrame, PaneIcon } from "../components/Panes";
import { MoveButton } from "../components/MoveButton";
import { JoinedButton, ShareButton } from "../components/Share";
import { askConfirm, askText, showMenu, type MenuRow } from "../components/ContextMenu";
import { getDragged, setDragged, useDragged } from "../lib/drag";
import { geometry, leaves } from "../lib/panes";
import { AgentIcon, BrandIcon, LocalIcon, ProviderIcon, SessionIcon } from "../components/Brand";
import { AGENTS, agentsKnownOn, agentsOn } from "../components/AgentMenu";
import { Button, Field, IconButton, Input, Kbd, Menu, Modal, ModalHeader, Select, SidebarToggle, Textarea, Toggle, useNow } from "../components/ui";

/** The folder and program of local panes come from the backend; ask only for what is on screen. */
function useLocalPaneInfo(visible: boolean, shown: Tab[]) {
  // Only panes without a tmux session: those with one are in the sessions poll like any other.
  const ids = shown.filter((t) => t.kind === "local" && !t.session && t.termId && !t.exited).map((t) => `${t.key}:${t.termId}`).join(",");
  useEffect(() => {
    if (!visible || !ids) return;
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      for (const pair of ids.split(",")) {
        const [key, id] = pair.split(":");
        api.terminalInfo(id).then((p) => {
          const t = getState().tabs.find((x) => x.key === key);
          if (!t || (!p.cwd && !p.command)) return;
          if (t.cwd !== p.cwd || t.running !== p.command || !!t.claude !== p.claude) updateTab(key, { cwd: p.cwd || t.cwd, running: p.command, claude: p.claude });
        }, () => {});
      }
    };
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => window.clearInterval(timer);
  }, [visible, ids]);
}

/** The branch and changes of the folders on screen: asked when a pane's folder changes, then every few seconds. */
function usePaneGit(visible: boolean, shown: Tab[]) {
  const on = useStore((s) => s.term.footer);
  const keys = [...new Set(shown.filter((t) => t.cwd).map(gitKey))].join("\u0001");
  useEffect(() => {
    if (!visible || !on || !keys) return;
    const busy = new Set<string>();
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      for (const k of keys.split("\u0001")) {
        if (busy.has(k)) continue;
        busy.add(k);
        const [machine, dir] = k.split("\n");
        api
          .paneGit(machine, dir)
          .then((g) => {
            const cur = getState().git[k];
            if (!cur || JSON.stringify(cur) !== JSON.stringify(g)) setState((s) => ({ git: { ...s.git, [k]: g } }));
          })
          .catch(() => {})
          .finally(() => busy.delete(k));
      }
    };
    poll();
    const timer = window.setInterval(poll, 6000);
    return () => window.clearInterval(timer);
  }, [visible, on, keys]);
}

/** Ports the sessions on screen listen on: one look per machine every few seconds. */
function usePanePorts(visible: boolean, shown: Tab[]) {
  const on = useStore((s) => s.term.footer);
  const machines = [...new Set(shown.filter((t) => t.session).map((t) => tabMachine(t)!))].sort().join("\u0001");
  // A program starting or stopping in a pane is when ports change: look again then, not only on the clock.
  const running = shown.map((t) => t.running ?? "").join("\u0001");
  useEffect(() => {
    if (!visible || !on || !machines) return;
    const busy = new Set<string>();
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      for (const m of machines.split("\u0001")) {
        if (busy.has(m)) continue;
        busy.add(m);
        api
          .sessionPorts(m)
          .then((p) => {
            const cur = getState().ports[m];
            if (JSON.stringify(cur ?? {}) !== JSON.stringify(p ?? {})) setState((s) => ({ ports: { ...s.ports, [m]: p ?? {} } }));
          })
          .catch(() => {})
          .finally(() => busy.delete(m));
      }
    };
    const soon = window.setTimeout(poll, 1200); // a server needs a moment to start listening
    const timer = window.setInterval(poll, 7000);
    return () => {
      window.clearTimeout(soon);
      window.clearInterval(timer);
    };
  }, [visible, on, machines, running]);
}

export function SessionsView({ visible }: { visible: boolean }) {
  const tabs = useStore((s) => s.tabs);
  const groups = useStore((s) => s.groups);
  const activeGroup = useStore((s) => s.activeGroup);
  const activeTab = useStore((s) => s.activeTab);
  const sessions = useStore((s) => s.sessions.sessions);
  const area = useRef<HTMLDivElement>(null);
  const group = groups.find((g) => g.id === activeGroup);
  const active = tabs.find((t) => t.key === activeTab);
  const activeSession = sessionFor(active, sessions);
  const geo = useMemo(() => (group ? geometry(group.layout) : null), [group]);
  const multi = !!group && leaves(group.layout).length > 1;
  const onScreen = useMemo(() => {
    if (!group) return [];
    const keys = group.zoom ? [group.focus] : leaves(group.layout);
    return tabs.filter((t) => keys.includes(t.key));
  }, [group, tabs]);
  useLocalPaneInfo(visible, onScreen);
  usePaneGit(visible, onScreen);
  usePanePorts(visible, onScreen);

  return (
    <div className={cx("h-full min-h-0 flex-col", visible ? "flex" : "hidden")}>
      <TopBar group={group} multi={multi} active={active} activeSession={activeSession} />
      <div ref={area} data-pane-area className="relative min-h-0 flex-1 overflow-hidden" style={{ background: groups.length ? "var(--term-bg)" : undefined }}>
        {tabs.map((t) => {
          let rect = geo?.rects[t.key] ?? null;
          if (group?.zoom) rect = t.key === group.focus ? FULL : null;
          // A title bar on panes that share their tab, and not on one zoomed to fill it.
          const own = groups.find((g) => leaves(g.layout).includes(t.key));
          const shared = !!own && leaves(own.layout).length > 1 && !own.zoom;
          return <PaneFrame key={t.key} tab={t} rect={rect} focused={t.key === activeTab} multi={shared} session={sessionFor(t, sessions)} />;
        })}
        {group && !group.zoom && geo?.dividers.map((d) => <DividerHandle key={`${d.path.join(".")}:${d.index}`} group={group} d={d} area={area} />)}
        <DropTargets group={group} rects={group ? (group.zoom ? { [group.focus]: FULL } : geo?.rects ?? {}) : {}} />
        {!group && <Welcome />}
      </div>
    </div>
  );
}

const FULL = { x: 0, y: 0, w: 1, h: 1 };

type Side = "left" | "right" | "top" | "bottom";

/**
 * While a session is dragged from the sidebar: each pane on screen is a target, and the half
 * of it nearest the pointer is where the session goes (it opens there, or moves there if it
 * is open elsewhere). With no tab open, the whole area opens it as a tab.
 */
function DropTargets({ group, rects }: { group?: Group; rects: Record<string, { x: number; y: number; w: number; h: number }> }) {
  const dragged = useDragged();
  const [over, setOver] = useState<{ key: string; side: Side } | null>(null);
  useEffect(() => {
    if (!dragged) setOver(null);
  }, [dragged]);
  if (!dragged) return null;
  const pct = (n: number) => `${n * 100}%`;
  const sideOf = (e: React.DragEvent<HTMLElement>): Side => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    return Math.min(x, 1 - x) < Math.min(y, 1 - y) ? (x < 0.5 ? "left" : "right") : y < 0.5 ? "top" : "bottom";
  };
  const half: Record<Side, React.CSSProperties> = {
    left: { left: 0, top: 0, width: "50%", height: "100%" },
    right: { right: 0, top: 0, width: "50%", height: "100%" },
    top: { left: 0, top: 0, width: "100%", height: "50%" },
    bottom: { left: 0, bottom: 0, width: "100%", height: "50%" },
  };
  if (!group)
    return (
      <div
        className="absolute inset-0 z-40"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragged(null);
          if (dragged.machine && dragged.session) openSessionTab(dragged.machine, dragged.session);
        }}
      />
    );
  return (
    <>
      {Object.entries(rects).filter(([key]) => key !== dragged.pane).map(([key, r]) => (
        <div
          key={key}
          className="absolute z-40"
          style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const side = sideOf(e);
            if (over?.key !== key || over.side !== side) setOver({ key, side });
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o?.key === key ? null : o));
          }}
          onDrop={(e) => {
            e.preventDefault();
            const side = sideOf(e);
            setDragged(null);
            setOver(null);
            const dir = side === "left" || side === "right" ? "row" : "col";
            const after = side === "right" || side === "bottom";
            if (dragged.pane) placePaneBy(dragged.pane, key, dir, after);
            else if (dragged.machine && dragged.session) placeSessionBy(dragged.machine, dragged.session, key, dir, after);
          }}
        >
          {over?.key === key && (
            <div className="pointer-events-none absolute rounded-md border-2 border-accent bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] transition-all duration-100" style={half[over.side]} />
          )}
        </div>
      ))}
    </>
  );
}

/**
 * The one-row top bar: sidebar toggle, tabs, a search field that opens the palette, and the
 * actions for the tab on the right. With few tabs the search sits in the middle; when the
 * tabs need the room it shrinks to an icon.
 */
function TopBar({ group, multi, active, activeSession }: { group?: Group; multi: boolean; active?: Tab; activeSession?: Session }) {
  const footer = useStore((x) => x.term.footer);
  const allGroups = useStore((s) => s.groups);
  const workspace = useStore((s) => s.workspace);
  const groups = useMemo(() => visibleGroups({ ...getState(), groups: allGroups, workspace }), [allGroups, workspace]);
  const activeGroup = useStore((s) => s.activeGroup);
  const sidebar = useStore((s) => s.sidebar);
  const waiting = useStore((s) => needsYou(s).length);
  const bar = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Tabs want ~130px each; the centred search leaves them half the bar minus its own half.
  const tight = groups.length * 130 + 70 > (width - SEARCH_W) / 2 - (sidebar ? 12 : 120);
  const [overBar, setOverBar] = useState(false);
  const dragging = useDragged();
  useEffect(() => {
    if (!dragging) setOverBar(false);
  }, [dragging]);
  useEffect(() => {
    strip.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeGroup, groups.length]);

  return (
    <div
      ref={bar}
      className={cx("z drag grid h-[40px] shrink-0 items-center gap-2 border-b border-line", tight ? "grid-cols-[minmax(0,1fr)_auto_auto]" : "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]")}
    >
      {/* The padding sits inside the side columns so the search stays centred in the bar. */}
      <div className="flex min-w-0 items-center gap-1" style={{ paddingLeft: sidebar ? 8 : "var(--lights-pad)" }}>
        {!sidebar && <SidebarToggle />}
        <WorkspaceButton />
        <div
          ref={strip}
          onDragOver={(e) => {
            const d = getDragged();
            if (!d?.pane && !d?.session) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (!overBar) setOverBar(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverBar(false);
          }}
          onDrop={(e) => {
            const d = getDragged();
            e.preventDefault();
            setOverBar(false);
            setDragged(null);
            if (d?.pane) moveToOwnTab(d.pane);
            else if (d?.machine && d.session) openSessionTab(d.machine, d.session);
          }}
          className={cx(
            "no-drag flex min-h-[30px] min-w-0 items-center gap-0.5 overflow-x-auto rounded-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            overBar && "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] shadow-[inset_0_0_0_1px_var(--accent)]",
          )}
        >
          {groups.map((g, i) => (
            <GroupButton key={g.id} group={g} index={i} active={g.id === activeGroup} />
          ))}
        </div>
        <IconButton label={`New tab like this one (${mod}T)`} className="size-6" onClick={newTab}>
          <Plus size={14} />
        </IconButton>
      </div>
      {tight ? (
        <IconButton label={`Search (${mod}K)`} className="size-6" onClick={() => setState({ modal: { type: "palette" } })}>
          <Search size={13} />
        </IconButton>
      ) : (
        <button
          onClick={() => setState({ modal: { type: "palette" } })}
          style={{ width: SEARCH_W }}
          className="no-drag flex h-[26px] items-center gap-2 rounded-md border border-line bg-[color-mix(in_srgb,var(--fg)_3%,transparent)] px-2 text-[12px] text-subtle transition-colors hover:border-line-strong hover:text-muted"
        >
          <Search size={12} />
          <span className="min-w-0 flex-1 truncate text-left">Search or jump to…</span>
          <Kbd>{mod}K</Kbd>
        </button>
      )}
      <div className="no-drag flex min-w-0 items-center justify-end gap-0.5 pr-2">
        {/* The focused session's folder and state. With one pane there is no pane header, so
            this (and the tab's badge) is where "needs you" shows, with Claude's question. */}
        {active && activeSession && (footer ? hasAgent(activeSession) : true) && (
          <span
            title={hasAgent(activeSession) && activeSession.state === "waiting" ? activeSession.message || "Waiting for you" : undefined}
            className={cx("mr-1 min-w-0 truncate text-[11px]", hasAgent(activeSession) && activeSession.state === "waiting" ? "text-warn" : "hidden text-subtle xl:inline")}
          >
            {/* the folder is under the pane when that strip is on */}
            {footer ? sessionLabel(activeSession) : `${tildePath(activeSession.path)} · ${sessionLabel(activeSession)}`}
          </span>
        )}
        <button
          title={waiting ? `Go to the next session that needs you (${mod}J)` : `Nothing needs you (${mod}J)`}
          onClick={jumpNeedsYou}
          className={cx(
            "flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium tabular-nums transition-colors",
            waiting ? "bg-[color-mix(in_srgb,var(--amber)_16%,transparent)] text-warn hover:bg-[color-mix(in_srgb,var(--amber)_24%,transparent)]" : "text-subtle hover:bg-hover hover:text-fg",
          )}
        >
          <BellDot size={13} />
          {waiting > 0 && waiting}
        </button>
        {group && (
          <>
            <IconButton label={`Split right (${mod}D)`} className="size-6" onClick={() => splitPane("row")}>
              <Columns2 size={13} />
            </IconButton>
            <IconButton label={`Split down (⇧${mod}D)`} className="size-6" onClick={() => splitPane("col")}>
              <Rows2 size={13} />
            </IconButton>
            {multi && (
              <IconButton label={group.zoom ? `Show all panes (⇧${mod}↩)` : `Zoom pane (⇧${mod}↩)`} className="size-6" onClick={toggleZoom}>
                {group.zoom ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </IconButton>
            )}
          </>
        )}
        {/* With panes side by side each has it in its title bar. */}
        {active && !multi && <ShareButton tab={active} session={activeSession} className="size-6" />}
        {active && !multi && <JoinedButton tab={active} className="size-6" />}
        {active && !multi && <MoveButton tab={active} session={activeSession} className="size-6" />}
        {active && <TabActions tab={active} />}
      </div>
    </div>
  );
}

const SEARCH_W = 260;

/**
 * The workspace on show: a named set of tabs, so a dozen open tabs become three or four at a
 * time. "All" shows every tab. Tabs opened while a workspace is on show are filed under it.
 */
function WorkspaceButton() {
  const workspaces = useStore((s) => s.workspaces);
  const workspace = useStore((s) => s.workspace);
  const groups = useStore((s) => s.groups);
  const tabs = useStore((s) => s.tabs);
  const sessions = useStore((s) => s.sessions.sessions);
  const needs = (list: Group[]) => list.filter((g) => tabs.some((t) => leaves(g.layout).includes(t.key) && sessionFor(t, sessions)?.state === "waiting")).length;
  const elsewhere = workspace === null ? 0 : needs(groups.filter((g) => g.ws !== workspace));
  const open = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const count = (list: Group[]) => `${list.length}${needs(list) ? ` · ${needs(list)} need you` : ""}`;
    const create = async () => {
      const name = await askText({ title: "New workspace", placeholder: "A project, a client, a kind of work…", confirm: "Create" });
      if (name && !addWorkspace(name)) toast("error", "There is already a workspace with that name");
    };
    const rows: MenuRow[] = [
      { label: "All tabs", hint: count(groups), checked: workspace === null, onClick: () => setWorkspace(null) },
      ...workspaces.map((w, i) => ({ label: w, hint: `${count(groups.filter((g) => g.ws === w))}${i < 9 ? `   ⇧${mod}${i + 1}` : ""}`, checked: workspace === w, onClick: () => setWorkspace(w) })),
      "sep",
      { label: "New workspace…", icon: <Plus size={13} />, onClick: create },
      ...(workspace !== null
        ? [
            {
              label: `Rename ${workspace}…`,
              icon: <Pencil size={13} />,
              onClick: async () => {
                const name = await askText({ title: "Rename workspace", value: workspace });
                if (name && name !== workspace && !renameWorkspace(workspace, name)) toast("error", "There is already a workspace with that name");
              },
            },
            { label: `Remove ${workspace}`, icon: <Trash2 size={13} />, hint: "tabs stay open", onClick: () => removeWorkspace(workspace) },
          ]
        : []),
    ];
    showMenu({ clientX: r.left, clientY: r.bottom + 4 }, rows);
  };
  return (
    <button
      onClick={open}
      title={workspace === null ? "Workspaces: named sets of tabs" : `Workspace ${workspace}${elsewhere ? ` · ${elsewhere} in other workspaces need you` : ""}`}
      className={cx(
        "no-drag relative flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[12px] transition-colors",
        workspace === null ? "text-subtle hover:bg-hover hover:text-fg" : "bg-[color-mix(in_srgb,var(--fg)_6%,transparent)] font-medium text-fg hover:bg-active",
      )}
    >
      <Layers size={13} className="shrink-0" />
      {workspace !== null && <span className="max-w-[120px] truncate">{workspace}</span>}
      {elsewhere > 0 && <span className="absolute -top-px -right-px size-[6px] rounded-full bg-warn" />}
    </button>
  );
}

/** The menu for a tab: your own name and colour for it, pinning, its workspace, closing. */
export function tabMenu(group: Group, tab: Tab): MenuRow[] {
  const s = getState();
  const key = metaKey(tab);
  const meta = s.meta[key];
  const rename = async () => {
    const name = await askText({ title: "Name this tab", value: meta?.name ?? "", placeholder: paneTitle({ ...tab }) });
    if (name !== null) setMeta(key, { name });
  };
  return [
    { label: "Rename…", icon: <Pencil size={13} />, onClick: rename },
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
          {meta?.color && (
            <button onClick={() => setMeta(key, { color: "" })} className="ml-1 text-[11px] text-subtle hover:text-fg">
              none
            </button>
          )}
        </div>
      ),
    },
    { label: group.pinned ? "Unpin" : "Pin", icon: group.pinned ? <PinOff size={13} /> : <Pin size={13} />, onClick: () => togglePin(group.id) },
    ...(leaves(group.layout).length > 1 ? [{ label: "Separate into tabs", icon: <Columns2 size={13} />, hint: `${leaves(group.layout).length} panes`, onClick: () => separateGroup(group.id) }] : []),
    { label: "Move to new window", icon: <AppWindow size={13} />, onClick: () => moveGroupToNewWindow(group.id) },
    "sep",
    ...visibleGroups(s)
      .filter((g) => g.id !== group.id)
      .slice(0, 8)
      .map((g) => {
        const t = s.tabs.find((x) => x.key === g.focus);
        return { label: `Combine with ${t ? paneTitle(t) : "a tab"}`, icon: <Columns2 size={13} />, onClick: () => combineGroups(group.id, g.id) };
      }),
    "sep",
    ...s.workspaces.map((w) => ({ label: `Move to ${w}`, icon: <Layers size={13} />, checked: group.ws === w, onClick: () => moveToWorkspace(group.id, group.ws === w ? undefined : w) })),
    {
      label: "Move to a new workspace…",
      icon: <Plus size={13} />,
      onClick: async () => {
        const name = await askText({ title: "New workspace", placeholder: "A project, a client, a kind of work…", confirm: "Create" });
        if (name && !addWorkspace(name, group.id)) toast("error", "There is already a workspace with that name");
      },
    },
    "sep",
    ...(liveClaude(tab) && tab.session ? [{ label: "Restart Claude, keep the conversation", icon: <RotateCcw size={13} />, onClick: () => void restartClaude(tab, (title, body) => askConfirm({ title, body, confirm: "Restart", danger: true })) }] : []),
    { label: "Save as a recipe…", icon: <Plus size={13} />, onClick: () => setState({ modal: { type: "recipes", edit: recipeFrom(tab) } }) },
    "sep",
    { label: "Close", icon: <X size={13} />, hint: `${mod}W`, onClick: () => closeGroup(group.id) },
    { label: "Close other tabs", onClick: () => closeOtherGroups(group.id) },
  ];
}

function GroupButton({ group, active }: { group: Group; index: number; active: boolean }) {
  const tab = useStore((s) => s.tabs.find((t) => t.key === group.focus));
  const sessions = useStore((s) => s.sessions.sessions);
  const tabs = useStore((s) => s.tabs);
  const meta = useStore((s) => (tab ? s.meta[metaKey(tab)] : undefined));
  const keys = leaves(group.layout);
  const panes = tabs.filter((t) => keys.includes(t.key));
  const needs = panes.filter((t) => t.key !== group.focus && sessionFor(t, sessions)?.state === "waiting").length;
  if (!tab) return null;
  const session = sessionFor(tab, sessions);
  const title = paneTitle(tab);
  const color = colorValue(meta?.color);
  // A tab named only by its folder ("~") says more with its machine next to it.
  const where = tab.kind !== "local" && tab.machine && title !== tab.machine && title.length <= 2 ? tab.machine : "";
  const hint = panes.map((t) => [paneTitle(t), paneFolder(t), t.machine ?? "this computer"].filter(Boolean).join(" · ")).join("\n");
  const common = {
    "data-active": active,
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        closeGroup(group.id);
      }
    },
    onClick: () => focusGroup(group.id),
    onContextMenu: (e: React.MouseEvent) => showMenu(e, tabMenu(group, tab)),
    title: hint,
  };
  if (group.pinned)
    return (
      <div {...common} className={cx("relative flex size-[28px] shrink-0 items-center justify-center rounded-md transition-colors", active ? "bg-active" : "hover:bg-hover")}>
        <PaneIcon tab={tab} session={session} size={13} />
        {color && <span className="absolute inset-x-[7px] bottom-[2px] h-[2px] rounded-full" style={{ background: color }} />}
        {needs > 0 && <span className="absolute top-[3px] right-[3px] size-[6px] rounded-full bg-warn" />}
      </div>
    );
  return (
    <div
      {...common}
      onDoubleClick={() => tabMenu(group, tab).find((r): r is Exclude<MenuRow, "sep" | { custom: unknown }> => r !== "sep" && "label" in r && r.label === "Rename…")?.onClick()}
      className={cx(
        "group relative flex h-[28px] max-w-[220px] min-w-[124px] shrink-0 items-center gap-1.5 rounded-md pr-1 pl-2 text-[12px] transition-colors",
        active ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      {color && <span className="absolute top-[7px] bottom-[7px] left-[2px] w-[2px] rounded-full" style={{ background: color }} />}
      <PaneIcon tab={tab} session={session} size={12} />
      <span className="min-w-0 flex-1 truncate">
        {title}
        {where && <span className="ml-1.5 text-subtle">{where}</span>}
      </span>
      {keys.length > 1 && (
        <span className={cx("flex h-4 items-center gap-0.5 rounded px-1 text-[10px] font-medium tabular-nums", needs ? "bg-warn text-black" : "bg-active text-muted")} title={`${keys.length} panes`}>
          <Columns2 size={9} />
          {keys.length}
        </span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          closeGroup(group.id);
        }}
        className={cx("flex size-[18px] shrink-0 items-center justify-center rounded text-subtle hover:bg-active hover:text-fg", active ? "opacity-100" : "opacity-0 group-hover:opacity-100")}
        title={keys.length > 1 ? "Close all panes" : `Close (${mod}W)`}
      >
        <X size={11} />
      </button>
    </div>
  );
}

function TabActions({ tab }: { tab: Tab }) {
  const [confirmKill, setConfirmKill] = useState(false);
  const attach = tab.kind === "session" ? `ssh -t ${tab.machine} tmux attach -t ${tab.session}` : tab.machine ? `ssh ${tab.machine}` : "";
  if (confirmKill) {
    return (
      <div className="anim-fade flex items-center gap-1">
        <span className="text-[12px] text-muted">End {tab.session}?</span>
        <Button
          size="xs"
          variant="danger"
          onClick={async () => {
            try {
              await api.killSession(tabMachine(tab)!, tab.session!);
              closeTab(tab.key);
              toast("info", `Ended ${tab.session}`);
            } catch (e) {
              toast("error", "Couldn't end session", errText(e));
            }
            setConfirmKill(false);
          }}
        >
          End
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setConfirmKill(false)}>
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <Menu
      trigger={
        <IconButton label="More" className="size-6">
          <MoreHorizontal size={14} />
        </IconButton>
      }
      items={[
        { label: "New tab like this one", icon: <Plus size={13} />, hint: `${mod}T`, onClick: newTab },
        { label: "New session…", icon: <BrandIcon name="claude" size={13} />, hint: `⇧${mod}T`, onClick: () => setState({ modal: { type: "new-session", machine: tab.machine, dir: paneFolder(tab) } }) },
        { label: "New window", icon: <AppWindow size={13} />, hint: `⇧${mod}N`, onClick: () => api.newWindow().catch((e) => toast("error", "Couldn't open a window", errText(e))) },
        "sep",
        ...(attach ? [{ label: "Copy attach command", icon: <Copy size={13} />, onClick: () => api.copy(attach).then(() => toast("info", "Copied", attach)) }] : []),
        ...(tab.machine ? [{ label: "Open in Terminal app", icon: <ExternalLink size={13} />, onClick: () => api.connect(tab.machine!).catch((e) => toast("error", "Couldn't open", errText(e))) }] : []),
        { label: persistent(tab) ? "Reconnect" : "New shell", icon: <RotateCcw size={13} />, onClick: () => reattachTab(tab.key) },
        ...(tab.kind !== "shell" && persistent(tab) && !tab.session!.startsWith(SHELL_PREFIX)
          ? (["sep", { label: "End session…", icon: <Trash2 size={13} />, danger: true, onClick: () => setConfirmKill(true) }] as const)
          : []),
      ]}
    />
  );
}

/** Home: the start screen, reachable any time (not only when no tab is open). */
export function HomeView() {
  const sidebar = useStore((s) => s.sidebar);
  return (
    <div className="flex h-full flex-col">
      {/* the window's top strip; with the sidebar folded away, the button that brings it back */}
      <div className="drag flex h-[40px] shrink-0 items-center" style={{ paddingLeft: sidebar ? 20 : "var(--lights-pad)" }}>
        {!sidebar && <SidebarToggle />}
      </div>
      <div className="min-h-0 flex-1">
        <Welcome />
      </div>
    </div>
  );
}

function Welcome() {
  const machines = useStore((s) => s.machines);
  const sessions = useStore((s) => s.sessions.sessions);
  const loaded = useStore((s) => s.machinesLoaded);
  const now = useNow(20000);
  const running = machines.filter((m) => m.machine.status === "running" || !m.machine.status);
  if (!loaded) return null;
  if (machines.length === 0) {
    return (
      <div className="z flex h-full items-center justify-center">
        <div className="anim-in max-w-[440px] px-6 text-center">
          <div className="mx-auto mb-5 flex items-center justify-center gap-2.5">
            {(["gcp", "aws", "azure"] as const).map((p) => (
              <span key={p} className="flex size-12 items-center justify-center rounded-2xl border border-line bg-panel">
                <BrandIcon name={p} size={24} className="text-fg" />
              </span>
            ))}
          </div>
          <h2 className="text-[17px] font-semibold tracking-tight text-fg">Run Claude on machines that never sleep</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            Create a cloud machine with a persistent volume, or add one you already have. Your Claude login, GitHub and CLI tokens sync over, and
            sessions keep running when you close the lid.
          </p>
          <div className="mt-6 flex justify-center gap-2">
            <Button variant="primary" size="md" icon={<Plus size={14} />} onClick={() => setState({ modal: { type: "new-machine" } })}>
              Create your first machine
            </Button>
            <Button variant="outline" size="md" onClick={() => setState({ modal: { type: "add-machine" } })}>
              Add existing
            </Button>
          </div>
          <button onClick={() => openLocalTab()} className="mt-4 text-[12px] text-subtle hover:text-fg">
            or open a terminal on this computer
          </button>
        </div>
      </div>
    );
  }
  const recent = [...sessions].filter((x) => !isIdleShell(x)).sort((a, b) => +new Date(b.activity) - +new Date(a.activity)).slice(0, 6);
  return (
    <div className="z flex h-full items-center justify-center overflow-y-auto">
      <div className="anim-in w-full max-w-[560px] px-6 py-10">
        <h2 className="text-[17px] font-semibold tracking-tight text-fg">Start working</h2>
        <p className="mt-1 text-[13px] text-muted">Sessions live in tmux on the machine. Close a tab and they keep going.</p>
        <StartCards running={running.map((m) => m.machine.name)} />
        {recent.length > 0 && (
          <div className="mt-8">
            <div className="mb-2 text-[11px] font-semibold tracking-wide text-subtle uppercase">Attach to a session</div>
            <div className="overflow-hidden rounded-xl border border-line">
              {recent.map((s) => (
                <button
                  key={`${s.machine}/${s.name}`}
                  onClick={() => openSessionTab(s.machine, s.name)}
                  className="flex w-full items-center gap-3 border-b border-line px-3.5 py-2.5 text-left last:border-b-0 hover:bg-hover"
                >
                  <SessionIcon s={s} size={16} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-fg">{s.title || s.name}</div>
                    <div className="truncate text-[11.5px] text-subtle">
                      {machineLabel(s.machine)} · {tildePath(s.path)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={cx("text-[11.5px]", hasAgent(s) && s.state === "waiting" ? "text-warn" : "text-muted")}>{sessionLabel(s)}</div>
                    <div className="text-[11px] text-subtle">{ago(s.activity, now)}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const WHERE_KEY = "sky.home.where";

/**
 * Where to start (a pill per machine that is up, and this Mac) and what (an agent, or a
 * shell). One click starts it; an agent that isn't installed there is greyed out.
 */
function StartCards({ running }: { running: string[] }) {
  const places = useMemo(() => [...running, LOCAL], [running]);
  const [picked, setPicked] = useState(() => {
    try {
      return localStorage.getItem(WHERE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const where = places.includes(picked) ? picked : places[0];
  const [installed, setInstalled] = useState<string[] | undefined>(agentsKnownOn(where));
  useEffect(() => {
    let off = false;
    setInstalled(agentsKnownOn(where));
    agentsOn(where).then(
      (list) => !off && setInstalled(list),
      () => {},
    );
    return () => {
      off = true;
    };
  }, [where]);
  const pick = (p: string) => {
    setPicked(p);
    try {
      localStorage.setItem(WHERE_KEY, p);
    } catch {
      /* storage unavailable */
    }
  };
  const shell = () => (where === LOCAL ? openLocalTab() : openShellTab(where));
  return (
    <>
      <div className="mt-5 flex flex-wrap items-center gap-1.5">
        {places.map((p) => (
          <button
            key={p}
            onClick={() => pick(p)}
            className={cx(
              "flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12px] transition-colors",
              where === p ? "border-transparent bg-fg text-bg" : "border-line text-muted hover:border-line-strong hover:text-fg",
            )}
          >
            <PlaceIcon name={p} />
            {p === LOCAL ? "This Mac" : p}
          </button>
        ))}
      </div>
      {/* the agents, two by two */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        {AGENTS.map((a) => {
          const missing = !!installed && !installed.includes(a);
          return (
            <button
              key={a}
              disabled={missing}
              onClick={() => openAgentTab(where, a)}
              className="flex h-[72px] items-center gap-3.5 rounded-xl bg-[color-mix(in_srgb,var(--fg)_4.5%,transparent)] px-4 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--fg)_8%,transparent)] disabled:opacity-40"
            >
              <span className="flex size-8 shrink-0 items-center justify-center">
                <AgentIcon agent={a} size={22} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-medium text-fg">{AGENT_NAMES[a]}</span>
                <span className="block truncate text-[11.5px] text-subtle">{missing ? `Not installed on ${where === LOCAL ? "this Mac" : where}` : a}</span>
              </span>
            </button>
          );
        })}
      </div>
      <button onClick={shell} className="mt-3 flex items-center gap-1.5 text-[12px] text-subtle transition-colors hover:text-fg">
        <SquareTerminal size={13} />
        Or open a shell {where === LOCAL ? "on this Mac" : `on ${where}`}
      </button>
    </>
  );
}

function PlaceIcon({ name }: { name: string }) {
  const m = useStore((s) => s.machines.find((x) => x.machine.name === name)?.machine);
  return m ? <ProviderIcon provider={m.provider} os={m.os} size={13} /> : <LocalIcon size={13} />;
}

// ---------- new session ----------

export function NewSessionDialog({ machine: initial, dir: initialDir, onClose }: { machine?: string; dir?: string; onClose: () => void }) {
  const machines = useStore((s) => s.machines);
  const sessions = useStore((s) => s.sessions.sessions);
  const usable = machines.filter((m) => m.machine.status !== "stopped" && m.machine.status !== "missing");
  const [machine, setMachine] = useState(initial ?? usable[0]?.machine.name ?? "");
  const [dir, setDir] = useState(initialDir ?? "");
  const [name, setName] = useState("");
  const [agent, setAgent] = useState("claude"); // claude | codex | grok | mantis | shell
  const [installed, setInstalled] = useState<string[] | null>(null); // the agents on that machine
  const claude = agent === "claude";
  const [prompt, setPrompt] = useState("");
  const [skip, setSkip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const suggestions = useMemo(() => {
    const set = new Set<string>();
    sessions.filter((s) => s.machine === machine).forEach((s) => s.path && set.add(tildePath(s.path)));
    return [...set].filter((p) => p !== "~").slice(0, 8);
  }, [sessions, machine]);

  useEffect(() => {
    if (!machine && usable[0]) setMachine(usable[0].machine.name);
  }, [usable, machine]);
  // Which agents the machine has: the others are shown, but can't be picked.
  useEffect(() => {
    if (!machine) return;
    let off = false;
    setInstalled(null);
    call<string[]>("AgentsOn", machine).then((list) => {
      if (off) return;
      setInstalled(list);
      setAgent((a) => (a === "shell" || list.includes(a) ? a : list.includes("claude") ? "claude" : (list[0] ?? "shell")));
    }, () => !off && setInstalled([]));
    return () => {
      off = true;
    };
  }, [machine]);

  const create = async () => {
    if (!machine) return;
    if (machine === LOCAL) {
      // This computer: the pane makes the session itself.
      onClose();
      const d = dir.trim() || undefined;
      if (agent === "shell") openLocalTab("group", d);
      else openAgentTab(LOCAL, agent, "group", d, prompt.trim() || undefined);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const s = await api.newSession(machine, {
        name,
        dir: dir.trim() || "~",
        claude,
        agent: agent === "claude" || agent === "shell" ? "" : agent,
        prompt: agent === "shell" || agent === "mantis" ? "" : prompt,
        args: claude && skip ? "--dangerously-skip-permissions" : "",
      });
      onClose();
      openSessionTab(s.machine, s.name);
      loadSessions();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (usable.length === 0) {
    return (
      <Modal open onClose={onClose} width={440}>
        <ModalHeader title="New session" onClose={onClose} icon={<BrandIcon name="claude" size={16} />} />
        <div className="px-5 py-6 text-[13px] text-muted">
          {machines.length === 0 ? "You don't have a machine yet." : "All your machines are stopped. Start one first."}
          <div className="mt-4 flex gap-2">
            {machines.length === 0 ? (
              <Button variant="primary" onClick={() => setState({ modal: { type: "new-machine" } })}>
                Create a machine
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setState({ modal: null, view: "machines" })}>
                Go to machines
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                onClose();
                openLocalTab();
              }}
            >
              Local terminal instead
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} width={520}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) create();
        }}
      >
        <ModalHeader title="New session" subtitle="A tmux session on the machine. It keeps running when you close the tab." onClose={onClose} icon={<AgentIcon agent={agent === "shell" ? undefined : agent} size={16} />} />
        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Machine">
              <Select value={machine} onChange={setMachine} options={[...usable.map((m) => ({ value: m.machine.name, label: m.machine.name })), { value: LOCAL, label: "This Mac" }]} />
            </Field>
            <Field label="Name" hint="Optional">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={agent !== "shell" ? `${agent}-${baseName(dir || "home")}` : baseName(dir || "home")} />
            </Field>
          </div>
          <Field label="Folder" hint="Created if it doesn't exist. Clone repos from Folders.">
            <Input mono autoFocus list="sky-dirs" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="~/code/my-repo" />
            <datalist id="sky-dirs">
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>
          {/* what runs in it: an agent, or a plain shell */}
          <Field label="Start">
            <div className="grid grid-cols-5 gap-1.5">
              {(["claude", "codex", "grok", "mantis", "shell"] as const).map((a) => {
                const missing = a !== "shell" && installed !== null && !installed.includes(a);
                return (
                  <button
                    key={a}
                    type="button"
                    disabled={missing}
                    title={missing ? `${AGENT_NAMES[a]} isn't installed on ${machine}` : undefined}
                    onClick={() => setAgent(a)}
                    className={cx(
                      "flex h-[58px] flex-col items-center justify-center gap-1.5 rounded-lg text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-35",
                      agent === a ? "bg-active text-fg ring-1 ring-[var(--line-strong)]" : "bg-[color-mix(in_srgb,var(--fg)_4%,transparent)] text-muted hover:bg-hover hover:text-fg",
                    )}
                  >
                    <AgentIcon agent={a === "shell" ? undefined : a} size={17} />
                    {a === "shell" ? "Shell" : AGENT_NAMES[a]}
                  </button>
                );
              })}
            </div>
          </Field>
          {(agent === "codex" || agent === "grok") && (
            <Field label="First message" hint={`Optional. Sent to ${AGENT_NAMES[agent]} as the session starts.`}>
              <Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Fix the failing tests in packages/api" />
            </Field>
          )}
          {claude && (
            <>
              <Field label="First message" hint="Optional. Sent to Claude as the session starts.">
                <Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Fix the failing tests in packages/api and open a PR" />
              </Field>
              <div className={cx("rounded-lg border px-3 py-2.5", skip ? "border-[color-mix(in_srgb,var(--amber)_45%,transparent)] bg-[color-mix(in_srgb,var(--amber)_7%,transparent)]" : "border-line")}>
                <div className="flex items-center justify-between">
                  <div className="text-[13px] font-medium text-fg">Skip permission prompts</div>
                  <Toggle checked={skip} onChange={setSkip} />
                </div>
                {skip && (
                  <div className="mt-1.5 flex gap-1.5 text-[11.5px] leading-snug text-warn">
                    <AlertTriangle size={13} className="mt-px shrink-0" />
                    Claude will run commands and edit files without asking (--dangerously-skip-permissions). Only use it on a machine you're happy to
                    let it change freely.
                  </div>
                )}
              </div>
            </>
          )}
          {error && <div className="rounded-lg bg-[color-mix(in_srgb,var(--red)_10%,transparent)] px-3 py-2 text-[12px] text-bad">{error}</div>}
        </div>
        <div className="flex items-center justify-between border-t border-line px-5 py-3">
          <span className="text-[11.5px] text-subtle">
            <Kbd>{mod.replace("+", "")}↵</Kbd> to start
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" loading={busy} disabled={!machine}>
              Start session
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
