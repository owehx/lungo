import { memo, useEffect, useRef, useState } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SerializeAddon } from "@xterm/addon-serialize";
import { RotateCcw, Unplug, X } from "lucide-react";
import { api, errText, type Session } from "../lib/api";
import {
  LOCAL,
  PANE_FOOTER,
  activeSkin,
  closeTab,
  dropTab,
  getState,
  groupOf,
  machineLabel,
  paneAttached,
  persistent,
  reattachTab,
  retryNow,
  sessionFor,
  sessionSeen,
  termFontSize,
  termLineHeight,
  uiScale,
  updateTab,
  useStore,
  type Tab,
} from "../lib/store";
import { geometry, leaves } from "../lib/panes";
import { Button, Spinner } from "./ui";
import { cx, isMac } from "../lib/util";
import { senders, terminals } from "../lib/terminals";
import { showMenu, type MenuRow } from "./ContextMenu";
import { KNOWN_EXTENSIONS, filesOf, peekByName } from "../lib/peek";
import { arrived, holdsOff, useMoving } from "../lib/move";
import { MoveOverlay } from "./MoveButton";
import { clientId, firstName, joinOf, linkPresence, presenceOf, presenceURL, usePresence, useShareOf } from "../lib/collab";
import { PresenceLayer } from "./Presence";

function currentTheme(): ITheme {
  return activeSkin().term;
}

const enc = new TextEncoder();
const fontsReady = (async () => {
  try {
    await Promise.all([
      document.fonts.load('13px "JetBrains Mono"'),
      document.fonts.load('bold 13px "JetBrains Mono"'),
      document.fonts.load('italic 13px "JetBrains Mono"'),
    ]);
  } catch {
    /* fall back to system mono */
  }
})();

// Panes in background tabs connect too, right after the ones on screen and a moment apart,
// so every session is live (and shows in the switcher) without waiting to be looked at.
const eagerQueue: (() => void)[] = [];
let eagerTimer: number | undefined;
function eagerly(fn: () => void) {
  eagerQueue.push(fn);
  eagerTimer ??= window.setTimeout(runEager, 120);
}
function runEager() {
  eagerQueue.shift()?.();
  eagerTimer = eagerQueue.length ? window.setTimeout(runEager, 60) : undefined;
}

// The GPU renderer is kept for the panes shown most recently, so going back to one draws it at
// once instead of building a renderer again (and drawing without one meanwhile). Browsers allow
// about sixteen WebGL contexts in all; eight are kept.
const GPU_KEEP = 8;
const gpuRecent: string[] = []; // pane keys, the most recently shown first
const gpuDrop = new Map<string, () => void>(); // pane key → let its renderer go
function gpuUsed(key: string, drop: () => void) {
  gpuDrop.set(key, drop);
  const i = gpuRecent.indexOf(key);
  if (i >= 0) gpuRecent.splice(i, 1);
  gpuRecent.unshift(key);
  for (const old of gpuRecent.splice(GPU_KEEP)) gpuDrop.get(old)?.();
}
function gpuGone(key: string) {
  gpuDrop.delete(key);
  const i = gpuRecent.indexOf(key);
  if (i >= 0) gpuRecent.splice(i, 1);
}

// WebKit kills a window's GPU process when it hangs. Every WebGL context is lost and comes
// back, but the canvases holding the glyphs all panes share come back empty while xterm still
// counts those glyphs as drawn: panes go blank but for a few stray letters. So a lost context
// lets go of every pane's renderer (the glyphs go with the last) and builds them again for
// the panes on screen. A GPU that keeps failing leaves the window on the plain renderer.
const gpuAgain = new Map<string, () => void>(); // pane key → build its renderer again if on screen
let gpuOff = false;
let gpuResets: number[] = [];
let gpuResetTimer: number | undefined;
function gpuLost() {
  window.clearTimeout(gpuResetTimer);
  gpuResetTimer = window.setTimeout(() => {
    const now = Date.now();
    gpuResets = [...gpuResets.filter((at) => now - at < 60_000), now];
    gpuOff = gpuResets.length > 3;
    for (const drop of [...gpuDrop.values()]) drop();
    if (!gpuOff) for (const again of gpuAgain.values()) again();
  }, 500);
}

/** Runs fn when the page has nothing else to do (soon in any case). */
function whenIdle(fn: () => void) {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 2000 });
  else window.setTimeout(fn, 50);
}

// The last screen of every session pane is kept, so when the app opens again each pane shows
// what it showed at once, and the live screen replaces it a moment later as tmux attaches.
const SNAP = "sky.snap.";
const snapKey = (t: Tab) => (persistent(t) ? `${SNAP}${t.kind === "local" ? LOCAL : t.machine}/${t.session}` : "");
interface Snap {
  data: string;
  at: number;
}
function readSnap(t: Tab): Snap | null {
  const k = snapKey(t);
  if (!k) return null;
  try {
    const v = JSON.parse(localStorage.getItem(k) ?? "null") as Snap | null;
    return v && Date.now() - v.at < 3 * 86400_000 ? v : null;
  } catch {
    return null;
  }
}
function writeSnap(t: Tab, data: string) {
  const k = snapKey(t);
  if (!k) return;
  try {
    localStorage.setItem(k, JSON.stringify({ data, at: Date.now() }));
  } catch {
    // Storage is full: the oldest screens go first.
    try {
      const old = Object.keys(localStorage)
        .filter((x) => x.startsWith(SNAP))
        .map((x) => [x, (JSON.parse(localStorage.getItem(x) ?? "{}") as Snap).at ?? 0] as const)
        .sort((a, b) => a[1] - b[1]);
      for (const [x] of old.slice(0, Math.max(1, old.length >> 1))) localStorage.removeItem(x);
    } catch {
      /* give up: this screen just isn't kept */
    }
  }
}

