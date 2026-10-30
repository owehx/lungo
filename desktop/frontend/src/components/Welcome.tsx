// The welcome: what Lungo is and how it works, told as stories, the first time it opens (and
// from Help ▸ Welcome to Lungo). The first stories look around and set up (the agents on this
// Mac, the machines, the logins that follow you), the middle ones each play a little scene of
// something the app does and move on by themselves, and the last ones pick a look and start
// something. Enter or → goes on, ← goes back, Esc skips the rest.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowLeft, Check, Copy, Download, FileText, Folder, Plus, Server } from "lucide-react";
import { api, call, errText, type ClaudeStatus, type Credential } from "../lib/api";
import { LOCAL, finishWelcome, getState, isDark, openAgentTab, pickSkin, runOp, setState, setTheme, toast, useStore, waitOp, type Theme } from "../lib/store";
import { AGENT_NAMES, cx } from "../lib/util";
import { APP_ICONS, appIconSrc } from "../lib/appicons";
import { THEMES } from "../lib/themes";
import { AgentIcon, BrandIcon, LocalIcon, ProviderIcon, isBrand } from "./Brand";
import { Spinner, WorkingMark } from "./ui";
import { ThemeTile } from "../views/Settings";
import { AGENTS } from "./AgentMenu";
import { useClaudeAccounts } from "./ClaudeAccounts";

type StoryId = "hello" | "agents" | "machines" | "logins" | "sessions" | "panes" | "files" | "move" | "screen" | "look" | "go";
const STORIES: { id: StoryId; auto?: boolean }[] = [
  { id: "hello" },
  { id: "agents" },
  { id: "machines" },
  { id: "logins" },
  { id: "sessions", auto: true },
  { id: "panes", auto: true },
  { id: "files", auto: true },
  { id: "move", auto: true },
  { id: "screen", auto: true },
  { id: "look" },
  { id: "go" },
];
const SCENE_MS = 7000; // how long a feature story plays before the next

/** How to put an agent on this Mac, where it's a one-liner. Claude Code the app installs itself. */
const INSTALL: Record<string, string> = {
  codex: "npm i -g @openai/codex",
  mantis: "uv tool install mantis-agent-sdk",
};

interface Found {
  agents: { id: string; version: string }[] | null; // null while looking
  claude: ClaudeStatus | null;
  creds: Credential[] | null;
}

/** What is here: the agents and their versions, Claude's login, the CLI logins. Asked once. */
function useLookAround(): Found {
  const [agents, setAgents] = useState<Found["agents"]>(null);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [creds, setCreds] = useState<Credential[] | null>(null);
  useEffect(() => {
    const started = Date.now();
    // A moment of looking even when the answer is instant: the cards land one by one after it.
    call<{ id: string; version: string }[]>("AgentVersions", LOCAL).then(
      (list) => window.setTimeout(() => setAgents(list ?? []), Math.max(0, 900 - (Date.now() - started))),
      () => setAgents([]),
    );
    api.claude().then(setClaude, () => {});
    api.credentials().then(
      (c) => setCreds(c ?? []),
      () => setCreds([]),
    );
  }, []);
  return { agents, claude, creds };
}

