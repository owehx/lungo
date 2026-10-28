import { useEffect, useRef } from "react";
import { api, errText, on } from "./lib/api";
import {
  closeTab,
  focusGroup,
  getState,
  initWindow,
  jumpNeedsYou,
  loadMachines,
  loadSessions,
  moveFocus,
  newTab,
  openLocalTab,
  refreshMachines,
  restoreLayout,
  setState,
  setZoom,
  splitPane,
  switchCancel,
  switchCommit,
  switchMove,
  switchStep,
  toast,
  toggleSidebar,
  toggleZoom,
  useStore,
  wireEvents,
  type Switcher as SwitcherState,
  type View,
  visibleGroups,
  setWorkspace,
  switchType,
  openWelcome,
} from "./lib/store";
import { isNativeWebview } from "./lib/util";
import { askJoin, watchShares } from "./lib/collab";
import { JoinHost } from "./components/Share";
import { Sidebar } from "./components/Sidebar";
import { Palette } from "./components/Palette";
import { HistoryDialog } from "./components/History";
import { SearchDialog } from "./components/SearchAll";
import { closeDialogs, toggleDialog } from "./lib/history";
import { Switcher } from "./components/Switcher";
import { ContextMenuHost } from "./components/ContextMenu";
import { RecipesDialog } from "./components/Recipes";
import { Composer } from "./components/Composer";
import { FilesDialog } from "./components/Files";
import { PeekOverlay } from "./components/Peek";
import { toggleFiles } from "./lib/peek";
import { ScreenOverlay } from "./components/Screen";
import { toggleScreen } from "./lib/screen";
import { Toasts } from "./components/Toasts";
import { Welcome } from "./components/Welcome";
import { OpModal } from "./components/OpLog";
import { HomeView, NewSessionDialog, SessionsView } from "./views/Sessions";
import { AddMachineDialog, MachineSheet, MachinesView } from "./views/Machines";
import { NewMachineDialog } from "./views/NewMachine";
import { SyncView } from "./views/Sync";
import { FoldersView } from "./views/Folders";
import { AccountsView } from "./views/Accounts";
import { SettingsView } from "./views/Settings";

const views: Record<string, View> = {
  Home: "home",
  Sessions: "sessions",
  Machines: "machines",
  Sync: "sync",
  Keys: "accounts", // keys live on the Accounts page
  Folders: "folders",
  Projects: "folders",
  Accounts: "accounts",
  Settings: "settings",
};

