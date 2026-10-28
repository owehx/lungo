// Split panes: each pane is a terminal, positioned by its group's layout. Panes are rendered
// in one flat list and only moved with CSS, so splitting, resizing or switching tabs never
// re-mounts a terminal.
import { memo, useRef } from "react";
import { AppWindow, SquareArrowOutUpRight, ArrowDownToLine, ArrowUpFromLine, Columns2, Copy, Files, Folder, FolderOpen, GitBranch, Globe, Maximize2, Monitor, MoreVertical, RotateCcw, Rows2, SquareTerminal, X } from "lucide-react";
import { api, errText, type Port, type Session } from "../lib/api";
import { showMenu } from "./ContextMenu";
import { setDragged } from "../lib/drag";
import { filesOf, openFiles } from "../lib/peek";
import { openScreen } from "../lib/screen";
import { bringHere, continueOn } from "../lib/projects";
import {
  PANE_FOOTER,
  closeTab,
  focusPane,
  gitKey,
  isIdleShell,
  LOCAL,
  machineLabel,
  moveToOwnTab,
  moveToNewWindow,
  openSessionTab,
  paneFolder,
  paneTitle,
  persistent,
  reattachTab,
  resizeGroup,
  splitPane,
  tabMachine,
  toast,
  toggleZoom,
  useStore,
  type Group,
  type Tab,
  setState,
  getState,
} from "../lib/store";
import { dragSizes, isLeaf, node, type Divider, type Rect } from "../lib/panes";
import { agentOf, cx, hasAgent, mod } from "../lib/util";
import { TerminalView } from "./Terminal";
import { MoveButton } from "./MoveButton";
import { JoinedButton, JoinedFooter, JoinedIcon, ShareButton } from "./Share";
import { Menu } from "./ui";
import { AgentIcon, BrandIcon, LocalIcon, ProviderIcon, SessionIcon } from "./Brand";

/** The icon for what a pane shows: Claude's logo (with its state) wherever Claude runs. */
export function PaneIcon({ tab, session, size = 13 }: { tab: Tab; session?: Session; size?: number }) {
  const machine = useStore((s) => s.machines.find((m) => m.machine.name === tab.machine)?.machine);
  if (tab.kind === "joined") return <JoinedIcon tab={tab} size={size} />;
  if (tab.kind === "session" || hasAgent(session)) return <SessionIcon s={session ?? ({ claude: !!tab.claude, agent: tab.agent } as Session)} size={size} />;
  if (tab.claude) return <BrandIcon name="claude" size={size} title="Claude" />;
  if (tab.agent) return <AgentIcon agent={tab.agent} size={size} />;
  if (tab.kind === "local") return <LocalIcon size={size} />;
  return <ProviderIcon provider={machine?.provider} os={machine?.os} size={size} />;
}

const pct = (n: number) => `${n * 100}%`;

interface FrameProps {
  tab: Tab;
  rect: Rect | null; // null = not on screen right now
  focused: boolean;
  multi: boolean; // the tab has more than one pane, so panes get a title bar
  session?: Session;
}

/** One pane, placed at rect inside the pane area. Hidden panes keep their terminal alive. */
export const PaneFrame = memo(
  function PaneFrame({ tab, rect, focused, multi, session }: FrameProps) {
    const shown = !!rect;
    const footer = useStore((s) => s.term.footer);
    return (
      <div
        className={cx("absolute flex-col", shown ? "flex" : "hidden", focused ? "z-[11]" : "z-10")}
        style={rect ? { left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) } : undefined}
        onMouseDownCapture={() => {
          if (shown && !focused) focusPane(tab.key);
        }}
      >
        {multi && <PaneHeader tab={tab} focused={focused} session={session} />}
        <div className="relative min-h-0 flex-1">
          <TerminalView tab={tab} active={shown} focused={focused && shown} />
        </div>
        {footer && (tab.kind === "joined" ? <JoinedFooter tab={tab} height={PANE_FOOTER} /> : <PaneFooter tab={tab} />)}
      </div>
    );
  },
  (a, b) =>
    a.tab === b.tab && a.focused === b.focused && a.multi === b.multi && a.session === b.session &&
    (a.rect === b.rect || (!!a.rect && !!b.rect && a.rect.x === b.rect.x && a.rect.y === b.rect.y && a.rect.w === b.rect.w && a.rect.h === b.rect.h)),
);