export function Welcome() {
  const [at, setAt] = useState(0);
  const [progress, setProgress] = useState(0); // how far a feature story has played, 0–1
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const found = useLookAround();
  const story = STORIES[at];
  const go = (n: number) => setAt(Math.max(0, Math.min(STORIES.length - 1, n)));

  // A feature story plays for a while, then the next one comes (pointer on it: it waits).
  useEffect(() => {
    setProgress(0);
    if (!story.auto) return;
    let raf = 0;
    let last = performance.now();
    let t = 0;
    const tick = (now: number) => {
      if (!pausedRef.current) t += now - last;
      last = now;
      setProgress(Math.min(1, t / SCENE_MS));
      if (t >= SCENE_MS) return setAt((x) => Math.min(STORIES.length - 1, x + 1));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [at, story.auto]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (getState().modal || e.metaKey || e.ctrlKey || e.altKey) return; // a dialog opened from a story has the keyboard
      if (e.key === "Escape") finishWelcome();
      else if (e.key === "Enter" || e.key === "ArrowRight") at === STORIES.length - 1 ? finishWelcome() : go(at + 1);
      else if (e.key === "ArrowLeft") go(at - 1);
      else if (e.key === " " && story.auto) setPaused((p) => !p);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [at, story.auto]);

  const last = at === STORIES.length - 1;
  return (
    <div className="z anim-fade fixed inset-0 z-[45] flex flex-col bg-bg text-fg">
      {/* the window moves by its top, as everywhere */}
      <div className="drag h-[40px] shrink-0" />
      {/* the stories, as segments */}
      <div className="mx-auto flex w-full max-w-[680px] items-center gap-1.5 px-8">
        {STORIES.map((s, k) => (
          <button key={s.id} onClick={() => go(k)} aria-label={`Story ${k + 1}`} className="no-drag group flex h-4 flex-1 items-center">
            <span className="relative h-[3px] w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--fg)_11%,transparent)] transition-colors group-hover:bg-[color-mix(in_srgb,var(--fg)_20%,transparent)]">
              <span
                className={cx("absolute inset-y-0 left-0 rounded-full", k === at ? "bg-fg" : "bg-[color-mix(in_srgb,var(--fg)_55%,transparent)]")}
                style={{ width: k < at ? "100%" : k === at ? `${(s.auto ? progress : 1) * 100}%` : "0%", transition: k === at && s.auto ? "none" : "width 300ms ease" }}
              />
            </span>
          </button>
        ))}
      </div>
      <button onClick={finishWelcome} className="no-drag absolute top-[52px] right-6 rounded-md px-2 py-1 text-[12px] text-subtle transition-colors hover:text-fg">
        Skip
      </button>

      <div className="flex min-h-0 flex-1 overflow-y-auto px-8" onMouseEnter={() => story.auto && setPaused(true)} onMouseLeave={() => setPaused(false)}>
        <div key={story.id} className="m-auto w-full max-w-[680px] py-10">
          <Story id={story.id} found={found} />
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[680px] items-center justify-between px-8 pb-8">
        <button
          onClick={() => go(at - 1)}
          className={cx("flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] text-subtle transition-colors hover:text-fg", at === 0 && "invisible")}
        >
          <ArrowLeft size={13} /> Back
        </button>
        <div className="flex items-center gap-3">
          {story.auto && <span className="text-[11.5px] text-subtle">{paused ? "Paused" : "Space to pause"}</span>}
          <button
            onClick={() => (last ? finishWelcome() : go(at + 1))}
            className="flex h-9 items-center gap-2.5 rounded-full bg-fg pr-2 pl-4 text-[13px] font-medium text-bg transition-transform hover:scale-[1.03] active:scale-[0.98]"
          >
            {at === 0 ? "Let's go" : last ? "Take me in" : "Continue"}
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--bg)_16%,transparent)] px-1 text-[11px]">↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function Story({ id, found }: { id: StoryId; found: Found }) {
  switch (id) {
    case "hello":
      return <Hello />;
    case "agents":
      return <Agents found={found} />;
    case "machines":
      return <Machines />;
    case "logins":
      return <Logins found={found} />;
    case "sessions":
      return (
        <Frame keys={[["⌘", "J"]]} title="Know which one needs you" body="Every session on every machine, in one list: working, waiting on you, done. A nudge when one asks you something, and ⌘J takes you to it.">
          <SceneSessions />
        </Frame>
      );
    case "panes":
      return (
        <Frame keys={[["⌘", "D"], ["⇧", "⌘", "D"], ["⌃", "Tab"]]} delays={[0.14, 0.4, 0.64]} title="Split, stack, switch" body="⌘D puts a shell beside you in the same folder, ⇧⌘D stacks one below, ⌃Tab flips through your recent sessions.">
          <ScenePanes />
        </Frame>
      );
    case "files":
      return (
        <Frame keys={[["⌘", "O"]]} title="See what your agents made" body="⌘O lists what was made lately on a pane's machine. Open it here, or ⌘-click a path right in the terminal.">
          <SceneFiles />
        </Frame>
      );
    case "move":
      return (
        <Frame cmd="claude --resume" title="Move a folder, conversation and all" body="Send a project from one device to another from Folders. The Claude conversation goes too, so you pick it up there where you left off.">
          <SceneMove />
        </Frame>
      );
    case "screen":
      return (
        <Frame keys={[["⇧", "⌘", "S"]]} title="Reach a Mac's screen" body="⇧⌘S brings up the screen of a Mac you work on, right here in the window. Click, type, look around.">
          <SceneScreen />
        </Frame>
      );
    case "look":
      return <Look />;
    case "go":
      return <Go found={found} />;
  }
}

// ---------- the frame every story shares ----------

const TYPE_WAIT = 250;
const TYPE_SPEED = 42;
/** When a command has finished typing itself out, in ms from the story's start. */
const typedBy = (cmd: string) => TYPE_WAIT + cmd.length * TYPE_SPEED + 180;

/** Types text out, a character at a time, after a pause. */
function useTyped(text: string, wait = TYPE_WAIT, speed = TYPE_SPEED): string {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    let i = 0;
    let t = window.setTimeout(function step() {
      i++;
      setN(i);
      if (i < text.length) t = window.setTimeout(step, speed);
    }, wait);
    return () => window.clearTimeout(t);
  }, [text, wait, speed]);
  return text.slice(0, n);
}

const delay = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

/**
 * A story: a command typing itself out (or the keys that do it), the title, a line saying
 * what it means, and what it shows.
 */
function Frame({ cmd, keys, delays, title, body, lead, children }: { cmd?: string; keys?: string[][]; delays?: number[]; title: ReactNode; body: ReactNode; lead?: ReactNode; children: ReactNode }) {
  const typed = useTyped(cmd ?? "");
  return (
    <div>
      {lead && <div className="mb-6">{lead}</div>}
      {cmd !== undefined && (
        <div className="flex h-6 items-center font-mono text-[12.5px]">
          <span className="text-subtle">~ %</span>
          <span className="ml-2 text-fg">{typed}</span>
          <span className="wl-caret ml-px inline-block h-[15px] w-[7px] translate-y-px bg-accent" />
        </div>
      )}
      {keys && (
        <div className="wl-rise flex h-6 items-center gap-3" style={delay(0)}>
          {keys.map((combo, k) => (
            <span key={k} className="flex items-center gap-1">
              {combo.map((c) => (
                <kbd
                  key={c}
                  className="flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 font-sans text-[11.5px] font-medium"
                  style={
                    delays
                      ? { animation: `wl-key ${SCENE_MS}ms linear ${delays[k] * SCENE_MS}ms infinite none`, background: "color-mix(in srgb, var(--fg) 7%, transparent)", color: "var(--muted)" }
                      : { background: "color-mix(in srgb, var(--fg) 8%, transparent)", color: "var(--fg)" }
                  }
                >
                  {c}
                </kbd>
              ))}
            </span>
          ))}
        </div>
      )}
      <h1 className="wl-rise mt-5 text-[30px] leading-[1.15] font-semibold tracking-[-0.025em] text-fg" style={delay(90)}>
        {title}
      </h1>
      <p className="wl-rise mt-2.5 max-w-[540px] text-[14px] leading-[1.6] text-muted" style={delay(170)}>
        {body}
      </p>
      <div className="wl-rise mt-9" style={delay(260)}>
        {children}
      </div>
    </div>
  );
}