// tmux switches to the alternate screen when it attaches: from there on the stream is the session.
const ALT_SCREEN = [0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68]; // ESC [ ? 1 0 4 9 h
function indexOfSeq(hay: Uint8Array, seq: number[]): number {
  outer: for (let i = hay.indexOf(seq[0]); i >= 0 && i <= hay.length - seq.length; i = hay.indexOf(seq[0], i + 1)) {
    for (let j = 1; j < seq.length; j++) if (hay[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}
function joinBytes(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
/** Printed text without the escape sequences around it. */
const plainText = (s: string) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78]/g, "")
    .replace(/\r/g, "");
const lastLine = (s: string) => plainText(s).split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
/** Why a pane can't attach, short enough for a status line. */
const shortWhy = (why?: string) => (why ?? "").replace(/^ssh: /, "").replace(/; (start|remove) it with.*$/, "").trim();

// Sky's key for leaving tmux's scrollback (see bootstrap.TmuxManaged): sent before typing
// into a pane the wheel took back into its history, so the typing reaches the program.
const LEAVE_SCROLLBACK = "\x1b[9001~";

// What the terminal answers by itself when tmux asks what it is (its type, its colours, where
// the cursor is) and focus changes: not typing. Prefixed with a key, tmux takes the answer for
// keys typed into the session.
const REPORT = /^(\x1b(\[[?>]?[0-9;]*[cRnt]|\][^\x07\x1b]*(\x07|\x1b\\)|P[^\x1b]*\x1b\\|\[[IO]))+$/;

/**
 * How a session pane takes input, from the session list: "m" the program wants the mouse
 * (Claude's fullscreen view, vim), "a" it uses the whole screen, "k" its tmux knows
 * LEAVE_SCROLLBACK. Empty for a pane that isn't a session.
 */
function inputFlags(tab: Tab, sessions: Session[]): string {
  const s = persistent(tab) ? sessionFor(tab, sessions) : undefined;
  return s ? (s.mouse ? "m" : "") + (s.alt ? "a" : "") + (s.scrollKey ? "k" : "") : "";
}

/**
 * The Mac editing keys every Mac terminal gives a command line, as the bytes shells and
 * Claude Code read: ⌘←/⌘→ line start/end, ⌥←/⌥→ a word back/forward (xterm's own
 * ESC[1;3D types ";3D" into zsh), ⌘⌫ delete to line start, ⌘⌦ to line end, ⌥⌦ the next
 * word, ⌘Z undo. Home/End do line start/end at a command line too (tmux turns them into
 * codes zsh doesn't know); full-screen programs get the keys as they are.
 */
function macEditKey(e: KeyboardEvent, fullScreen: boolean): string | null {
  if (e.ctrlKey || e.shiftKey) return null;
  if (e.metaKey && !e.altKey) {
    switch (e.key) {
      case "ArrowLeft":
        return "\x01";
      case "ArrowRight":
        return "\x05";
      case "Backspace":
        return "\x15";
      case "Delete":
        return "\x0b";
    }
    return e.code === "KeyZ" ? "\x1f" : null;
  }
  if (e.altKey && !e.metaKey) {
    switch (e.key) {
      case "ArrowLeft":
        return "\x1bb";
      case "ArrowRight":
        return "\x1bf";
      case "Delete":
        return "\x1bd";
    }
    return null;
  }
  if (!e.metaKey && !e.altKey && !fullScreen) {
    if (e.key === "Home") return "\x01";
    if (e.key === "End") return "\x05";
  }
  return null;
}

// File names in what a session prints: ⌘-click shows the file on this computer, wherever the
// session runs (see lib/peek). A name counts when it is a path (~/a/b, ./a, /tmp/a, src/a.ts)
// or a bare name with an ending files have (Creed-promo.mp4, README.md).
const FILE_RUN = /[A-Za-z0-9_@%+\-./~]+/g;
function fileTokens(line: string): { start: number; end: number; name: string }[] {
  const out: { start: number; end: number; name: string }[] = [];
  for (const m of line.matchAll(FILE_RUN)) {
    const name = m[0].replace(/[./]+$/, ""); // the full stop that ends a sentence isn't the name's
    if (name.length < 3 || name.startsWith("//") || name.includes("//") || line[m.index - 1] === ":") continue; // a web address
    const last = name.slice(name.lastIndexOf("/") + 1);
    const ext = last.includes(".") ? last.slice(last.lastIndexOf(".") + 1).toLowerCase() : "";
    const known = ext !== "" && KNOWN_EXTENSIONS.has(ext) && last.length > ext.length + 1;
    const path =
      name.startsWith("~/") || name.startsWith("./") || name.startsWith("../")
        ? /[A-Za-z0-9]/.test(name)
        : name.startsWith("/")
          ? name.split("/").filter(Boolean).length >= 2
          : name.includes("/") && known;
    if (path || (!name.includes("/") && known)) out.push({ start: m.index, end: m.index + name.length, name });
  }
  return out;
}

// Whether ⌘ is down: file names show as links only then, as in an editor.
let metaHeld = false;
const hoveredLinks = new Set<{ decorations?: { underline: boolean; pointerCursor: boolean } }>();
function setMeta(on: boolean) {
  if (metaHeld === on) return;
  metaHeld = on;
  for (const l of hoveredLinks) if (l.decorations) l.decorations.underline = l.decorations.pointerCursor = on;
}
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => setMeta(e.metaKey), true);
  window.addEventListener("keyup", (e) => setMeta(e.metaKey), true);
  window.addEventListener("mousemove", (e) => setMeta(e.metaKey), true);
  window.addEventListener("blur", () => setMeta(false));
}

const devSizes = (key: string) => (((window as unknown as { __skySizes?: Record<string, string[]> }).__skySizes ??= {})[key] ??= []);
const devTerms = () => ((window as unknown as { __skyTerms?: Record<string, XTerm> }).__skyTerms ??= {});

/**
 * One terminal pane. The xterm instance and its backend PTY live as long as the pane does.
 * active: the pane is on screen; focused: it has the keyboard.
 */
export const TerminalView = memo(function TerminalView({ tab, active, focused }: { tab: Tab; active: boolean; focused: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const serializer = useRef<SerializeAddon | null>(null);
  const gl = useRef<WebglAddon | null>(null);
  const lost = useRef(0); // GPU renderers this pane lost, to give up after a few
  const dirty = useRef(false); // the screen changed since it was last kept
  const showView = useRef<() => void>(() => {}); // lays the terminal out in its pane, once
  const ws = useRef<WebSocket | null>(null);
  const opening = useRef(false);
  const everConnected = useRef(false);
  const [seen, setSeen] = useState(false); // the pane has shown its session at least once
  const seenRef = useRef(false);
  seenRef.current = seen;
  // A connection that comes back within a moment needs no notice: the "Reconnecting" note
  // and the dimming wait a little.
  const [late, setLate] = useState(false);
  const fitTimer = useRef<number | undefined>(undefined);
  const sizeTimer = useRef<number | undefined>(undefined);
  const sentSize = useRef(""); // the size the backend was last told
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const ownInput = useStore((s) => inputFlags(tab, s.sessions.sessions));
  // A joined pane's session is in the other computer's list: its share says how it takes input.
  const joinedInput = usePresence(tab.key, (s) => (s.info ? (s.info.mouse ? "m" : "") + (s.info.alt ? "a" : "") + (s.info.scrollKey ? "k" : "") : ""));
  const input = tab.kind === "joined" ? (joinedInput ?? "") : ownInput;
  const inputRef = useRef(input);
  inputRef.current = input;
  // How far the wheel took the pane into tmux's scrollback (0: at the live screen). Anything
  // typed while it is back there leaves the scrollback first.
  const back = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const zoom = useStore((s) => s.zoom);
  // Shared: the pane's session is shared with people (share), or is someone else's session
  // (joined). A joined pane is drawn at the session's own size (sharedSize), whatever the
  // pane's, so everyone sees the same screen and points at the same cells.
  const joined = tab.kind === "joined";
  const share = useShareOf(tab);
  const sharedSize = usePresence(tab.key, (s) => s.size);
  const joinSize = useRef<{ cols: number; rows: number } | undefined>(undefined); // the session's size when it was joined
  const settling = useRef(0); // a joined pane's font is being fitted
  const sharedRef = useRef(sharedSize);
  sharedRef.current = sharedSize ?? joinSize.current;
  const viewOnly = usePresence(tab.key, (s) => s.role === "view") ?? false;

  // Create xterm once.
  useEffect(() => {
    const t = new XTerm({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize: termFontSize(zoom),
      lineHeight: termLineHeight(getState().term),
      fontWeight: "400",
      fontWeightBold: "600",
      cursorBlink: getState().term.blink,
      cursorStyle: getState().term.cursor,
      cursorInactiveStyle: "outline",
      allowProposedApi: true,
      // A session pane draws tmux's screen, and tmux keeps the history; a plain shell keeps
      // its own.
      scrollback: persistent(tab) || tab.kind === "joined" ? 2000 : 20000,
      // The room kept on the right for xterm's scrollbar. A session in tmux scrolls inside
      // tmux and never shows one, so it gets the full width.
      overviewRuler: { width: persistent(tab) || tab.kind === "joined" ? 1 : 8 },
      macOptionClickForcesSelection: true,
      // A right-click opens the menu; selecting (and so copying) the word under it would
      // replace what is on the clipboard just before Paste.
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: false,
      smoothScrollDuration: 0,
      theme: currentTheme(),
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.loadAddon(new WebLinksAddon((_e, uri) => void api.openURL(uri).catch(() => {})));
    const u = new Unicode11Addon();
    t.loadAddon(u);
    t.unicode.activeVersion = "11";
    const ser = new SerializeAddon();
    t.loadAddon(ser);
    serializer.current = ser;

    // Shift+Enter (and Option+Enter) send ESC CR, which Claude Code reads as a newline.
    // The Mac editing keys do what they do in any Mac terminal (see macEditKey). ⌘A selects
    // the terminal's text. Other ⌘-shortcuts and the ⌃Tab / ⌥Tab switcher belong to the app.
    t.attachCustomKeyEventHandler((e) => {
      const edit = isMac ? macEditKey(e, inputRef.current.includes("a")) : null;
      if (edit !== null) {
        if (e.type === "keydown") {
          e.preventDefault();
          typed(edit);
        }
        return false;
      }
      if (e.type === "keydown" && e.key === "Enter" && (e.shiftKey || e.altKey) && !e.metaKey && !e.ctrlKey) {
        typed("\x1b\r");
        return false;
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyA") {
        if (e.type === "keydown") {
          e.preventDefault();
          t.selectAll();
        }
        return false;
      }
      if (e.metaKey && !e.ctrlKey) return false;
      if (e.key === "Tab" && (e.ctrlKey || e.altKey)) return false;
      return true;
    });
    t.onData((d) => typed(d));
    t.onBinary((d) => {
      const b = new Uint8Array(d.length);
      for (let i = 0; i < d.length; i++) b[i] = d.charCodeAt(i) & 0xff;
      if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(b);
    });
    // Programs name their terminal (Claude Code sets its task name); show that on the pane.
    // Claude puts a status glyph in front and animates it while it works: dropped, so the
    // name only changes when the task does.
    t.onTitleChange((title) => {
      const clean = title
        .replace(/[\u0000-\u001f]/g, "")
        .replace(/^[\u2800-\u28ff✳✻✽✶✢·*]\s+/u, "")
        .trim();
      if (clean !== (tabRef.current.termTitle ?? "")) updateTab(tabRef.current.key, { termTitle: clean });
    });
    // Copying inside tmux (a drag in a session, a yank in vim) reaches the clipboard: tmux and
    // programs send the text with OSC 52. Setting only; nothing gets to read the clipboard.
    // The same copy can arrive more than once (Claude sends it plainly and through tmux).
    let lastCopy = { text: "", at: 0 };
    t.parser.registerOscHandler(52, (data) => {
      const b64 = data.slice(data.indexOf(";") + 1);
      if (!b64 || b64 === "?" || b64.length > 4_000_000) return true;
      try {
        const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        if (text && (text !== lastCopy.text || Date.now() - lastCopy.at > 1000)) api.copy(text).catch(() => {});
        lastCopy = { text, at: Date.now() };
      } catch {
        /* not base64 */
      }
      return true;
    });
    // A program on the machine asks for a file to be shown here (the `peek` command sends
    // the file's path this way, through tmux).
    t.parser.registerOscHandler(7338, (data) => {
      try {
        const path = new TextDecoder().decode(Uint8Array.from(atob(data.trim()), (c) => c.charCodeAt(0)));
        const at = filesOf(tabRef.current);
        if (path.startsWith("/") && at.machine) void peekByName(at.machine, at.session, at.dir, path);
      } catch {
        /* not a path */
      }
      return true;
    });
    // File names in the output are links while ⌘ is held: a click shows the file here.
    t.registerLinkProvider({
      provideLinks(y, callback) {
        const at = filesOf(tabRef.current);
        const line = t.buffer.active.getLine(y - 1);
        if (!line || !at.machine) return callback(undefined);
        // The line's text, and for each character the cell it is in (wide ones take two).
        let text = "";
        const cells: number[] = [];
        for (let x = 0; x < t.cols; x++) {
          const cell = line.getCell(x);
          if (!cell || cell.getWidth() === 0) continue;
          const ch = cell.getChars() || " ";
          for (let i = 0; i < ch.length; i++) cells.push(x);
          text += ch;
        }
        const links = fileTokens(text).map(({ start, end, name }) => {
          const link = {
            range: { start: { x: cells[start] + 1, y }, end: { x: cells[end - 1] + 1, y } },
            text: name,
            decorations: { underline: metaHeld, pointerCursor: metaHeld },
            activate: (e: MouseEvent) => {
              if (!e.metaKey) return;
              const now = filesOf(tabRef.current);
              void peekByName(now.machine, now.session, now.dir, name);
            },
            hover: () => void hoveredLinks.add(link),
            leave: () => void hoveredLinks.delete(link),
          };
          return link;
        });
        callback(links.length ? links : undefined);
      },
    });
    let copyTimer: number | undefined;
    t.onSelectionChange(() => {
      // The people in a shared session see what you select, in your colour.
      const p = presenceOf(tabRef.current.key);
      if (p) {
        const pos = t.getSelectionPosition();
        const top = t.buffer.active.viewportY;
        p.select(pos && t.hasSelection() ? { a: [pos.start.x, pos.start.y - top], b: [pos.end.x, pos.end.y - top] } : null);
      }
      window.clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => {
        const s = t.getSelection();
        if (s) api.copy(s).catch(() => {});
      }, 250);
    });
    // ⌘C with nothing selected in xterm leaves the clipboard alone (what Claude copied stays).
    const keepClipboard = (e: ClipboardEvent) => {
      if (!t.hasSelection()) e.stopImmediatePropagation();
    };
    host.current?.addEventListener("copy", keepClipboard, true);

    term.current = t;
    fit.current = f;
    terminals.set(tab.key, t);
    senders.set(tab.key, typed);
    gpuAgain.set(tab.key, () => activeRef.current && setGPU(true));
    // The context-lost event doesn't bubble; it is caught on its way down to the canvas.
    host.current?.addEventListener("webglcontextlost", gpuLost, true);
    if (import.meta.env.DEV) devTerms()[tab.key] = t; // lets dev checks read what a pane shows

    // The mouse in a session pane. tmux asks for every click, so left alone xterm would hand
    // them all to tmux: a drag became tmux's selection, gone on release, and a right-click
    // opened tmux's own menu (with Kill in it). Here the app selects text itself and right-
    // click opens the app's menu, as in any Mac terminal, unless the program in the session
    // wants the mouse (Claude's fullscreen view selects and copies by itself, vim, htop). ⌥
    // swaps the two. (xterm makes its selection handler when it opens.)
    const takeMouse = () => {
      const selection = (t as unknown as { _core?: { _selectionService?: { shouldForceSelection?: (e: MouseEvent) => boolean } } })._core?._selectionService;
      if (!selection?.shouldForceSelection) return;
      const xtermOwn = selection.shouldForceSelection.bind(selection);
      selection.shouldForceSelection = (e: MouseEvent) => {
        if (!persistent(tabRef.current) && tabRef.current.kind !== "joined") return xtermOwn(e);
        if (e.button === 2 || e.metaKey) return true; // ⌘-click is the app's: it opens a file name
        return inputRef.current.includes("m") ? e.altKey : !e.altKey;
      };
    };
    let disposed = false;
    let laidOut = false;
    // The terminal laid out in its pane, with what this session showed last time until the
    // live screen arrives (unless that has come already).
    const show = () => {
      if (laidOut || disposed || !host.current) return;
      laidOut = true;
      t.open(host.current);
      takeMouse();
      const snap = !tabRef.current.url && !dirty.current && readSnap(tabRef.current);
      if (snap) {
        t.write(snap.data);
        setSeen(true);
      }
    };
    showView.current = show;
    fontsReady.then(() => {
      if (disposed || !host.current) return;
      if (!activeRef.current) {
        // A pane in a background tab: laid out in its turn, so the tab on screen comes first,
        // then connected in its turn, at the size it will have.
        eagerly(show);
        eagerly(() => {
          if (disposed || activeRef.current || tabRef.current.termId || tabRef.current.error || opening.current) return;
          const size = tabRef.current.kind === "joined" ? sharedRef.current : hiddenSize();
          try {
            if (size) t.resize(size.cols, size.rows);
          } catch {
            /* it is fitted when shown */
          }
          openBackend();
        });
        return;
      }
      show();
      setGPU(true);
      safeFit();
      openBackend();
    });

    // A new theme: new colours, and the GPU renderer's glyph cache was drawn in the old ones.
    const obs = new MutationObserver(() => {
      t.options.theme = currentTheme();
      if (t.element && (activeRef.current || gl.current)) {
        t.clearTextureAtlas();
        if (activeRef.current) t.refresh(0, t.rows - 1);
      }
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-skin"] });

    // Scrolling inside tmux and other full-screen programs. They ask for mouse reports, and
    // xterm sends one wheel report per wheel event however far the gesture went, so a fast
    // flick and its momentum crawl. Here every line of travel is one report: a notch moves a
    // line, a flick moves many and eases out as the trackpad does. Without mouse reporting
    // (a plain shell) xterm scrolls its own scrollback, and Shift keeps xterm's behaviour.
    let travel = 0; // pixels scrolled that haven't made a whole line yet
    t.attachCustomWheelEventHandler((e) => {
      const screen = t.element?.querySelector<HTMLElement>(".xterm-screen");
      const mouse = (t as unknown as { _core?: { coreMouseService?: { activeEncoding?: string } } })._core?.coreMouseService;
      if (e.shiftKey || t.modes.mouseTrackingMode === "none" || mouse?.activeEncoding !== "SGR" || !screen) return true;
      const box = screen.getBoundingClientRect();
      const cell = box.height / t.rows;
      if (!e.deltaY || !(cell > 0)) return false;
      const px = e.deltaMode === 1 ? e.deltaY * cell : e.deltaMode === 2 ? e.deltaY * cell * t.rows : e.deltaY;
      if (Math.sign(px) !== Math.sign(travel)) travel = 0; // turning round starts afresh
      travel += px;
      const lines = Math.trunc(travel / cell);
      e.preventDefault();
      if (lines === 0) return false;
      travel -= lines * cell;
      // A program without the mouse is scrolled by tmux, in its history (see `back`).
      if (!inputRef.current.includes("m")) back.current = Math.max(0, back.current - lines);
      const col = Math.min(t.cols, Math.max(1, Math.floor((e.clientX - box.left) / (box.width / t.cols)) + 1));
      const row = Math.min(t.rows, Math.max(1, Math.floor((e.clientY - box.top) / cell) + 1));
      send(`\x1b[<${lines < 0 ? 64 : 65};${col};${row}M`.repeat(Math.min(40, Math.abs(lines))));
      return false;
    });

    // Dragging a divider resizes every frame; refit once the size settles so the remote
    // side gets one resize, not a storm of them.
    const ro = new ResizeObserver(() => {
      window.clearTimeout(fitTimer.current);
      fitTimer.current = window.setTimeout(safeFit, 40);
    });
    if (host.current) ro.observe(host.current);

    return () => {
      disposed = true;
      window.clearTimeout(copyTimer);
      gpuGone(tab.key);
      window.clearTimeout(fitTimer.current);
      window.clearTimeout(sizeTimer.current);
      ro.disconnect();
      obs.disconnect();
      host.current?.removeEventListener("copy", keepClipboard, true);
      host.current?.removeEventListener("webglcontextlost", gpuLost, true);
      gpuAgain.delete(tab.key);
      ws.current?.close();
      if (import.meta.env.DEV) delete devTerms()[tab.key];
      terminals.delete(tab.key);
      senders.delete(tab.key);
      t.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function send(d: string) {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(enc.encode(d));
  }

  /** What the keyboard (or a paste) sends: out of tmux's scrollback first, if it's there. */
  function typed(d: string) {
    if (REPORT.test(d)) return send(d);
    const presence = presenceOf(tabRef.current.key);
    // In a shared session someone else may have scrolled the session back (tmux scrolls it for
    // everyone): typing always leaves the scrollback first there.
    const together = tabRef.current.kind === "joined" || !!presence?.crowded();
    if ((back.current > 0 || together) && !d.startsWith("\x1b[<")) {
      back.current = 0;
      if (inputRef.current.includes("k")) d = LEAVE_SCROLLBACK + d;
    }
    // A guest's typing is seen on its way to the session; the person sharing says so.
    if (tabRef.current.kind !== "joined" && !d.startsWith("\x1b[<")) presence?.typed();
    send(d);
  }

  /** Where the pointer is over the screen, in cells and fractions of one (off it: null). */
  function cellAt(e: React.MouseEvent) {
    const t = term.current;
    const screen = t?.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!t || !screen) return null;
    const box = screen.getBoundingClientRect();
    const c = ((e.clientX - box.left) / box.width) * t.cols;
    const r = ((e.clientY - box.top) / box.height) * t.rows;
    return c >= 0 && r >= 0 && c <= t.cols && r <= t.rows ? { c, r } : null;
  }

  /** Where the pointer is, for the others in a shared session. */
  function pointerMoved(e: React.MouseEvent) {
    presenceOf(tabRef.current.key)?.pointer(cellAt(e));
  }

  /** A click, for the others to see land (before xterm, which keeps some to itself). */
  function pointerDown(e: React.MouseEvent) {
    const p = e.button === 0 ? presenceOf(tabRef.current.key) : undefined;
    const at = p && cellAt(e);
    if (at) p.click(at);
  }

  /** The app's menu for a right-click in the terminal. */
  async function terminalMenu(e: React.MouseEvent) {
    const t = term.current;
    if (!t) return;
    e.preventDefault();
    const sel = t.getSelection();
    const rows: MenuRow[] = [
      { label: "Copy", hint: "⌘C", disabled: !sel, onClick: () => void api.copy(sel).catch(() => {}) },
      {
        label: "Paste",
        hint: "⌘V",
        onClick: async () => {
          const text = await api.clipboardText().catch(() => "");
          if (text) t.paste(text);
          t.focus();
        },
      },
      { label: "Select All", hint: "⌘A", onClick: () => t.selectAll() },
    ];
    if (!inputRef.current.includes("a")) rows.push("sep", { label: "Clear Screen", hint: "⌃L", onClick: () => (typed("\x0c"), t.focus()) });
    showMenu(e, rows);
  }

  // The GPU renderer for panes on screen, and kept a while for ones just hidden (see
  // GPU_KEEP): browsers allow a limited number of WebGL contexts.
  function releaseGPU() {
    gl.current?.dispose();
    gl.current = null;
    gpuGone(tabRef.current.key);
  }
  function setGPU(on: boolean) {
    const t = term.current;
    if (!t?.element) return;
    if (!on) return releaseGPU();
    if (settling.current) return; // a joined pane fitting its font: once it has (fitShared)
    if (gl.current) return gpuUsed(tabRef.current.key, releaseGPU);
    if (gpuOff) return;
    try {
      const a = new WebglAddon();
      a.onContextLoss(() => {
        a.dispose();
        if (gl.current === a) {
          gl.current = null;
          gpuGone(tabRef.current.key);
        }
        // The GPU took it back (too many contexts, its process restarted): a pane on screen
        // gets a new one, a few times at most.
        if (activeRef.current && lost.current++ < 3) window.setTimeout(() => activeRef.current && setGPU(true), 300);
      });
      t.loadAddon(a);
      gl.current = a;
      gpuUsed(tabRef.current.key, releaseGPU);
    } catch {
      /* DOM renderer */
    }
  }

  function safeFit() {
    const el = host.current;
    const f = fit.current;
    const t = term.current;
    if (!el || !f || !t || el.clientWidth < 40 || el.clientHeight < 40 || !t.element) return;
    if (tabRef.current.kind === "joined") return fitShared(t, el);
    try {
      f.fit();
    } catch {
      return;
    }
    announceSize();
  }

  // A joined pane shows the session at its own size: the grid is that size, and the font is
  // made smaller when that is what it takes to fit the pane (never larger than usual).
  function fitShared(t: XTerm, el: HTMLElement) {
    const size = sharedRef.current;
    if (!size) return;
    if (t.cols !== size.cols || t.rows !== size.rows) {
      try {
        t.resize(size.cols, size.rows);
      } catch {
        return;
      }
    }
    const cell = (t as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core?._renderService?.dimensions?.css?.cell;
    if (!cell?.width || !cell.height) return;
    const cur = t.options.fontSize ?? termFontSize(getState().zoom);
    const scale = Math.min(el.clientWidth / (size.cols * cell.width), el.clientHeight / (size.rows * cell.height));
    const want = Math.max(7, Math.min(termFontSize(getState().zoom), Math.floor(cur * scale * 4) / 4));
    if (Math.abs(want - cur) >= 0.25) {
      // The font takes a step or two to settle (cells don't scale exactly with it). The GPU
      // renderer is let go meanwhile and made once it has: making it again at every step
      // left the screen blank.
      releaseGPU();
      t.options.fontSize = want;
      cancelAnimationFrame(settling.current);
      settling.current = requestAnimationFrame(() => {
        settling.current = 0;
        safeFit();
      });
      return;
    }
    if (activeRef.current && !gl.current && !settling.current) {
      setGPU(true);
      t.clearTextureAtlas();
      t.refresh(0, t.rows - 1);
    }
  }

  // The grid a pane in a background tab will have when it is shown, worked out from its place
  // in its tab's layout and the size of a character in a terminal that is on screen.
  function hiddenSize(): { cols: number; rows: number } | null {
    const g = groupOf(tabRef.current.key);
    const rect = g && geometry(g.layout).rects[tabRef.current.key];
    if (!g || !rect) return null;
    const area = document.querySelector<HTMLElement>("[data-pane-area]");
    const scale = uiScale(getState().zoom);
    const aw = area?.clientWidth || window.innerWidth - (getState().sidebar ? 244 * scale : 0);
    const ah = area?.clientHeight || window.innerHeight - 40 * scale;
    let cw = 0;
    let ch = 0;
    for (const other of terminals.values()) {
      const screen = other.element?.querySelector<HTMLElement>(".xterm-screen");
      if (screen && screen.clientWidth > 0 && other.cols > 0 && other.rows > 0) {
        cw = screen.clientWidth / other.cols;
        ch = screen.clientHeight / other.rows;
        break;
      }
    }
    if (!(cw > 0 && ch > 0)) {
      const size = termFontSize(getState().zoom);
      cw = size * 0.6;
      ch = Math.ceil(size * 1.2 * termLineHeight(getState().term));
    }
    const header = (leaves(g.layout).length > 1 ? 26 * scale : 0) + (getState().term.footer ? PANE_FOOTER * scale : 0);
    // The terminal fills its pane; xterm keeps the width of its scrollbar free on the right.
    const cols = Math.floor((rect.w * aw - (persistent(tabRef.current) ? 1 : 8)) / cw);
    const rows = Math.floor((rect.h * ah - header) / ch);
    return cols >= 20 && rows >= 5 ? { cols, rows } : null;
  }

  // The grid is refitted locally at once, but the program in the terminal hears about it
  // once the size has settled: a zoom step, a divider drag or a window resize is one
  // SIGWINCH for Claude, not a burst that makes it redraw at sizes already gone.
  function announceSize() {
    window.clearTimeout(sizeTimer.current);
    sizeTimer.current = window.setTimeout(() => {
      const t = term.current;
      const s = ws.current;
      if (!t || s?.readyState !== WebSocket.OPEN || tabRef.current.kind === "joined") return;
      const size = `${t.cols}x${t.rows}`;
      if (size === sentSize.current) return;
      sentSize.current = size;
      s.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
      presenceOf(tabRef.current.key)?.resized();
      if (import.meta.env.DEV) devSizes(tabRef.current.key).push(size); // dev checks count these
    }, 70);
  }

  async function openBackend() {
    const tb = tabRef.current;
    if (tb.termId || opening.current || holdsOff(tb.key)) return; // a session moving: it attaches once it is there
    opening.current = true;
    const t = term.current!;
    if (tb.kind === "joined") {
      try {
        const j = await joinOf(tb);
        // The screen is the session's size before tmux draws on it: drawn at another size, what
        // it draws first is lost.
        if (j.share.cols > 0 && j.share.rows > 0) {
          joinSize.current = { cols: j.share.cols, rows: j.share.rows };
          sharedRef.current ??= joinSize.current;
          if (activeRef.current) safeFit();
          else t.resize(j.share.cols, j.share.rows);
        }
        updateTab(tb.key, {
          termId: `collab:${j.id}`,
          url: `${j.term}&c=${encodeURIComponent(clientId(tb.key))}`,
          exited: false,
          error: undefined,
          join: { ...tb.join!, id: j.id, title: j.share.info.title || j.share.title, by: j.share.by.name, role: j.share.role },
        });
      } catch (e) {
        const why = errText(e);
        // Stopped, removed or a link that doesn't work: the end of it. Unreachable: keep trying.
        if (/isn't shared|removed|doesn't work|isn't a Lungo|cut short/.test(why)) updateTab(tb.key, { error: why, retry: undefined });
        else dropTab(tb.key, why);
      } finally {
        opening.current = false;
      }
      return;
    }
    try {
      const dir = tb.spawn?.dir ?? "";
      const claude = !!tb.spawn?.claude;
      const how = { dir, claude, resume: tb.spawn?.resume ?? "", flags: tb.spawn?.flags ?? "", seen: sessionSeen(tb), prompt: tb.spawn?.prompt ?? "", run: tb.spawn?.run ?? "", agent: tb.spawn?.agent ?? "" };
      const info =
        tb.kind === "local" && !tb.session
          ? await api.openLocalTerminalIn(dir, claude, t.cols, t.rows)
          : await api.openSessionTerminal(tb.kind === "local" ? LOCAL : tb.machine!, tb.session ?? "", how, t.cols, t.rows);
      updateTab(tb.key, { termId: info.id, url: info.url, exited: false, error: undefined });
    } catch (e) {
      const why = errText(e);
      // The session is still there behind a machine that is stopped or unreachable: keep
      // trying. Only a machine that no longer exists is the end of it.
      if (persistent(tb) && !/no machine named|no longer exists|isn't installed/.test(why)) dropTab(tb.key, why);
      else updateTab(tb.key, { error: why, retry: undefined });
    } finally {
      opening.current = false;
    }
  }

  // Open the backend when the pane is first shown, and again whenever it let go of its
  // terminal to attach afresh (the connection dropped, the computer woke up).
  useEffect(() => {
    if (active) showView.current();
    // A pane on screen connects once it is laid out (at its size); one in the background may
    // connect again before that.
    if (tab.termId || tab.error || !term.current || (active && !term.current.element)) return;
    if (!active && !tab.retry && !everConnected.current) return; // a background pane's first connection waits its turn
    const timer = window.setTimeout(
      () => {
        if (activeRef.current) safeFit();
        openBackend();
      },
      tab.retry ? Math.max(0, tab.retry.at - Date.now()) : 0,
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tab.termId, tab.error, tab.retry?.at]);

  // Connect the WebSocket whenever the URL changes; reconnect if it drops unexpectedly.
  useEffect(() => {
    if (!tab.url) return;
    let stop = false;
    let attempts = 0;
    let retry: number | undefined;
    const key = tabRef.current.key;
    const tmux = persistent(tabRef.current) || tabRef.current.kind === "joined";
    // A session pane shows nothing of the connection being made (ssh's chatter, a failed
    // try): what was on screen stays until tmux takes over, then the session is drawn afresh.
    let attached = !tmux;
    let holding = tmux;
    let held: Uint8Array[] = [];
    let fresh = true; // the first connection to this terminal; later ones get its output replayed
    let tail = ""; // the end of what was printed, to read how it ended
    const dec = new TextDecoder();
    const dec2 = new TextDecoder();
    const release = () => {
      // Something other than tmux is talking (a question from ssh, an error that stays): show it.
      holding = false;
      const t = term.current;
      if (!t || !held.length) return;
      t.reset();
      for (const h of held) t.write(h);
      held = [];
      setSeen(true);
    };
    const holdTimer = window.setTimeout(release, 4000);
    if (!tmux) setSeen(true);

    const finished = (code: number) => {
      window.clearTimeout(holdTimer);
      const cur = tabRef.current;
      if (cur.kind === "joined") {
        // The share stopped (its presence says so a moment later), the session ended, or the
        // computer sharing it went away for now (the pane joins again).
        const text = plainText(tail);
        window.setTimeout(() => {
          const now = getState().tabs.find((x) => x.key === cur.key);
          if (!now || now.error || now.url !== cur.url) return;
          if (/\[(gone|exited)\]/.test(text.slice(-300))) updateTab(cur.key, { error: "The session ended.", termId: undefined, url: undefined });
          else dropTab(cur.key);
        }, 500);
        return;
      }
      if (!persistent(cur)) {
        // A plain shell: leaving it closes the pane, like any terminal.
        if (code === 0) closeTab(cur.key);
        else updateTab(cur.key, { exited: true });
        return;
      }
      const text = plainText(tail);
      // tmux says how it left: the session ended, or you detached. Then the pane has nothing
      // more to show. Anything else is a connection that broke: the session is still there.
      // "[gone]" is the machine saying the session was ended while the pane was away.
      if (code === 0 && (attached ? /\[(exited|detached[^\]]*)\]/.test(text.slice(-300)) : /\[gone\]/.test(text))) closeTab(cur.key);
      else dropTab(cur.key, attached ? undefined : lastLine(tail));
    };

    const connect = () => {
      const s = new WebSocket(tab.url!);
      s.binaryType = "arraybuffer";
      ws.current = s;
      const replay = !fresh;
      fresh = false;
      everConnected.current = true;
      // A connection made again gets the terminal's output replayed: it is drawn once it has
      // all come (it comes in pieces), so the screen doesn't go blank in between.
      let replaying = replay;
      let replayed: Uint8Array[] = [];
      let replayTimer: number | undefined;
      let replayCap: number | undefined;
      const drawReplay = () => {
        window.clearTimeout(replayTimer);
        window.clearTimeout(replayCap);
        if (!replaying) return;
        replaying = false;
        const t = term.current;
        if (!t) return;
        t.reset();
        if (replayed.length) t.write(joinBytes(replayed));
        replayed = [];
        dirty.current = true;
      };
      s.onopen = () => {
        attempts = 0;
        // The session may have been left in its scrollback; the first key typed makes sure.
        if (tmux) back.current = 1;
        const t = term.current;
        if (!t) return;
        sentSize.current = `${t.cols}x${t.rows}`;
        s.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
      };
      s.onmessage = (ev) => {
        const t = term.current;
        if (!t) return;
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === "exit") {
              stop = true;
              finished(typeof msg.code === "number" ? msg.code : -1);
            }
          } catch {
            /* ignore */
          }
          return;
        }
        let data = new Uint8Array(ev.data);
        tail = (tail + dec.decode(data, { stream: true })).slice(-800);
        if (replaying) {
          replayed.push(data);
          window.clearTimeout(replayTimer);
          replayTimer = window.setTimeout(drawReplay, 60);
          replayCap ??= window.setTimeout(drawReplay, 400);
          return;
        }
        dirty.current = true;
        if (replay) {
          t.write(data);
          return;
        }
        if (!attached) {
          if (holding) {
            held.push(data);
            data = joinBytes(held);
          }
          const at = indexOfSeq(data, ALT_SCREEN);
          if (at < 0) {
            if (!holding) t.write(data);
            else if (data.length > 256 * 1024) release(); // not a session attaching, whatever it is
            return;
          }
          attached = true;
          holding = false;
          held = [];
          window.clearTimeout(holdTimer);
          t.reset();
          t.write(data.subarray(at));
          setSeen(true);
          paneAttached(key);
          arrived(key);
          return;
        }
        // ssh's parting words when a connection breaks would land in the middle of the frozen screen.
        if (tmux && data.length < 160 && /^(Shared connection|Connection) to \S+ closed\.\s*$/.test(dec2.decode(data))) return;
        t.write(data);
      };
      s.onclose = () => {
        drawReplay();
        if (stop || ws.current !== s) return;
        if (++attempts > 20) {
          // It keeps dropping: the pane says so rather than look connected while frozen.
          const cur = tabRef.current;
          if (persistent(cur) || cur.kind === "joined") dropTab(cur.key, "The connection kept dropping");
          else updateTab(cur.key, { exited: true });
          return;
        }
        retry = window.setTimeout(connect, Math.min(4000, 250 * attempts));
      };
    };
    connect();
    return () => {
      stop = true;
      window.clearTimeout(retry);
      window.clearTimeout(holdTimer);
      ws.current?.close();
      ws.current = null;
    };
  }, [tab.url]);

  useEffect(() => {
    const waiting = !tab.url && !tab.error;
    if (!waiting) return setLate(false);
    const timer = window.setTimeout(() => setLate(true), 1500);
    return () => window.clearTimeout(timer);
  }, [tab.url, tab.error]);

  // Keep this session's screen for next time: when it changed, every few seconds while it is
  // connected (when the page has a moment), and at once when the window goes away.
  useEffect(() => {
    if (!tab.url || !persistent(tab)) return;
    const save = () => {
      const t = term.current;
      const ser = serializer.current;
      if (!t || !ser || !seenRef.current) return;
      try {
        writeSnap(tabRef.current, ser.serialize({ scrollback: 0, excludeModes: true }));
      } catch {
        /* a screen that can't be kept is not worth an error */
      }
    };
    const keep = (now: boolean) => {
      if (!dirty.current) return;
      dirty.current = false;
      if (now) save();
      else whenIdle(save);
    };
    const soon = () => keep(false);
    const now = () => keep(true);
    const timer = window.setInterval(soon, 8000);
    window.addEventListener("pagehide", now);
    window.addEventListener("beforeunload", now);
    return () => {
      now();
      window.clearInterval(timer);
      window.removeEventListener("pagehide", now);
      window.removeEventListener("beforeunload", now);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.url]);

  // A pane in a background tab keeps the size it will have when shown, so showing it doesn't
  // resize the program in it (Claude drawing again over the network, a flash). After the
  // window, the tab's layout, the zoom or the sidebar change, that size is worked out again.
  const layoutHere = useStore((s) => groupOf(tab.key, s)?.layout);
  const sidebarShown = useStore((s) => s.sidebar);
  useEffect(() => {
    if (active || tab.kind === "joined") return;
    const fitHidden = () => {
      const t = term.current;
      if (!t || activeRef.current) return;
      const size = hiddenSize();
      if (!size || (size.cols === t.cols && size.rows === t.rows)) return;
      try {
        t.resize(size.cols, size.rows);
      } catch {
        return;
      }
      announceSize();
    };
    let timer = window.setTimeout(fitHidden, 250);
    const later = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(fitHidden, 250);
    };
    window.addEventListener("resize", later);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", later);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, layoutHere, zoom, sidebarShown]);

  // Shown: draw with the GPU (a kept renderer is used again) and refit. Hidden: the renderer
  // stays while the pane is among the most recently shown. Focused: take the keyboard.
  useEffect(() => {
    if (!active) return;
    showView.current();
    lost.current = 0;
    setGPU(true);
    const id = requestAnimationFrame(() => {
      safeFit();
      if (focused) term.current?.focus();
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, focused]);

  // The GPU renderer caches glyphs for one cell size. Changing the size with that cache
  // alive leaves cells pointing at the wrong glyphs (rows of rules across the screen), so
  // the renderer is rebuilt around the change, the grid refitted and the screen repainted.
  function setMetrics(change: (t: XTerm) => void) {
    const t = term.current;
    if (!t) return;
    setGPU(false);
    change(t);
    if (!activeRef.current) return; // a hidden pane gets its renderer and its fit when shown
    setGPU(true);
    requestAnimationFrame(() => {
      safeFit();
      t.clearTextureAtlas();
      t.refresh(0, t.rows - 1);
    });
  }

  // Zoom changes the font size; the grid is refitted to the same space.
  useEffect(() => {
    if (term.current && term.current.options.fontSize !== termFontSize(zoom)) setMetrics((t) => (t.options.fontSize = termFontSize(zoom)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // Terminal settings: line height changes the cell size, the cursor options don't.
  const prefs = useStore((s) => s.term);
  useEffect(() => {
    const t = term.current;
    if (!t) return;
    t.options.cursorStyle = prefs.cursor;
    t.options.cursorBlink = prefs.blink;
    if (t.options.lineHeight !== termLineHeight(prefs)) setMetrics((x) => (x.options.lineHeight = termLineHeight(prefs)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs]);

  const view = useStore((s) => s.view);
  useEffect(() => {
    if (view === "sessions" && active)
      requestAnimationFrame(() => {
        safeFit();
        if (focused) term.current?.focus();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // The pane's presence in its share: connected while the session is shared (or joined), so
  // the others see this pane's pointer and selection, and it sees theirs.
  useEffect(() => {
    let off = false;
    presenceURL(tabRef.current, share).then(
      (url) => !off && linkPresence(tabRef.current.key, url, joined),
      () => {},
    );
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [share?.id, tab.url, tab.error]); // a joined pane's address is known once it has joined
  useEffect(() => () => linkPresence(tab.key, null, false), [tab.key]);

  // The session's size changed (or became known): a joined pane is drawn at it.
  useEffect(() => {
    if (joined && activeRef.current) safeFit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedSize?.cols, sharedSize?.rows]);
  // Watching only: the keyboard has nothing to do in it.
  useEffect(() => {
    if (term.current) term.current.options.disableStdin = joined && viewOnly;
  }, [joined, viewOnly]);

  const where = joined ? `${firstName(tab.join?.by)}'s session` : machineLabel(tab.kind === "local" ? LOCAL : tab.machine);
  const waiting = !tab.url && !tab.error; // no terminal behind the pane right now
  const quiet = waiting && seen && !late; // just reconnecting, or just opened from its last screen: no notice yet
  const why = shortWhy(tab.retry?.why);
  const stuck = !!tab.retry && tab.retry.n > 2; // not a blip any more: say why, offer a retry
  const move = useMoving(tab.key); // the session is on its way to another device: that says so instead
  return (
    <div className="absolute inset-0" style={{ background: "var(--term-bg)" }}>
      <div
        ref={host}
        onContextMenu={terminalMenu}
        onMouseMove={pointerMoved}
        onMouseDownCapture={pointerDown}
        onMouseLeave={() => presenceOf(tab.key)?.pointer(null)}
        className={cx("term-host absolute inset-0 transition-opacity duration-300", move ? "opacity-30" : waiting && seen && !quiet && "opacity-50")}
      />
      {(share || joined) && <PresenceLayer tabKey={tab.key} />}
      {move && <MoveOverlay move={move} />}
      {waiting && !seen && !move && (
        <div className="z absolute inset-0 flex flex-col items-center justify-center gap-2 text-[12.5px] text-subtle">
          <div className="flex items-center gap-2">
            <Spinner /> Connecting to {where}…
          </div>
          {stuck && (
            <div className="flex max-w-[80%] items-center gap-2 text-[11.5px]">
              {why && (
                <span className="truncate" title={tab.retry?.why}>
                  {why}
                </span>
              )}
              <button onClick={() => retryNow(tab.key)} className="shrink-0 text-accent hover:underline">
                Try now
              </button>
            </div>
          )}
        </div>
      )}
      {waiting && seen && !quiet && !move && (
        <div className="z anim-fade pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
          <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-line-strong bg-[color-mix(in_srgb,var(--raised)_94%,transparent)] py-1.5 pr-3.5 pl-3 text-[11.5px] text-muted shadow-pop backdrop-blur">
            <Spinner size={12} />
            <span className="shrink-0">Reconnecting to {where}…</span>
            {stuck && why && (
              <span className="min-w-0 truncate text-subtle" title={tab.retry?.why}>
                {why}
              </span>
            )}
            {stuck && (
              <button onClick={() => retryNow(tab.key)} className="shrink-0 text-accent hover:underline">
                Try now
              </button>
            )}
          </div>
        </div>
      )}
      {(tab.exited || tab.error) && (
        <div className="z anim-fade absolute inset-x-0 bottom-0 z-20 flex items-center gap-3 border-t border-line bg-[color-mix(in_srgb,var(--raised)_92%,transparent)] px-4 py-2.5 backdrop-blur">
          <Unplug size={15} className="text-subtle" />
          <div className="min-w-0 flex-1 text-[12.5px]">{tab.error ? <span className="text-bad">{tab.error}</span> : <span className="text-muted">The shell ended.</span>}</div>
          {/* A joined pane that ended is over: the share stopped, you were removed, the session ended. */}
          {!(joined && tab.error) && (
            <Button size="xs" variant="outline" icon={<RotateCcw size={12} />} onClick={() => reattachTab(tab.key)}>
              {persistent(tab) ? "Try again" : "New shell"}
            </Button>
          )}
          <Button size="xs" variant="ghost" icon={<X size={12} />} onClick={() => closeTab(tab.key)}>
            Close
          </Button>
        </div>
      )}
    </div>
  );
});