/** A pane's title bar: centred name, a corner mark on the focused pane, menu and close. */
function PaneHeader({ tab, focused, session }: { tab: Tab; focused: boolean; session?: Session }) {
  const title = paneTitle(tab);
  return (
    <div
      className="z relative flex h-[26px] shrink-0 cursor-grab items-center border-b border-line pr-1 pl-[46px] active:cursor-grabbing"
      style={{ background: "var(--term-bg)" }}
      title="Drag onto the tab bar to give it a tab of its own, or onto another pane to move it there"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", title);
        setDragged({ pane: tab.key, machine: tabMachine(tab), session: tab.session });
      }}
      onDragEnd={() => setDragged(null)}
    >
      {focused && <span className="absolute top-0 left-0 size-0 border-t-[10px] border-r-[10px] border-t-accent border-r-transparent" />}
      <span className={cx("flex min-w-0 flex-1 items-center justify-center gap-1.5 text-[11.5px]", focused ? "text-fg" : "text-subtle")}>
        <PaneIcon tab={tab} session={session} size={11} />
        <span className="truncate">{title}</span>
        {tab.kind !== "local" && tab.machine && title !== tab.machine && <span className="shrink-0 text-subtle">{tab.machine}</span>}
        {session && hasAgent(session) && session.state === "waiting" && (
          <span className="shrink-0 text-warn" title={session.message || "Waiting for you"}>
            needs you
          </span>
        )}
      </span>
      <ShareButton tab={tab} session={session} />
      <JoinedButton tab={tab} />
      <MoveButton tab={tab} session={session} />
      <PaneMenu tab={tab} />
      <button
        title={`Close pane (${mod}W)`}
        onClick={(e) => {
          e.stopPropagation();
          closeTab(tab.key);
        }}
        className="flex size-5 items-center justify-center rounded text-subtle hover:bg-active hover:text-fg"
      >
        <X size={12} />
      </button>
    </div>
  );
}

const NO_PORTS: Port[] = [];

const chip =
  "flex h-[22px] max-w-full min-w-0 items-center gap-1.5 rounded-md border border-line-strong px-2 text-[11.5px] text-muted transition-colors hover:border-[var(--subtle)] hover:text-fg";

/** Under a pane: the folder it is in and, in a repository, its branch and what has changed. */
function PaneFooter({ tab }: { tab: Tab }) {
  const folder = paneFolder(tab);
  const git = useStore((s) => s.git[gitKey(tab)]);
  const machines = useStore((s) => s.machines);
  const local = tab.kind === "local";
  const ports = useStore((s) => (tab.session ? s.ports[local ? LOCAL : (tab.machine ?? "")]?.[tab.session] : undefined)) ?? NO_PORTS;
  const here = (fn: () => void) => () => {
    focusPane(tab.key);
    fn();
  };
  const copy = (text: string) => () => api.copy(text).then(() => toast("info", "Copied", text));
  const repo = git?.repo ? git : undefined;
  const root = repo?.root || tab.cwd || "";
  const up = machines.filter((m) => m.machine.status === "running" || !m.machine.status).map((m) => m.machine.name);
  const state = repo ? [repo.changed ? `${repo.changed} changed` : "clean", repo.ahead ? `${repo.ahead} ahead` : "", repo.behind ? `${repo.behind} behind` : ""].filter(Boolean).join(" · ") : "";
  return (
    <div className="z flex shrink-0 items-center gap-1.5 pr-1.5 pl-1.5" style={{ height: PANE_FOOTER, background: "var(--term-bg)" }}>
      {/* The folder and branch shrink to fit the pane (a long path ran on into the next one). */}
      {folder && (
        <div className="min-w-0">
          <Menu
            side="top"
            align="left"
            trigger={
              <button title={tab.cwd} className={chip}>
                <Folder size={12} className="shrink-0 text-subtle" />
                <span className="truncate">{folder}</span>
              </button>
            }
            items={[
              { label: "Copy path", icon: <Copy size={13} />, onClick: copy(tab.cwd ?? folder) },
              ...(local ? [{ label: "Reveal in Finder", icon: <FolderOpen size={13} />, onClick: () => api.reveal(tab.cwd ?? folder).catch(() => {}) }] : []),
              "sep" as const,
              { label: "New terminal here", icon: <SquareTerminal size={13} />, hint: `${mod}D`, onClick: here(() => splitPane("row", "shell")) },
              { label: "New Claude session here", icon: <BrandIcon name="claude" size={13} />, onClick: here(() => splitPane("row", "claude")) },
            ]}
          />
        </div>
      )}
      {repo?.branch && (
        <div className="min-w-0">
          <Menu
            side="top"
            align="left"
            trigger={
              <button title={`${repo.detached ? "Detached at" : "On"} ${repo.branch} · ${state}`} className={chip}>
                <GitBranch size={12} className="shrink-0 text-subtle" />
                <span className="truncate">{repo.branch}</span>
                {repo.changed > 0 && (
                  <span className="flex shrink-0 items-center gap-1 text-subtle tabular-nums">
                    <span className="size-[5px] rounded-full bg-warn" />
                    {repo.changed}
                  </span>
                )}
                {repo.ahead > 0 && <span className="shrink-0 text-subtle tabular-nums">↑{repo.ahead}</span>}
                {repo.behind > 0 && <span className="shrink-0 text-subtle tabular-nums">↓{repo.behind}</span>}
              </button>
            }
            items={[
              { label: "Copy branch name", icon: <Copy size={13} />, onClick: copy(repo.branch) },
              // The repository goes over as it is: branch, commits, and work not committed yet.
              ...(local
                ? up.length
                  ? (["sep", ...up.slice(0, 5).map((m) => ({ label: `Continue on ${m}`, icon: <ArrowUpFromLine size={13} />, onClick: () => void continueOn(m, root) }))] as const)
                  : []
                : tab.machine
                  ? (["sep", { label: "Bring to this computer", icon: <ArrowDownToLine size={13} />, onClick: () => void bringHere(tab.machine!, root) }] as const)
                  : []),
            ]}
          />
        </div>
      )}
      {ports.map((p) => (
        <PortChip key={p.port} tab={tab} port={p} />
      ))}
      {!local && machines.find((x) => x.machine.name === tab.machine)?.machine.os === "darwin" && (
        <button title={`See and use the screen of ${tab.machine} (⇧${mod}S)`} onClick={() => openScreen(tab.machine!)} className={cx(chip, "ml-auto shrink-0")}>
          <Monitor size={12} className="shrink-0 text-subtle" />
          <span>Screen</span>
        </button>
      )}
      {(local || tab.machine) && (
        <button title={`Files on ${local ? "this computer" : tab.machine}: what was made here lately (${mod}O). ${mod}-click a file name in the session to see it.`} onClick={() => openFiles(filesOf(tab))} className={cx(chip, "shrink-0", (local || machines.find((x) => x.machine.name === tab.machine)?.machine.os !== "darwin") && "ml-auto")}>
          <Files size={12} className="shrink-0 text-subtle" />
          <span>Files</span>
        </button>
      )}
    </div>
  );
}

