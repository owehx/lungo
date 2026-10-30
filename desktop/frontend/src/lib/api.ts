// Typed access to the Go backend. The generated bindings return Wails model classes; the
// UI works with these plain interfaces instead, which mirror the Go JSON.
import * as Go from "../wailsjs/go/main/App";
import { EventsOn } from "../wailsjs/runtime/runtime";

export type Status =
  | "running"
  | "stopped"
  | "starting"
  | "stopping"
  | "provisioning"
  | "unreachable"
  | "unknown"
  | "missing"
  | "";

export interface Machine {
  name: string;
  provider: string;
  account?: string;
  region?: string;
  zone?: string;
  size?: string;
  diskGB?: number;
  instanceId?: string;
  volumeId?: string;
  status?: Status;
  publicIp?: string;
  tailscaleIp?: string;
  tailscaleName?: string;
  host?: string;
  port?: number;
  user: string;
  keyPath?: string;
  sshAlias?: string;
  os?: string;
  sync: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MachineView {
  machine: Machine;
  providerLabel: string;
  sshShort: string;
  sshFull: string;
  address: string;
  monthly: number;
  stoppedCost: number;
  cpus: number;
  memoryGB: number;
}

export interface Size {
  id: string;
  label: string;
  cpus: number;
  memoryGB: number;
  monthly: number;
  note?: string;
  default?: boolean;
}
export interface Region {
  id: string;
  label: string;
  zone?: string;
}
export interface Account {
  id: string;
  label: string;
  default?: boolean;
}
export interface ProviderStatus {
  id: string;
  label: string;
  cli: string;
  installed: boolean;
  loggedIn: boolean;
  identity?: string;
  accounts: Account[];
  hint?: string;
  install?: string;
  diskPerGB: number;
}
export interface Catalog {
  provider: string;
  regions: Region[];
  sizes: Size[];
  defaultRegion: string;
  diskPerGB: number;
}
export interface Spec {
  name: string;
  provider: string;
  account: string;
  region: string;
  zone?: string;
  size: string;
  diskGB: number;
  user: string;
  tailscale: boolean;
  docker: boolean;
}
export interface AddSpec {
  name: string;
  host: string;
  user: string;
  port: number;
  keyPath: string;
  alias: string;
  setup: boolean;
  tailscale: boolean;
}

export type ClaudeState = "working" | "waiting" | "idle" | "";
export interface Session {
  machine: string;
  name: string;
  created: string;
  activity: string;
  attached: number;
  windows: number;
  path: string;
  command: string;
  claude: boolean;
  state?: ClaudeState;
  stateAt?: string;
  message?: string;
  title?: string; // what the program calls the session (Claude's task name)
  sid?: string; // Claude's conversation ID, to resume it if the session is lost
  flags?: string; // how Claude was started (permission flags)
  branch?: string; // the git branch of its folder
  claudeSince?: string; // when the Claude in it started
  loginAt?: string; // when the machine's login last changed
  oldLogin?: boolean; // Claude started before that: it still runs on the previous login
  mouse?: boolean; // the program asked for the mouse (Claude's fullscreen view, vim): clicks are its
  alt?: boolean; // the program uses the whole screen rather than a command line
  scrollKey?: boolean; // the machine's tmux knows sky's key for leaving scrollback
  agent?: string; // the coding agent running in it: claude | codex | grok | mantis
  stale?: boolean; // its machine couldn't be reached on the last look: this is what it had before
}
/** What a pane shows about the repository its folder is in. */
export interface GitInfo {
  repo: boolean;
  root?: string;
  branch?: string; // branch name, or the short commit when detached
  detached?: boolean;
  changed: number; // files changed or untracked
  ahead: number;
  behind: number;
}
/** A file or folder on a machine (or this computer). */
export interface RemoteFile {
  path: string; // absolute, on the machine
  name: string;
  size: number;
  mod: string;
  dir?: boolean;
}
/** What was made lately where a session works. */
export interface FilesView {
  dir: string;
  files: RemoteFile[];
}
/** A file brought over from a machine, ready to show. */
export interface PeekView {
  file: RemoteFile;
  local: string; // where it is on this computer
  url: string; // where the page loads it from
}
/** What the page needs to show a machine's screen. */
export interface ScreenView {
  url: string; // the WebSocket that is the connection
  user: string;
  password: string; // the saved one; "" when it hasn't been given yet
}
/** How to make a pane's session when it isn't there. */
export interface AttachOptions {
  dir: string;
  claude: boolean;
  resume: string;
  flags: string;
  seen: number; // when the session was last known to exist (unix seconds; 0 = never)
  prompt: string; // Claude's first message in a session that is being made
  run: string; // a command typed into a new shell session
  agent?: string; // start another agent than Claude: codex | grok | mantis
}
/** Whether sessions on this computer can outlive the app (they run in tmux). */
export interface LocalTmuxInfo {
  installed: boolean;
  path: string;
  canInstall: boolean;
  how: string;
}
export interface SessionsView {
  sessions: Session[];
  errors: Record<string, string>;
  at: string;
}
export interface SessionOptions {
  name: string;
  dir: string;
  claude: boolean;
  args: string;
  prompt: string;
  agent?: string; // another agent instead of Claude: codex | grok | mantis
}

export interface Port {
  port: number;
  address: string;
  process?: string;
}
export interface Tunnel {
  id: string;
  machine: string;
  remotePort: number;
  localPort: number;
  url: string;
  started: string;
}
export interface TailscaleInfo {
  installed: boolean;
  connected: boolean;
  state: string;
  self: string;
  ip: string;
  tailnet: string;
  hasAuthKey: boolean;
}
export interface SyncItem {
  id: string;
  label: string;
  description: string;
}
export interface SyncResult {
  machine: string;
  changes: string[];
  errors: string[];
  skipped?: string;
  at: string;
}
export interface Link {
  id: string;
  local: string;
  machine: string;
  remote: string;
  direction: "push" | "pull";
  excludes?: string[];
  delete?: boolean;
  watch?: boolean;
  lastSync?: string;
}
export interface FolderOptions {
  delete: boolean;
  excludes: string[];
  lean: boolean;
  dryRun: boolean;
}
export interface Settings {
  defaultProvider: string;
  remoteUser: string;
  tailscale: boolean;
  docker: boolean;
  autoTmux: boolean;
  terminal: string;
  syncInterval: number;
  syncPaths: string[];
  skipCredentials: string[];
  skipMCP: string[];
}
export interface ClaudeStatus {
  installed: boolean;
  signedIn: boolean;
  email: string;
  org: string;
  hasToken: boolean;
}
export interface AppInfo {
  version: string;
  platform: "darwin" | "windows" | "linux";
  home: string;
  localUser: string;
  configDir: string;
  terminals: string[];
  syncItems: SyncItem[];
  credentialNames: string[];
  providers: { id: string; label: string }[];
  appIcon: string; // the icon picked in Settings (lib/appicons.ts)
}
export interface TermInfo {
  id: string;
  title: string;
  url: string;
  started: string;
  exited: boolean;
  code: number;
}
export interface OpInfo {
  id: string;
  kind: string;
  title: string;
  machine: string;
  started: string;
  ended?: string;
  running: boolean;
  error?: string;
  lastLine?: string;
}
export type OpLevel = "step" | "info" | "done" | "warn" | "error" | "link" | "log";
export interface OpEvent {
  op: string;
  machine?: string;
  level: OpLevel;
  message: string;
  url?: string;
  time: string;
}
export interface APIKeyView {
  name: string;
  provider: string;
  label: string;
  icon: string;
  docs?: string;
  masked: string;
  stored: boolean;
  shell?: string;
  sync: boolean;
  machines: string[];
  canTest: boolean;
}
export interface APIProvider {
  id: string;
  label: string;
  env: string;
  icon: string;
  docs: string;
  canTest: boolean;
}
export interface KeyTest {
  ok: boolean;
  detail: string;
  error?: string;
}
export interface UsageWindow {
  utilization: number; // fraction, 1 = 100%
  resetsAt: string;
}
export interface AccountStatus {
  state: "ok" | "warning" | "limited" | "invalid" | "error" | "";
  limitType?: string;
  resetsAt?: string;
  windows?: Record<string, UsageWindow>;
  message?: string;
  checkedAt: string;
}
export interface ClaudeAccount {
  id: string;
  label: string;
  email?: string;
  disabled?: boolean;
  addedAt: string;
}
export interface ClaudeAccountView {
  account: ClaudeAccount;
  status: AccountStatus;
  active: boolean;
  next: boolean;
  hasToken: boolean;
  summary: string;
  plan?: string;
  person?: string;
  org?: string;
  local: boolean;
  rank: number;
  reason: string;
  suggest: boolean;
}
export interface TickResult {
  switched: boolean;
  from?: string;
  to?: string;
  reason?: string;
  restarted: number;
  allLimited: boolean;
  next?: string;
  followed?: string; // sessions moved to the account a /login on this Mac chose
}
/** This Mac's own Claude Code login, as the account pool sees it. */
export interface LocalLogin {
  email: string;
  accountId?: string; // the pool account it is; absent when not in the pool
  changedAt?: string; // when a /login switched it
}
export interface Credential {
  path: string;
  label: string;
  icon: string;
  present: boolean;
  skipped: boolean;
}
export interface OpEnd {
  op: string;
  error?: string;
  result?: unknown;
}
/** What a local terminal is doing: the folder of the program in front, and whether Claude runs in it. */
export interface TermProbe {
  cwd: string;
  command: string;
  claude: boolean;
}
/** This window among the app's instances ("main" is the first one). */
/** Which version this is and whether a newer one is on its way (see desktop/update.go). */
export interface UpdateInfo {
  current: string;
  latest?: string;
  state: "" | "checking" | "downloading" | "ready" | "error" | "off";
  progress?: number;
  notes?: string;
  error?: string;
  checkedAt?: string;
  auto: boolean;
  why?: string; // why this build can't update itself
}

export interface WindowInfo {
  id: string;
  primary: boolean;
  count: number;
  headless?: boolean; // the app's own window is hidden and a browser drives the UI (dev checks)
  forgotten?: string[]; // windows closed for good: their tabs are to be cleared from storage
}

/** One filesystem; sizes in bytes, pct as df counts it. */
export interface Disk {
  mount: string;
  total: number;
  used: number;
  free: number;
  pct: number;
}
/** What a machine's stop-when-idle watchdog last decided. */
export interface IdleState {
  limit: number; // minutes
  dryRun?: boolean;
  at?: string; // when it last looked; absent before its first run
  active: boolean;
  reason?: string; // what was going on: "tmux client attached"
  since?: string; // idle since
}
/** How a running machine is doing. */
export interface Health {
  machine: string;
  at: string;
  os: string;
  cpus: number;
  load: number[]; // 1, 5 and 15 minutes
  cpuPct: number; // the 1-minute load against the cores; above 100 when work queues
  memTotal: number;
  memUsed: number;
  memPct: number;
  pressure?: number; // macOS: 1 normal, 2 warning, 4 critical
  disk: Disk; // the data volume
  root?: Disk; // the system disk, when it is a separate one
  uptimeSec: number;
  warnings: string[]; // what is nearly full, in words
  idle?: IdleState;
  error?: string; // the machine didn't answer
}
/** A machine's stop-when-idle setting, and why it is stopped when it stopped itself. */
export interface IdleInfo {
  machine: string;
  offered: boolean;
  why?: string; // why it can't be turned on for this machine
  minutes: number; // 0 = off
  dryRun?: boolean;
  stoppedAt?: string;
  note?: string; // "Stopped after 2h idle at 03:10"
}
/** What a cloud machine costs, when the price of its size is known. */
export interface Cost {
  hourly: number;
  diskMonthly: number;
  upHours: number; // seen running this month
  soFar: number;
  month: number; // estimate for the whole month
  basis?: string; // the region the prices are for, when the machine is elsewhere
}
export interface HealthView {
  health: Record<string, Health>;
  idle: Record<string, IdleInfo>;
  cost: Record<string, Cost>;
  choices: number[]; // idle limits to offer, in minutes
  at: string;
}

const g = Go as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
/** Calls a Go method bound on the App by name. Feature modules use this for their own API. */
export function call<T>(name: string, ...args: unknown[]): Promise<T> {
  return g[name](...args) as Promise<T>;
}

export const api = {
  info: () => call<AppInfo>("Info"),
  machines: () => call<MachineView[]>("Machines"),
  refreshMachines: () => call<MachineView[]>("RefreshMachines"),
  providerStatuses: (force = false) => call<ProviderStatus[]>("ProviderStatuses", force),
  catalog: (provider: string) => call<Catalog>("Catalog", provider),
  fillSpec: (s: Partial<Spec>) => call<Spec>("FillSpec", s),

  login: (provider: string) => call<string>("Login", provider),
  createMachine: (s: Spec) => call<string>("CreateMachine", s),
  addMachine: (s: AddSpec) => call<string>("AddMachine", s),
  startMachine: (n: string) => call<string>("StartMachine", n),
  stopMachine: (n: string) => call<string>("StopMachine", n),
  restartMachine: (n: string) => call<string>("RestartMachine", n),
  resizeMachine: (n: string, size: string) => call<string>("ResizeMachine", n, size),
  growDisk: (n: string, gb: number) => call<string>("GrowDisk", n, gb),
  deleteMachine: (n: string, keepDisk: boolean) => call<string>("DeleteMachine", n, keepDisk),
  joinTailscale: (n: string) => call<string>("JoinTailscale", n),
  cancelOp: (id: string) => call<void>("CancelOp", id),
  ops: () => call<OpInfo[]>("Ops"),

  connect: (n: string) => call<void>("Connect", n),
  copy: (s: string) => call<void>("CopyText", s),
  openURL: (u: string) => call<void>("OpenURL", u),
  reveal: (p: string) => call<void>("Reveal", p),
  ports: (n: string) => call<Port[]>("Ports", n),
  openPort: (n: string, port: number, browser = true) => call<Tunnel>("OpenPort", n, port, browser),
  tunnels: () => call<Tunnel[]>("Tunnels"),
  closeTunnel: (id: string) => call<void>("CloseTunnel", id),
  tailscale: () => call<TailscaleInfo>("TailscaleStatus"),
  setTailscaleKey: (k: string) => call<void>("SetTailscaleAuthKey", k),

  sync: (names: string[], only: string[] = []) => call<string>("SyncMachines", names, only),
  setSyncItems: (n: string, items: string[]) => call<void>("SetSyncItems", n, items),
  lastSyncAll: () => call<Record<string, SyncResult>>("LastSyncAll"),
  credentials: () => call<Credential[]>("Credentials"),
  closeShell: (machine: string, session: string) => call<void>("CloseShell", machine, session),
  apiKeys: () => call<APIKeyView[]>("APIKeys"),
  apiProviders: () => call<APIProvider[]>("APIProviders"),
  setAPIKey: (name: string, value: string, provider: string, machines: string[] | null) => call<string>("SetAPIKey", name, value, provider, machines),
  removeAPIKey: (name: string) => call<string>("RemoveAPIKey", name),
  setAPIKeySync: (name: string, on: boolean) => call<string>("SetAPIKeySync", name, on),
  setAPIKeyMachines: (name: string, machines: string[] | null) => call<string>("SetAPIKeyMachines", name, machines),
  testAPIKey: (name: string) => call<KeyTest>("TestAPIKey", name),
  claudeAccounts: () => call<ClaudeAccountView[]>("ClaudeAccounts"),
  addClaudeAccount: (label: string, token: string, use: boolean) => call<string>("AddClaudeAccount", label, token, use),
  removeClaudeAccount: (id: string) => call<void>("RemoveClaudeAccount", id),
  claudeAccountToken: (id: string) => call<string>("ClaudeAccountToken", id),
  copyClaudeAccountToken: (id: string) => call<void>("CopyClaudeAccountToken", id),
  renameClaudeAccount: (id: string, label: string) => call<void>("RenameClaudeAccount", id, label),
  moveClaudeAccount: (id: string, delta: number) => call<void>("MoveClaudeAccount", id, delta),
  setClaudeAccountEnabled: (id: string, on: boolean) => call<void>("SetClaudeAccountEnabled", id, on),
  useClaudeAccount: (id: string) => call<string>("UseClaudeAccount", id),
  checkClaudeAccounts: () => call<string>("CheckClaudeAccounts"),
  claudeAutoSwitch: () => call<boolean>("ClaudeAutoSwitch"),
  claudeStrategy: () => call<"smart" | "order">("ClaudeStrategy"),
  setClaudeStrategy: (s: "smart" | "order") => call<void>("SetClaudeStrategy", s),
  claudeSource: () => call<"pool" | "login">("ClaudeSource"),
  setClaudeSource: (s: "pool" | "login") => call<void>("SetClaudeSource", s),
  claudeLocalLogin: () => call<LocalLogin | null>("ClaudeLocalLogin"),
  setClaudeAutoSwitch: (on: boolean) => call<void>("SetClaudeAutoSwitch", on),
  claude: () => call<ClaudeStatus>("ClaudeStatus"),
  mintClaude: () => call<string>("MintClaudeToken"),
  setClaudeToken: (t: string) => call<void>("SetClaudeToken", t),

  links: () => call<Link[]>("Links"),
  addLink: (l: Partial<Link>) => call<Link>("AddLink", l),
  removeLink: (id: string) => call<void>("RemoveLink", id),
  runLink: (id: string) => call<string>("RunLink", id),
  setLinkWatch: (id: string, on: boolean) => call<void>("SetLinkWatch", id, on),
  watchedLinks: () => call<string[]>("WatchedLinks"),
  push: (n: string, local: string, remote: string, o: FolderOptions) => call<string>("Push", n, local, remote, o),
  pull: (n: string, remote: string, local: string, o: FolderOptions) => call<string>("Pull", n, remote, local, o),
  clone: (n: string, repo: string, dir: string) => call<string>("Clone", n, repo, dir),
  pickFolder: (title: string) => call<string>("PickFolder", title),
  pickFile: (title: string) => call<string>("PickFile", title),

  settings: () => call<Settings>("Settings"),
  saveSettings: (s: Settings) => call<void>("SaveSettings", s),

  sessions: () => call<SessionsView>("Sessions"),
  newSession: (machine: string, o: SessionOptions) => call<Session>("NewSession", machine, o),
  killSession: (machine: string, session: string) => call<void>("KillSession", machine, session),

  openTerminal: (machine: string, session: string, cols: number, rows: number) =>
    call<TermInfo>("OpenTerminal", machine, session, cols, rows),
  openLocalTerminal: (cols: number, rows: number) => call<TermInfo>("OpenLocalTerminal", cols, rows),
  closeTerminal: (id: string) => call<void>("CloseTerminal", id),
  terminal: (id: string) => call<TermInfo>("Terminal", id),
  notify: (t: string, b: string) => call<void>("Notify", t, b),

  openSessionTerminal: (machine: string, session: string, o: AttachOptions, cols: number, rows: number) => call<TermInfo>("OpenSessionTerminal", machine, session, o, cols, rows),
  windowSessions: (keys: string[]) => call<void>("WindowSessions", keys),
  paneGit: (machine: string, dir: string) => call<GitInfo>("PaneGit", machine, dir),
  sessionPorts: (machine: string) => call<Record<string, Port[]>>("SessionPorts", machine),
  listFiles: (machine: string, dir: string) => call<string[]>("ListFiles", machine, dir),
  findFile: (machine: string, session: string, dir: string, name: string) => call<RemoteFile[]>("FindFile", machine, session, dir, name),
  recentFiles: (machine: string, session: string, dir: string) => call<FilesView>("RecentFiles", machine, session, dir),
  listDir: (machine: string, dir: string) => call<RemoteFile[]>("ListDir", machine, dir),
  peekFile: (machine: string, f: RemoteFile) => call<PeekView>("PeekFile", machine, f),
  openPeeked: (path: string) => call<void>("OpenPeeked", path),
  revealPeeked: (path: string) => call<void>("RevealPeeked", path),
  savePeeked: (path: string) => call<string>("SavePeeked", path),
  openScreen: (machine: string) => call<ScreenView>("OpenScreen", machine),
  saveScreenLogin: (machine: string, user: string, password: string) => call<void>("SaveScreenLogin", machine, user, password),
  clipboardText: () => call<string>("ClipboardText"),
  claudePreciseScroll: () => call<boolean>("ClaudePreciseScroll"),
  claudeMoveSessions: () => call<boolean>("ClaudeMoveSessions"),
  setClaudeMoveSessions: (on: boolean) => call<void>("SetClaudeMoveSessions", on),
  setClaudePreciseScroll: (on: boolean) => call<void>("SetClaudePreciseScroll", on),
  restartClaude: (machine: string, session: string, sid: string, flags: string) => call<void>("RestartClaude", machine, session, sid, flags),
  localTmux: () => call<LocalTmuxInfo>("LocalTmux"),
  installTmux: () => call<string>("InstallTmux"),
  installClaude: () => call<string>("InstallClaude"),
  openAtLogin: () => call<boolean>("OpenAtLogin"),
  setAppIcon: (id: string) => call<void>("SetAppIcon", id),
  setOpenAtLogin: (on: boolean) => call<void>("SetOpenAtLogin", on),
  openLocalTerminalIn: (dir: string, claude: boolean, cols: number, rows: number) => call<TermInfo>("OpenLocalTerminalIn", dir, claude, cols, rows),
  terminalInfo: (id: string) => call<TermProbe>("TerminalInfo", id),
  windowInfo: () => call<WindowInfo>("WindowInfo"),
  newWindow: () => call<void>("NewWindow"),
  updateInfo: () => call<UpdateInfo>("UpdateInfo"),
  checkForUpdates: () => call<UpdateInfo>("CheckForUpdates"),
  setAutoUpdate: (on: boolean) => call<void>("SetAutoUpdate", on),
  restartToUpdate: () => call<void>("RestartToUpdate"),
  newWindowWith: (layout: string) => call<void>("NewWindowWith", layout),
  windowLayout: () => call<string>("WindowLayout"),
  saveWindowLayout: (layout: string) => call<void>("SaveWindowLayout", layout),
  windowsCleared: (ids: string[]) => call<void>("WindowsCleared", ids),
  focusSession: (machine: string, session: string) => call<boolean>("FocusSession", machine, session),
  takeSession: (machine: string, session: string) => call<boolean>("TakeSession", machine, session),
  nextWindow: () => call<void>("NextWindow"),
  saveWindowFrame: () => call<void>("SaveWindowFrame"),

  machineHealth: () => call<HealthView>("MachineHealth"),
  refreshHealth: () => call<HealthView>("RefreshHealth"),
  setIdle: (machine: string, minutes: number) => call<string>("SetIdle", machine, minutes),
  paneIntent: (machine: string) => call<boolean>("PaneIntent", machine),
};

export function on<T = unknown>(event: string, cb: (data: T, ...rest: unknown[]) => void): () => void {
  return EventsOn(event, cb as (...d: unknown[]) => void);
}

/** Error message from a rejected binding call (Wails rejects with a string). */
export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