function handleMenu(name: string, arg?: unknown, arg2?: unknown) {
  const s = getState();
  switch (name) {
    case "new-tab":
      newTab();
      break;
    case "new-session":
      setState({ modal: { type: "new-session" } });
      break;
    case "new-window":
      api.newWindow().catch((e) => toast("error", "Couldn't open a window", errText(e)));
      break;
    case "switch":
      switchStep(arg as 1 | -1, arg2 as SwitcherState["mod"]);
      break;
    case "join":
      void askJoin();
      break;
    case "needs-you":
      jumpNeedsYou();
      break;
    case "sidebar":
      toggleSidebar();
      break;
    case "zoom-in":
      setZoom(s.zoom + 1);
      break;
    case "zoom-out":
      setZoom(s.zoom - 1);
      break;
    case "zoom-reset":
      setZoom(0);
      break;
    case "new-local":
      openLocalTab();
      break;
    case "new-machine":
      setState({ modal: { type: "new-machine" } });
      break;
    case "palette":
      setState({ modal: s.modal?.type === "palette" ? null : { type: "palette" } });
      break;
    case "welcome":
      openWelcome();
      break;
    case "recipes":
      setState({ modal: s.modal?.type === "recipes" ? null : { type: "recipes" } });
      break;
    case "composer":
      // A prompt is written for the pane in front; without one there is nothing to send it to.
      if (s.modal?.type === "composer") setState({ modal: null });
      else if (s.view === "sessions" && s.activeTab) setState({ modal: { type: "composer" } });
      break;
    case "close-tab":
      if (closeDialogs()) break; // history or search is open: that is what closes
      if (s.modal) setState({ modal: null });
      else if (s.machineSheet) setState({ machineSheet: undefined });
      else if (s.view === "sessions" && s.activeTab) closeTab(s.activeTab);
      break;
    case "tab": {
      const g = visibleGroups(s)[(arg as number) - 1];
      if (g) focusGroup(g.id);
      break;
    }
    case "next-tab":
    case "prev-tab": {
      const shown = visibleGroups(s);
      if (!shown.length) break;
      const i = shown.findIndex((g) => g.id === s.activeGroup);
      const n = (i + (name === "next-tab" ? 1 : -1) + shown.length) % shown.length;
      focusGroup(shown[n].id);
      break;
    }
    case "workspace": {
      // 0 is "All"; 1–9 the workspaces in the order they were made.
      const n = arg as number;
      if (n === 0) setWorkspace(null);
      else if (s.workspaces[n - 1]) setWorkspace(s.workspaces[n - 1]);
      setState({ view: "sessions" });
      break;
    }
    case "split-right":
      setState({ view: "sessions" });
      splitPane("row");
      break;
    case "split-down":
      setState({ view: "sessions" });
      splitPane("col");
      break;
    case "zoom":
      toggleZoom();
      break;
    case "focus":
      moveFocus(arg as "left" | "right" | "up" | "down");
      break;
    case "view":
      setState({ view: views[arg as string] ?? "sessions" });
      break;
    case "reload":
      refreshMachines();
      loadSessions();
      break;
    case "history":
      toggleDialog("history");
      break;
    case "screen": {
      // The screen of the machine the pane in front is on, when it is a Mac.
      const t = s.view === "sessions" ? s.tabs.find((x) => x.key === s.activeTab) : undefined;
      const on = t && t.kind !== "local" ? s.machines.find((x) => x.machine.name === t.machine)?.machine : undefined;
      toggleScreen(on?.os === "darwin" ? on.name : undefined);
      break;
    }
    case "files":
      toggleFiles(s.view === "sessions" ? s.tabs.find((t) => t.key === s.activeTab) : undefined);
      break;
    case "search-all":
      toggleDialog("search");
      break;
  }
}

// A shortcut can reach us twice in the desktop app: once from the native menu and once as a
// key event the web view also delivers. The second copy of the same command is dropped: the
// two never come from one source, and nobody presses the same shortcut through both within
// a moment. For the switcher keys the web view's copy is the one that counts (it arrives
// with the key going down and up), so once one has been seen the menu's are ignored.
let lastFire = { sig: "", from: "", at: 0 };
let keySwitcher = false;
function fire(from: "menu" | "key", name: string, ...args: unknown[]) {
  if (name === "switch") {
    if (from === "key") keySwitcher = true;
    else if (keySwitcher) return;
  }
  const sig = `${name}:${args.join(",")}`;
  const now = performance.now();
  if (sig === lastFire.sig && from !== lastFire.from && now - lastFire.at < 400) return;
  lastFire = { sig, from, at: now };
  handleMenu(name, ...args);
}

const arrows: Record<string, string> = { arrowleft: "left", arrowright: "right", arrowup: "up", arrowdown: "down" };
const viewOrder = ["Home", "Sessions", "Machines", "Sync", "Projects", "Accounts", "Settings"];

/** The command for a ⌘ shortcut, for a plain browser (wails dev) where there is no native menu. */
function browserShortcut(e: KeyboardEvent): [string, ...unknown[]] | null {
  const k = e.key.toLowerCase();
  if (e.altKey) {
    if (arrows[k]) return ["focus", arrows[k]];
    const n = /^Digit([1-7])$/.exec(e.code);
    return n ? ["view", viewOrder[parseInt(n[1]) - 1]] : null;
  }
  if (e.shiftKey) {
    const digit = /^Digit([0-9])$/.exec(e.code);
    if (digit) return ["workspace", parseInt(digit[1])];
    const shifted: Record<string, string> = { s: "screen", t: "new-session", d: "split-down", n: "new-window", enter: "zoom", "]": "next-tab", "}": "next-tab", "[": "prev-tab", "{": "prev-tab", "+": "zoom-in", "=": "zoom-in", r: "recipes", f: "search-all", j: "join" };
    if (shifted[k]) return [shifted[k]];
  }
  const plain: Record<string, string> = {
    k: "palette",
    e: "composer",
    t: "new-tab",
    w: "close-tab",
    n: "new-machine",
    l: "new-local",
    d: "split-right",
    b: "sidebar",
    j: "needs-you",
    y: "history",
    o: "files",
    "=": "zoom-in",
    "+": "zoom-in",
    "-": "zoom-out",
    "0": "zoom-reset",
  };
  if (!e.shiftKey && plain[k]) return [plain[k]];
  if (/^[1-9]$/.test(k)) return ["tab", parseInt(k)];
  return null;
}