/**
 * A port something in the pane is listening on (a dev server you or Claude started). One
 * click opens it in the browser: straight away on this computer, through a tunnel on a machine.
 */
function PortChip({ tab, port }: { tab: Tab; port: Port }) {
  const local = tab.kind === "local";
  const tunnel = useStore((s) => (local ? undefined : s.tunnels.find((t) => t.machine === tab.machine && t.remotePort === port.port)));
  const url = local ? `http://localhost:${port.port}` : tunnel?.url;
  const open = () => {
    if (local) return void api.openURL(`http://localhost:${port.port}`);
    if (tunnel) return void api.openURL(tunnel.url);
    api.openPort(tab.machine!, port.port, true).then(
      (t) => toast("info", `${t.url.replace(/^https?:\/\//, "")} is ${tab.machine}:${port.port}`, "Open in your browser; the tunnel stays up while the app runs."),
      (e) => toast("error", `Couldn't forward port ${port.port}`, errText(e)),
    );
  };
  return (
    <button
      onClick={open}
      onContextMenu={(e) =>
        showMenu(e, [
          { label: "Open in the browser", icon: <Globe size={13} />, onClick: open },
          ...(url ? [{ label: "Copy address", icon: <Copy size={13} />, onClick: () => void api.copy(url).then(() => toast("info", "Copied", url)) }] : []),
          ...(tunnel ? [{ label: "Stop forwarding", icon: <X size={13} />, onClick: () => void api.closeTunnel(tunnel.id) }] : []),
        ])
      }
      title={`${port.process || "A program"} is listening on port ${port.port}${local ? "" : tunnel ? ` · forwarded to ${tunnel.url}` : " · click to forward it and open it"}`}
      className={cx(chip, "shrink-0 tabular-nums", tunnel && "border-[color-mix(in_srgb,var(--accent)_55%,transparent)] text-fg")}
    >
      <Globe size={12} className={cx("shrink-0", tunnel ? "text-accent" : "text-subtle")} />
      {port.port}
    </button>
  );
}