const TILE = "rounded-2xl bg-[color-mix(in_srgb,var(--fg)_4.5%,transparent)]";

// ---------- hello ----------

function Hello() {
  const icon = useStore((s) => s.info?.appIcon);
  const machines = useStore((s) => s.machines);
  return (
    <Frame
      cmd="lungo"
      title="Every agent. Every machine. One terminal."
      body="Lungo runs your coding agents on this Mac and on machines that never sleep. Close the lid, lose Wi-Fi, restart: every session keeps going."
      lead={
        // the picture carries the system's margin around the tile; this crops to the tile
        <span className="wl-pop relative block size-12 overflow-hidden rounded-[10.8px]" style={delay(60)}>
          <img src={appIconSrc(icon)} alt="" draggable={false} className="absolute -top-1.5 -left-1.5 h-[60px] w-[60px] max-w-none" />
        </span>
      }
    >
      <div className="flex flex-col items-start gap-4">
        <div className="flex items-center gap-2.5">
          {AGENTS.map((a, k) => (
            <span key={a} title={AGENT_NAMES[a]} className={cx(TILE, "wl-pop flex size-14 items-center justify-center")} style={delay(450 + k * 120)}>
              <AgentIcon agent={a} size={24} />
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {[LOCAL, ...machines.map((m) => m.machine.name)].slice(0, 5).map((m, k) => (
            <span key={m} className="wl-pop flex h-7 items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--fg)_5%,transparent)] px-2.5 text-[11.5px] text-muted" style={delay(950 + k * 110)}>
              <PlaceIcon name={m} />
              {m === LOCAL ? "This Mac" : m}
            </span>
          ))}
        </div>
      </div>
    </Frame>
  );
}

function PlaceIcon({ name, size = 12 }: { name: string; size?: number }) {
  const m = useStore((s) => s.machines.find((x) => x.machine.name === name)?.machine);
  return m ? <ProviderIcon provider={m.provider} os={m.os} size={size} /> : <LocalIcon size={size} />;
}

// ---------- agents ----------

/** Counts up to n when it changes, a step at a time. */
function useLanding(n: number, step = 260): number {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (shown >= n) return;
    const t = window.setTimeout(() => setShown((s) => s + 1), shown === 0 ? 120 : step);
    return () => window.clearTimeout(t);
  }, [shown, n, step]);
  return Math.min(shown, n);
}

const WHICH = "which claude codex grok mantis";

function Agents({ found }: { found: Found }) {
  const [typed, setTyped] = useState(false); // the answer comes once the question is asked
  useEffect(() => {
    const t = window.setTimeout(() => setTyped(true), typedBy(WHICH));
    return () => window.clearTimeout(t);
  }, []);
  const list = typed ? found.agents : null;
  const landed = useLanding(list ? AGENTS.length : 0, 300); // the cards turn over one by one
  const ready = list ? AGENTS.slice(0, landed).filter((a) => list.some((x) => x.id === a)).length : 0;
  const done = list !== null && landed === AGENTS.length;
  const title = !done ? "Looking for your agents…" : ready === 0 ? "No agents here yet" : ready === AGENTS.length ? "All four agents, ready" : `${ready} of ${AGENTS.length} agents ready`;
  return (
    <Frame
      cmd={WHICH}
      title={title}
      body="Start any of them in a click from Home, from + in the sidebar, or with ⇧⌘T. Each keeps its own logo, and Lungo reads from its screen when it's working or waiting on you."
    >
      <div className="grid grid-cols-2 gap-2.5">
        {AGENTS.map((a, k) => {
          const shown = k < landed;
          const v = list?.find((x) => x.id === a);
          return <AgentCard key={a} agent={a} state={!shown ? "looking" : v ? "ready" : "missing"} version={v?.version} />;
        })}
      </div>
    </Frame>
  );
}

function AgentCard({ agent, state: found, version: foundVersion }: { agent: string; state: "looking" | "ready" | "missing"; version?: string }) {
  const [copied, setCopied] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState<string | null>(null); // the version just installed here
  const install = INSTALL[agent];
  const state = installed !== null ? "ready" : found;
  const version = installed || foundVersion;
  const installClaude = async () => {
    setInstalling(true);
    try {
      const end = await waitOp(await runOp(api.installClaude(), true));
      if (end.error) toast("error", "Couldn't install Claude Code", end.error);
      else {
        const list = await call<{ id: string; version: string }[]>("AgentVersions", LOCAL).catch(() => []);
        setInstalled(list?.find((x) => x.id === agent)?.version ?? "");
      }
    } catch {
      /* runOp said why */
    }
    setInstalling(false);
  };
  return (
    <div className={cx(TILE, "relative flex h-[84px] items-center gap-4 overflow-hidden px-4", state === "looking" && "wl-shimmer")}>
      <span className={cx("relative flex size-11 shrink-0 items-center justify-center rounded-xl transition-opacity duration-300", state === "missing" ? "opacity-40" : "opacity-100", state === "ready" && "wl-ring")}>
        <AgentIcon agent={agent} size={26} />
      </span>
      <div className="min-w-0 flex-1">
        <div className={cx("text-[14px] font-medium", state === "missing" ? "text-muted" : "text-fg")}>{AGENT_NAMES[agent]}</div>
        <div className="mt-0.5 h-[17px] text-[12px]">
          {state === "looking" && <span className="text-subtle">Looking…</span>}
          {state === "ready" && <span className="wl-rise block text-subtle">{version ? `v${version}` : "Installed"}</span>}
          {state === "missing" &&
            (agent === "claude" ? (
              <button
                onClick={installClaude}
                disabled={installing}
                title="Install Claude Code with Anthropic's installer"
                className="wl-rise flex items-center gap-1.5 text-[12px] font-medium text-accent transition-colors hover:text-fg disabled:text-subtle"
              >
                {installing ? <Spinner size={11} /> : <Download size={12} />}
                {installing ? "Installing…" : "Install"}
              </button>
            ) : install ? (
              <button
                onClick={() => api.copy(install).then(() => setCopied(true), (e) => toast("error", "Couldn't copy", errText(e)))}
                title="Copy the command that installs it"
                className="wl-rise flex max-w-full items-center gap-1.5 font-mono text-[11px] text-subtle transition-colors hover:text-fg"
              >
                <span className="truncate">{install}</span>
                {copied ? <Check size={11} className="shrink-0 text-ok" /> : <Copy size={11} className="shrink-0" />}
              </button>
            ) : (
              <span className="wl-rise block text-subtle">Not installed</span>
            ))}
        </div>
      </div>
      {state === "ready" && (
        <span className="wl-pop flex size-6 shrink-0 items-center justify-center rounded-full bg-ok text-black">
          <Check size={13} strokeWidth={3} />
        </span>
      )}
    </div>
  );
}

// ---------- machines ----------

function Machines() {
  const machines = useStore((s) => s.machines);
  const sessions = useStore((s) => s.sessions.sessions);
  const count = (m: string) => sessions.filter((s) => s.machine === m && !s.name.startsWith("shell-")).length;
  const places = [LOCAL, ...machines.map((m) => m.machine.name)];
  const status = (name: string) => {
    if (name === LOCAL) return { up: true, text: "Here" };
    const st = machines.find((m) => m.machine.name === name)?.machine.status;
    if (st === "running" || !st) return { up: true, text: "Up" };
    if (st === "stopped") return { up: false, text: "Stopped" };
    return { up: false, text: st[0].toUpperCase() + st.slice(1) };
  };
  return (
    <Frame
      cmd="sky machines"
      title={machines.length ? "Your machines are here" : "Run them anywhere"}
      body="Sessions live in tmux, on this Mac or on a machine. Lungo is the window onto them: quit it, and they keep working; open it, and every pane is back where it was."
    >
      <div className="grid grid-cols-2 gap-2.5">
        {places.slice(0, 6).map((p, k) => {
          const s = status(p);
          const n = count(p);
          return (
            <div key={p} className={cx(TILE, "wl-rise flex h-[68px] items-center gap-3.5 px-4")} style={delay(320 + k * 120)}>
              <span className="flex size-9 items-center justify-center">
                <PlaceIcon name={p} size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium text-fg">{p === LOCAL ? "This Mac" : p}</div>
                <div className="text-[11.5px] text-subtle">{n ? `${n} session${n === 1 ? "" : "s"}` : p === LOCAL ? "Ready" : "No sessions yet"}</div>
              </div>
              <span className={cx("flex items-center gap-1.5 text-[11.5px]", s.up ? "text-ok" : "text-subtle")}>
                <span className={cx("wl-ring size-[7px] rounded-full", s.up ? "bg-ok" : "bg-[var(--line-strong)]")} style={delay(520 + k * 120)} />
                {s.text}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-2.5">
        <button
          onClick={() => setState({ modal: { type: "new-machine" } })}
          className="flex h-[52px] items-center gap-3 rounded-2xl border border-dashed border-line-strong px-4 text-left transition-colors hover:border-[var(--fg)] hover:bg-hover"
        >
          <Plus size={15} className="text-muted" />
          <span className="flex-1 text-[13px] text-fg">A cloud machine</span>
          <span className="flex items-center gap-1.5 opacity-80">
            <BrandIcon name="gcp" size={14} />
            <BrandIcon name="aws" size={14} className="text-fg" />
            <BrandIcon name="azure" size={14} />
          </span>
        </button>
        <button
          onClick={() => setState({ modal: { type: "add-machine" } })}
          className="flex h-[52px] items-center gap-3 rounded-2xl border border-dashed border-line-strong px-4 text-left transition-colors hover:border-[var(--fg)] hover:bg-hover"
        >
          <Server size={15} className="text-muted" />
          <span className="flex-1 text-[13px] text-fg">One you have, over SSH</span>
        </button>
      </div>
    </Frame>
  );
}

// ---------- logins ----------

function Logins({ found }: { found: Found }) {
  const machines = useStore((s) => s.machines);
  const accounts = useClaudeAccounts() ?? [];
  const creds = (found.creds ?? []).filter((c) => c.present && !c.skipped);
  const shown = creds.slice(0, 11);
  // Signed in: an account Lungo signs sessions in with, or Claude Code's own login on this Mac.
  const inUse = accounts.find((a) => a.active) ?? accounts[0];
  const signedIn = !!inUse || !!found.claude?.signedIn;
  const claudeLine =
    found.claude === null ? "Looking…" : inUse ? `Sessions sign in as ${inUse.account.label || inUse.account.email || "your account"}` : signedIn ? "Signed in on this Mac" : "Not signed in yet. Sign in once and every session uses it.";
  const where = machines.length ? `They go to ${machines.map((m) => m.machine.name).slice(0, 3).join(", ")}${machines.length > 3 ? " and more" : ""}, and to any machine you add.` : "Add a machine and they go with it.";
  return (
    <Frame cmd="sky sync" title="Your logins follow you" body={`Sign in once, here. Claude Code, GitHub, your command-line tools and API keys go along, so no machine asks you to log in again. ${where}`}>
      <div className={cx(TILE, "flex items-center gap-3.5 px-4 py-3.5")}>
        <span className="flex size-9 items-center justify-center">
          <BrandIcon name="claude" size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium text-fg">Claude Code</div>
          <div className="text-[12px] text-subtle">{claudeLine}</div>
        </div>
        {!signedIn && found.claude !== null && (
          <button
            onClick={() => setState({ modal: { type: "add-claude" } })}
            className="flex h-8 shrink-0 items-center rounded-full bg-fg px-3.5 text-[12.5px] font-medium text-bg transition-transform hover:scale-[1.03] active:scale-[0.98]"
          >
            Sign in
          </button>
        )}
        {signedIn && (
          <span className="wl-pop flex size-6 items-center justify-center rounded-full bg-ok text-black" style={delay(350)}>
            <Check size={13} strokeWidth={3} />
          </span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {found.creds === null && <span className="wl-shimmer h-8 w-60 rounded-full" />}
        {shown.map((c, k) => (
          <span key={c.path} className="wl-pop flex h-8 items-center gap-2 rounded-full bg-[color-mix(in_srgb,var(--fg)_5%,transparent)] pr-3 pl-2.5 text-[12px] text-fg" style={delay(500 + k * 90)}>
            {isBrand(c.icon) ? <BrandIcon name={c.icon} size={13} className="text-fg" /> : <FileText size={12} className="text-subtle" />}
            {c.label}
            <Check size={11} strokeWidth={3} className="text-ok" />
          </span>
        ))}
        {creds.length > shown.length && (
          <span className="wl-pop flex h-8 items-center rounded-full px-3 text-[12px] text-subtle" style={delay(500 + shown.length * 90)}>
            +{creds.length - shown.length} more
          </span>
        )}
        {found.creds !== null && creds.length === 0 && <span className="text-[12.5px] text-subtle">No other logins on this Mac yet. Sign in to gh, gcloud or the like and they'll come along.</span>}
      </div>
    </Frame>
  );
}

// ---------- the scenes ----------

/** A scene's part, on the scene's clock. */
const loop = (name: string, extra?: CSSProperties): CSSProperties => ({ animation: `${name} ${SCENE_MS}ms cubic-bezier(0.4, 0, 0.2, 1) infinite both`, ...extra });

const Stage = ({ children, className }: { children: ReactNode; className?: string }) => <div className={cx(TILE, "relative h-[240px] overflow-hidden", className)}>{children}</div>;

function SceneSessions() {
  const row = (agent: string, title: string, under: ReactNode, strong?: boolean) => (
    <div className={cx("flex items-start gap-2.5 rounded-lg px-2.5 py-2", strong && "bg-[color-mix(in_srgb,var(--fg)_6%,transparent)]")}>
      <span className="mt-px">
        <AgentIcon agent={agent} size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] text-fg">{title}</div>
        <div className="relative mt-[3px] h-[14px] text-[11px]">{under}</div>
      </div>
    </div>
  );
  const working = (
    <span className="flex items-center gap-1.5 text-ok">
      <WorkingMark size={12} /> working
    </span>
  );
  return (
    <Stage className="flex">
      <div className="w-[260px] shrink-0 bg-[color-mix(in_srgb,var(--fg)_3%,transparent)] p-2.5">
        <div className="px-2.5 pt-1 pb-2 text-[10.5px] font-semibold tracking-wide text-subtle uppercase">mini</div>
        {row(
          "claude",
          "Fix the flaky login test",
          <>
            <span className="absolute inset-0" style={loop("wl-swap-a")}>
              {working}
            </span>
            <span className="absolute inset-0 flex items-center gap-1.5 text-warn" style={loop("wl-swap-b")}>
              <span className="size-[5px] rounded-full bg-warn" /> needs you
            </span>
          </>,
          true,
        )}
        {row(
          "codex",
          "Upgrade to React 19",
          <>
            <span className="absolute inset-0" style={loop("wl-done-a")}>
              {working}
            </span>
            <span className="absolute inset-0 flex items-center gap-1.5 text-subtle" style={loop("wl-done-b")}>
              <Check size={11} className="text-ok" /> done · now
            </span>
          </>,
        )}
        {row("grok", "Write the API docs", <span className="text-subtle">api · 12m</span>)}
        {row("mantis", "Profile the dispatcher", <span className="text-subtle">mantis · 1h</span>)}
      </div>
      <div className="relative flex-1">
        {/* the nudge */}
        <div className="absolute top-6 right-6 left-6 rounded-2xl bg-raised p-3 shadow-[0_0_0_1px_var(--line-strong),0_18px_40px_-14px_rgba(0,0,0,0.6)]" style={loop("wl-toast")}>
          <div className="flex items-start gap-3">
            <span className="relative flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-[color-mix(in_srgb,var(--fg)_6%,transparent)]">
              <AgentIcon agent="claude" size={16} />
              <span className="absolute -right-1 -bottom-1 flex size-[15px] items-center justify-center rounded-full bg-warn text-[9px] font-bold text-black ring-2 ring-[var(--raised)]">!</span>
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="flex-1 truncate text-[12.5px] font-medium text-fg">Fix the flaky login test</span>
                <span className="text-[10.5px] text-subtle">mini</span>
              </div>
              <div className="mt-0.5 text-[11.5px] text-warn">Do you want to run npm test?</div>
            </div>
          </div>
        </div>
      </div>
    </Stage>
  );
}

/** A pane drawn small: a few lines of a terminal. */
function MiniPane({ lines, agent }: { lines: [string, string][]; agent?: string }) {
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg bg-[color-mix(in_srgb,var(--fg)_4%,transparent)] p-2.5">
      <div className="mb-2 flex items-center gap-1.5">
        <AgentIcon agent={agent} size={10} />
        <span className="h-[3px] w-10 rounded-full bg-[color-mix(in_srgb,var(--fg)_20%,transparent)]" />
      </div>
      <div className="flex flex-col gap-1 font-mono text-[9.5px] leading-tight whitespace-nowrap">
        {lines.map(([color, text], k) => (
          <span key={k} className="truncate" style={{ color }}>
            {text}
          </span>
        ))}
      </div>
    </div>
  );
}

function ScenePanes() {
  return (
    <Stage className="p-3">
      <div className="flex h-full gap-2">
        <div className="flex min-w-0 flex-1">
          <div className="w-full">
            <MiniPane agent="claude" lines={[["var(--muted)", "› fix the checkout bug"], ["var(--fg)", "● Reading src/cart.ts"], ["var(--green)", "✓ 18 tests pass"], ["var(--muted)", "● Editing src/cart.ts"]]} />
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-2" style={loop("wl-split-right", { flexGrow: 1, flexBasis: 0 })}>
          <div className="min-h-0 flex-1">
            <MiniPane lines={[["var(--accent)", "~/shop main %"], ["var(--fg)", "npm run dev"], ["var(--green)", "ready on :3000"]]} />
          </div>
          <div className="min-h-0" style={loop("wl-split-down", { flexGrow: 1, flexBasis: 0 })}>
            <MiniPane lines={[["var(--accent)", "~/shop main %"], ["var(--fg)", "git status"], ["var(--amber)", "M src/cart.ts"]]} />
          </div>
        </div>
      </div>
      {/* ⌃Tab */}
      <div className="absolute inset-0 flex items-center justify-center bg-[color-mix(in_srgb,var(--bg)_55%,transparent)] backdrop-blur-[2px]" style={loop("wl-switcher")}>
        <div className="flex gap-2.5 rounded-2xl bg-raised p-3 shadow-[0_0_0_1px_var(--line-strong),0_18px_40px_-14px_rgba(0,0,0,0.6)]">
          {(["claude", "codex", "grok"] as const).map((a, k) => (
            <div key={a} className={cx("flex h-[74px] w-[96px] flex-col justify-between rounded-lg p-2", k === 1 ? "bg-active shadow-[0_0_0_1.5px_var(--accent)]" : "bg-[color-mix(in_srgb,var(--fg)_5%,transparent)]")}>
              <AgentIcon agent={a} size={14} />
              <span className="truncate text-[10.5px] text-muted">{["checkout bug", "react 19", "api docs"][k]}</span>
            </div>
          ))}
        </div>
      </div>
    </Stage>
  );
}

function SceneFiles() {
  return (
    <Stage className="flex">
      <div className="flex-1 p-5 font-mono text-[11.5px] leading-[1.9]">
        <div className="text-muted">› make a hero image and a one-page report</div>
        <div className="text-fg">● Generating the image…</div>
        <div className="text-fg">
          <span className="text-ok">✓</span> Wrote{" "}
          <span className="underline decoration-1 underline-offset-[3px]" style={loop("wl-underline", { color: "var(--accent)" })}>
            public/hero.png
          </span>
        </div>
        <div className="text-fg">
          <span className="text-ok">✓</span> Wrote <span className="text-fg">docs/report.pdf</span>
        </div>
        <div className="text-muted">› </div>
      </div>
      {/* the pointer */}
      <svg width="16" height="20" viewBox="0 0 16 20" className="absolute top-5 left-5 drop-shadow" style={loop("wl-pointer-files")}>
        <path d="M1 1v15l4-3.5 2.6 6 2.4-1-2.6-6H13z" fill="white" stroke="black" strokeWidth="1" strokeLinejoin="round" />
      </svg>
      {/* what opens */}
      <div className="absolute top-5 right-5 bottom-5 w-[210px] overflow-hidden rounded-xl bg-raised shadow-[0_0_0_1px_var(--line-strong),0_18px_40px_-14px_rgba(0,0,0,0.6)]" style={loop("wl-preview")}>
        <div className="h-[150px] bg-[radial-gradient(120%_90%_at_30%_100%,#f6a15c_0%,#e2557a_38%,#5b3fb5_70%,#1d1b4b_100%)]">
          <div className="flex h-full items-end justify-center pb-6">
            <span className="size-10 rounded-full bg-[#ffd27a] shadow-[0_0_40px_10px_rgba(255,210,122,0.45)]" />
          </div>
        </div>
        <div className="px-3 py-2.5">
          <div className="text-[12px] font-medium text-fg">hero.png</div>
          <div className="text-[11px] text-subtle">mini · 1.2 MB · just now</div>
        </div>
      </div>
    </Stage>
  );
}

function SceneMove() {
  const device = (name: string, side: "from" | "to") => (
    <div className="flex w-[200px] flex-col gap-3 rounded-xl bg-[color-mix(in_srgb,var(--fg)_4%,transparent)] p-3.5">
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-fg">
        <BrandIcon name="apple" size={13} />
        {name}
      </div>
      <div className="flex items-center gap-2 text-[11.5px] text-muted" style={side === "to" ? loop("wl-arrive") : undefined}>
        <Folder size={13} /> ~/code/api
      </div>
      <div className="h-[18px] font-mono text-[10.5px]">
        {side === "to" ? (
          <span className="flex items-center gap-1.5">
            <span className="text-subtle">%</span>
            <span className="inline-block overflow-hidden whitespace-nowrap text-fg" style={loop("wl-type", { "--w": "15ch" } as CSSProperties)}>
              claude --resume
            </span>
            <span className="flex size-4 items-center justify-center rounded-full bg-ok text-black" style={loop("wl-late")}>
              <Check size={10} strokeWidth={3} />
            </span>
          </span>
        ) : (
          <span className="text-subtle">conversation · 2h</span>
        )}
      </div>
    </div>
  );
  return (
    <Stage className="flex items-center justify-between px-8">
      {device("This Mac", "from")}
      {device("mini", "to")}
      {/* the way across */}
      <div className="absolute top-1/2 right-[248px] left-[248px] h-[2px] -translate-y-1/2 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--fg)_9%,transparent)]">
        <div className="h-full rounded-full bg-accent" style={loop("wl-fill")} />
      </div>
      <div className="absolute top-1/2 -mt-4 flex h-8 items-center gap-1.5 rounded-full bg-raised px-3 text-[11.5px] text-fg shadow-[0_0_0_1px_var(--line-strong),0_10px_24px_-10px_rgba(0,0,0,0.6)]" style={loop("wl-travel")}>
        <Folder size={12} className="text-accent" /> api
        <BrandIcon name="claude" size={11} />
      </div>
    </Stage>
  );
}

function SceneScreen() {
  return (
    <Stage className="flex items-center justify-center">
      <div className="relative">
        <div className="relative h-[178px] w-[300px] overflow-hidden rounded-[10px] bg-[linear-gradient(160deg,color-mix(in_srgb,var(--accent)_55%,#1a1030),#0d0b1a)] shadow-[0_0_0_5px_#111,0_0_0_6px_var(--line-strong),0_24px_50px_-18px_rgba(0,0,0,0.8)]">
          <div className="flex h-3.5 items-center gap-2 bg-black/30 px-2">
            <BrandIcon name="apple" size={7} className="text-white/80" />
            <span className="h-[3px] w-6 rounded-full bg-white/40" />
            <span className="h-[3px] w-5 rounded-full bg-white/30" />
          </div>
          <div className="absolute top-8 left-6 h-[86px] w-[120px] rounded-md bg-white/12 shadow-lg backdrop-blur" />
          <div className="absolute top-11 left-24 h-[96px] w-[150px] rounded-md bg-[color-mix(in_srgb,var(--bg)_92%,white)] shadow-xl" style={loop("wl-window")}>
            <div className="flex gap-1 p-1.5">
              <span className="size-1.5 rounded-full bg-[#ff5f57]" />
              <span className="size-1.5 rounded-full bg-[#febc2e]" />
              <span className="size-1.5 rounded-full bg-[#28c840]" />
            </div>
            <div className="flex flex-col gap-1 px-2 font-mono text-[7px] leading-none">
              <span className="text-subtle">~/creed %</span>
              <span className="text-ok">✓ build done</span>
            </div>
          </div>
          <div className="absolute inset-x-0 bottom-1.5 flex justify-center">
            <div className="flex gap-1 rounded-md bg-white/15 px-1.5 py-1">
              {["#5ac8fa", "#ff9f0a", "#30d158", "#bf5af2", "#ff375f"].map((c) => (
                <span key={c} className="size-2.5 rounded-[3px]" style={{ background: c }} />
              ))}
            </div>
          </div>
          <svg width="11" height="14" viewBox="0 0 16 20" className="absolute top-0 left-0" style={loop("wl-pointer-screen")}>
            <path d="M1 1v15l4-3.5 2.6 6 2.4-1-2.6-6H13z" fill="white" stroke="black" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="mx-auto h-4 w-16 bg-[linear-gradient(#1a1a1a,#0c0c0c)]" />
        <div className="mx-auto h-1.5 w-28 rounded-full bg-[#1a1a1a]" />
      </div>
    </Stage>
  );
}

// ---------- your look ----------

function Look() {
  const theme = useStore((s) => s.theme);
  const skins = useStore((s) => s.skins);
  const info = useStore((s) => s.info);
  const showing = theme === "system" ? (isDark() ? "dark" : "light") : theme;
  const dark = showing === "dark";
  const pickIcon = (id: string) => {
    if (!info || id === info.appIcon) return;
    const was = info.appIcon;
    setState({ info: { ...info, appIcon: id } });
    api.setAppIcon(id).catch((e) => {
      setState((s) => (s.info ? { info: { ...s.info, appIcon: was } } : {}));
      toast("error", "Couldn't change the icon", errText(e));
    });
  };
  return (
    <Frame cmd="lungo --theme" title="Make it yours" body="A theme recolours everything, terminals included. The icon changes in the Dock as you pick it.">
      <div className="mb-3 flex items-center gap-1.5">
        {(["system", "dark", "light"] as Theme[]).map((t) => (
          <button
            key={t}
            onClick={() => setTheme(t)}
            className={cx(
              "h-8 rounded-full border px-3.5 text-[12px] capitalize transition-colors",
              theme === t ? "border-transparent bg-fg text-bg" : "border-line text-muted hover:border-line-strong hover:text-fg",
            )}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-5 gap-x-3 gap-y-3">
        {THEMES.filter((t) => t.dark === dark).map((t) => (
          <ThemeTile key={t.id} theme={t} chosen={(dark ? skins.dark : skins.light) === t.id} onPick={() => pickSkin(t.id)} />
        ))}
      </div>
      {info && info.platform !== "windows" && (
        <div className="mt-6 flex flex-wrap gap-3">
          {APP_ICONS.map((i) => {
            const chosen = info.appIcon === i.id;
            return (
              <button key={i.id} onClick={() => pickIcon(i.id)} title={i.name} className="group">
                <span
                  className={cx(
                    "relative block size-[46px] overflow-hidden rounded-[10.4px] transition-[box-shadow,transform] duration-150 group-hover:-translate-y-0.5",
                    chosen ? "shadow-[0_0_0_2px_var(--bg),0_0_0_4px_var(--accent)]" : "group-hover:shadow-[0_0_0_2px_var(--bg),0_0_0_3px_var(--line-strong)]",
                  )}
                >
                  <img src={i.src} alt="" draggable={false} className="absolute -top-[6px] -left-[6px] h-[58px] w-[58px] max-w-none" />
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Frame>
  );
}

// ---------- go ----------

function Go({ found }: { found: Found }) {
  const machines = useStore((s) => s.machines);
  const theme = useStore((s) => s.theme);
  const skins = useStore((s) => s.skins);
  const info = useStore((s) => s.info);
  const [burst, setBurst] = useState(false);
  const installed = useMemo(() => AGENTS.filter((a) => found.agents?.some((x) => x.id === a)), [found.agents]);
  const up = machines.filter((m) => m.machine.status === "running" || !m.machine.status).map((m) => m.machine.name);
  const places = [LOCAL, ...up];
  const [where, setWhere] = useState(LOCAL);
  const dark = theme === "system" ? isDark() : theme === "dark";
  const themeName = THEMES.find((t) => t.id === (dark ? skins.dark : skins.light))?.name ?? "";
  const iconName = APP_ICONS.find((i) => i.id === info?.appIcon)?.name ?? "Redeye";
  const lines = [
    installed.length ? `${installed.length} agent${installed.length === 1 ? "" : "s"} ready: ${installed.map((a) => AGENT_NAMES[a]).join(", ")}` : "No agents yet: install one and it shows up",
    machines.length ? `This Mac and ${machines.length} machine${machines.length === 1 ? "" : "s"}` : "This Mac, with room for more machines",
    found.claude?.signedIn ? "Your logins follow you to every machine" : "Sign Claude Code in, and it follows you to your machines",
    `${themeName} theme, ${iconName} icon`,
  ];
  const start = (a: string) => {
    setBurst(true);
    window.setTimeout(() => {
      finishWelcome();
      setState({ view: "sessions" });
      openAgentTab(where, a);
    }, 620);
  };
  return (
    <Frame cmd="ready" title="You're set" body="⌘K finds anything: a session, a machine, a command. Help ▸ Welcome to Lungo brings this back.">
      <div className="flex flex-col gap-2.5">
        {lines.map((l, k) => (
          <div key={k} className="wl-rise flex items-center gap-3 text-[13.5px] text-fg" style={delay(380 + k * 170)}>
            <span className="wl-pop flex size-5 items-center justify-center rounded-full bg-ok text-black" style={delay(460 + k * 170)}>
              <Check size={11} strokeWidth={3} />
            </span>
            {l}
          </div>
        ))}
      </div>
      {installed.length > 0 && (
        <div className="wl-rise mt-9" style={delay(1150)}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-[12px] text-subtle">Start your first session on</span>
            {places.map((p) => (
              <button
                key={p}
                onClick={() => setWhere(p)}
                className={cx(
                  "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition-colors",
                  where === p ? "border-transparent bg-fg text-bg" : "border-line text-muted hover:border-line-strong hover:text-fg",
                )}
              >
                <PlaceIcon name={p} size={11} />
                {p === LOCAL ? "This Mac" : p}
              </button>
            ))}
          </div>
          <div className="relative flex flex-wrap gap-2">
            {installed.map((a) => (
              <button
                key={a}
                onClick={() => start(a)}
                className={cx(TILE, "flex h-12 items-center gap-2.5 px-4 text-[13px] font-medium text-fg transition-[background,transform] hover:-translate-y-0.5 hover:bg-[color-mix(in_srgb,var(--fg)_9%,transparent)]")}
              >
                <AgentIcon agent={a} size={18} />
                {AGENT_NAMES[a]}
              </button>
            ))}
            {burst && (
              <span className="wl-burst pointer-events-none absolute top-1/2 left-1/2">
                {Array.from({ length: 16 }, (_, k) => (
                  <i key={k} style={{ "--a": `${k * 22.5}deg`, background: ["var(--accent)", "var(--green)", "#d97757", "var(--amber)"][k % 4], animationDelay: `${(k % 3) * 40}ms` } as CSSProperties} />
                ))}
              </span>
            )}
          </div>
        </div>
      )}
    </Frame>
  );
}