export function App() {
  const view = useStore((s) => s.view);
  const modal = useStore((s) => s.modal);
  const welcome = useStore((s) => s.welcome);
  const sheet = useStore((s) => s.machineSheet);
  const machinesKnown = useStore((s) => s.machinesKnown);
  const windowReady = useStore((s) => s.winReady);
  const restored = useRef(false);

  // Bring back the pane layout from last time once the machines are really known (a failed
  // read would drop every tab on a machine). The store keeps it saved from then on.
  useEffect(() => {
    if (!machinesKnown || !windowReady || restored.current) return;
    restored.current = true;
    restoreLayout(getState().machines.map((m) => m.machine.name));
  }, [machinesKnown, windowReady]);

  useEffect(() => {
    wireEvents();
    watchShares();
    api
      .info()
      .then((info) => {
        document.documentElement.dataset.platform = info.platform;
        setState({ info });
      })
      .catch(() => {});
    loadMachines();
    loadSessions();
    api
      .tunnels()
      .then((tunnels) => setState({ tunnels: tunnels ?? [] }))
      .catch(() => {});
    api
      .lastSyncAll()
      .then((r) => setState({ syncResults: r ?? {} }))
      .catch(() => {});
    api
      .ops()
      .then((ops) => {
        const map = Object.fromEntries(ops.map((o) => [o.id, { info: o, events: [] }]));
        setState({ ops: map, opOrder: ops.map((o) => o.id) });
      })
      .catch(() => {});
    initWindow();
    const off = on<string>("menu", (name, ...args) => fire("menu", name, ...args));
    // In a plain browser (wails dev) there is no native menu, so every shortcut is handled here.
    // In the app the menu handles them; only the switcher keys and ⌘+ also need this path.
    const native = isNativeWebview();
    const held = (e: KeyboardEvent | MouseEvent, sw: SwitcherState) => (sw.mod === "Control" ? e.ctrlKey : e.altKey);
    const keydown = (e: KeyboardEvent) => {
      const sw = getState().switcher;
      if (e.key === "Tab" && (e.ctrlKey || e.altKey) && !e.metaKey && !(e.ctrlKey && e.altKey)) {
        e.preventDefault();
        e.stopPropagation();
        fire("key", "switch", e.shiftKey ? -1 : 1, e.ctrlKey ? "Control" : "Alt");
        return;
      }
      if (sw) {
        // While the switcher is up the keyboard belongs to it.
        if (e.key === "Escape") switchCancel();
        else if (e.key === "Enter") switchCommit();
        else if (e.key === "ArrowRight") switchMove("right");
        else if (e.key === "ArrowLeft") switchMove("left");
        else if (e.key === "ArrowDown") switchMove("down");
        else if (e.key === "ArrowUp") switchMove("up");
        else if (e.key === "Backspace") switchType("Backspace");
        else if (/^(Key[A-Z]|Digit[0-9])$/.test(e.code) && !e.metaKey)
          switchType(e.code.slice(-1).toLowerCase()); // by the key, not the character: ⌥ and ⌃ change what a letter types
        else if (e.code === "Space") switchType(" ");
        else if (!held(e, sw)) {
          switchCommit(); // the release was missed (it happened in another app)
          return;
        } else if (e.key !== "Shift" && e.key !== sw.mod) return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!(e.metaKey || (e.ctrlKey && e.shiftKey))) return;
      if (native) {
        // ⌘+ is ⌘⇧= on most keyboards; the menu only knows ⌘=.
        if (e.metaKey && e.key === "+") {
          e.preventDefault();
          fire("key", "zoom-in");
        }
        // ⇧⌘0–9: workspaces (not in the menu: they come and go).
        const digit = e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey ? /^Digit([0-9])$/.exec(e.code) : null;
        if (digit) {
          e.preventDefault();
          e.stopPropagation();
          fire("key", "workspace", parseInt(digit[1]));
        }
        return;
      }
      const cmd = browserShortcut(e);
      if (cmd) {
        e.preventDefault();
        e.stopPropagation();
        fire("key", ...cmd);
      }
    };
    const keyup = (e: KeyboardEvent) => {
      const sw = getState().switcher;
      if (sw && (e.key === sw.mod || !held(e, sw))) switchCommit();
    };
    const mouse = (e: MouseEvent) => {
      const sw = getState().switcher;
      if (sw && !held(e, sw)) switchCommit();
    };
    // The window's size and place are remembered; tell the backend when they settle.
    let frameTimer: number | undefined;
    // Full screen hides the window buttons, so the room kept for them is given back. Asked
    // again a moment after a resize: going full screen is an animation.
    const fullscreen = async () => {
      let full = !native; // in a plain browser there are no window buttons at all
      try {
        const rt = (window as unknown as { runtime?: { WindowIsFullscreen?: () => Promise<boolean> } }).runtime;
        if (native && rt?.WindowIsFullscreen) full = await rt.WindowIsFullscreen();
      } catch {
        /* keep the room */
      }
      document.documentElement.toggleAttribute("data-fullscreen", full);
    };
    void fullscreen();
    let fullTimers: number[] = [];
    const resized = () => {
      window.clearTimeout(frameTimer);
      frameTimer = window.setTimeout(() => native && api.saveWindowFrame().catch(() => {}), 500);
      fullTimers.forEach((t) => window.clearTimeout(t));
      fullTimers = [150, 900, 1800].map((ms) => window.setTimeout(fullscreen, ms));
    };
    window.addEventListener("resize", resized);
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);
    window.addEventListener("mousemove", mouse, true);
    window.addEventListener("blur", switchCommit);
    return () => {
      off();
      window.clearTimeout(frameTimer);
      window.removeEventListener("resize", resized);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
      window.removeEventListener("mousemove", mouse, true);
      window.removeEventListener("blur", switchCommit);
    };
  }, []);

  const close = () => setState({ modal: null });

  return (
    <div className="flex h-full bg-transparent">
      <Sidebar />
      <main className="relative min-w-0 flex-1 bg-bg">
        <SessionsView visible={view === "sessions"} />
        {view !== "sessions" && (
          <div className="z absolute inset-0">
            {view === "machines" && <MachinesView />}
            {view === "sync" && <SyncView />}
            {view === "home" && <HomeView />}
            {view === "folders" && <FoldersView />}
            {(view === "accounts" || view === "keys") && <AccountsView />}
            {view === "settings" && <SettingsView />}
          </div>
        )}
      </main>

      {sheet && <MachineSheet name={sheet} onClose={() => setState({ machineSheet: undefined })} />}
      {modal?.type === "palette" && <Palette onClose={close} />}
      {modal?.type === "recipes" && <RecipesDialog edit={modal.edit} onClose={close} />}
      {modal?.type === "composer" && <Composer onClose={close} />}
      {modal?.type === "new-session" && <NewSessionDialog machine={modal.machine} dir={modal.dir} onClose={close} />}
      {modal?.type === "new-machine" && <NewMachineDialog onClose={close} />}
      {modal?.type === "add-machine" && <AddMachineDialog onClose={close} />}
      {modal?.type === "op" && <OpModal id={modal.id} onClose={close} />}
      <HistoryDialog />
      <SearchDialog />
      <FilesDialog />
      {welcome && <Welcome />}
      <ScreenOverlay />
      <PeekOverlay />
      <Switcher />
      <ContextMenuHost />
      <JoinHost />
      <Toasts />
    </div>
  );
}