/** The ⋮ menu: split like this pane or with a specific kind, attach a session, zoom, close. */
function PaneMenu({ tab }: { tab: Tab }) {
  const sessions = useStore((s) => s.sessions.sessions);
  const tabs = useStore((s) => s.tabs);
  const open = new Set(tabs.filter((t) => t.session).map((t) => `${tabMachine(t)}/${t.session}`));
  const attachable = sessions.filter((s) => !open.has(`${s.machine}/${s.name}`) && !isIdleShell(s)).slice(0, 6);
  const here = (fn: () => void) => () => {
    focusPane(tab.key);
    fn();
  };
  return (
    <Menu
      trigger={
        <button title="Pane options" className="flex size-5 items-center justify-center rounded text-subtle hover:bg-active hover:text-fg">
          <MoreVertical size={12} />
        </button>
      }
      items={[
        { label: "Split right", icon: <Columns2 size={13} />, hint: `${mod}D`, onClick: here(() => splitPane("row")) },
        { label: "Split down", icon: <Rows2 size={13} />, hint: `⇧${mod}D`, onClick: here(() => splitPane("col")) },
        { label: "Split with Claude here", icon: <BrandIcon name="claude" size={13} />, onClick: here(() => splitPane("row", "claude")) },
        { label: "Split with shell here", icon: <SquareTerminal size={13} />, onClick: here(() => splitPane("row", "shell")) },
        { label: "Start an agent here…", icon: <AgentIcon agent="codex" size={13} />, onClick: () => setState({ modal: { type: "new-session", machine: tab.kind === "local" ? LOCAL : tab.machine, dir: tab.cwd } }) },
        { label: "Zoom", icon: <Maximize2 size={13} />, hint: `⇧${mod}↩`, onClick: here(toggleZoom) },
        { label: "Move to its own tab", icon: <SquareArrowOutUpRight size={13} />, onClick: () => moveToOwnTab(tab.key) },
        { label: "Move to new window", icon: <AppWindow size={13} />, onClick: () => moveToNewWindow(tab.key) },
        ...(attachable.length ? (["sep"] as const) : []),
        ...attachable.map((s) => ({
          label: `Open ${s.title || s.name}`,
          icon: <AgentIcon agent={agentOf(s)} size={13} />,
          hint: machineLabel(s.machine),
          onClick: here(() => openSessionTab(s.machine, s.name, "row")),
        })),
        "sep" as const,
        { label: persistent(tab) ? "Reconnect" : "New shell", icon: <RotateCcw size={13} />, onClick: () => reattachTab(tab.key) },
        { label: "Close pane", icon: <X size={13} />, hint: `${mod}W`, onClick: () => closeTab(tab.key) },
      ]}
    />
  );
}

/** The draggable line between two panes. */
export function DividerHandle({ group, d, area }: { group: Group; d: Divider; area: React.RefObject<HTMLDivElement | null> }) {
  const dragging = useRef(false);
  const at = useRef(0);
  const frame = useRef(0);
  const row = d.dir === "row";
  // The pointer can move many times a frame: the panes are resized once a frame, to where it
  // is by then.
  const move = (e: React.PointerEvent) => {
    if (!dragging.current || !area.current) return;
    const box = area.current.getBoundingClientRect();
    at.current = row ? (e.clientX - box.left) / box.width : (e.clientY - box.top) / box.height;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const g = getState().groups.find((x) => x.id === group.id);
      const sizes = g ? dragSizes(g.layout, d, at.current) : [];
      if (sizes.length) resizeGroup(group.id, d.path, sizes);
    });
  };
  return (
    <div
      className={cx("group/div absolute z-20", row ? "w-[9px] -translate-x-1/2 cursor-col-resize" : "h-[9px] -translate-y-1/2 cursor-row-resize")}
      style={row ? { left: pct(d.at), top: pct(d.rect.y), height: pct(d.rect.h) } : { top: pct(d.at), left: pct(d.rect.x), width: pct(d.rect.w) }}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={move}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onDoubleClick={() => {
        // Even out the two panes on either side.
        const n = node(group.layout, d.path);
        if (isLeaf(n)) return;
        const sizes = [...n.sizes];
        const pair = sizes[d.index] + sizes[d.index + 1];
        sizes[d.index] = sizes[d.index + 1] = pair / 2;
        resizeGroup(group.id, d.path, sizes);
      }}
    >
      <div className={cx("absolute bg-line transition-colors group-hover/div:bg-accent", row ? "inset-y-0 left-1/2 w-px" : "inset-x-0 top-1/2 h-px")} />
    </div>
  );
}
