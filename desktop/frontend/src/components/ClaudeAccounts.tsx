// The Claude account pool: who machines sign in as, who is up next, how much of each usage
// window is left, and adding accounts (browser sign-in or a pasted `claude setup-token` token).
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, Copy, Eye, Globe, KeyRound, MoreHorizontal, Pencil, Plus, Power, RefreshCw, Trash2 } from "lucide-react";
import { api, errText, type ClaudeAccountView, type ClaudeStatus, type LocalLogin, type UsageWindow } from "../lib/api";
import { getState, runOp, setState, toast, useStore } from "../lib/store";
import { ago, cx } from "../lib/util";
import { Button, Field, IconButton, Input, Menu, Modal, ModalHeader, Segmented, Spinner, Toggle, useNow, GROUP, GROUP_ROW } from "./ui";
import { BrandIcon } from "./Brand";

export function useClaudeAccounts() {
  const accounts = useStore((s) => s.claudeAccounts);
  useEffect(() => {
    if (getState().claudeAccounts === null) api.claudeAccounts().then((a) => setState({ claudeAccounts: a ?? [] })).catch(() => setState({ claudeAccounts: [] }));
  }, []);
  return accounts;
}

const reload = () => api.claudeAccounts().then((a) => setState({ claudeAccounts: a ?? [] }));

const list0 = (a: ClaudeAccountView[] | null) => a ?? [];
const lower = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

export function when(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!t) return "";
  const mins = Math.round((t - now) / 60000);
  if (mins <= 0) return "now";
  if (mins < 60) return `in ${mins}m`;
  if (mins < 24 * 60) return `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  return new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** The token works, but the account's organization doesn't let subscriptions use Claude Code. */
const orgBlocked = (v: ClaudeAccountView) => v.status.state === "invalid" && /organization has disabled/i.test(v.status.message ?? "");

const limitedNow = (v: ClaudeAccountView, now: number) => v.status.state === "limited" && !!v.status.resetsAt && new Date(v.status.resetsAt).getTime() > now;

/** A slim usage meter: "5h ▬▬▬ 3%" with the reset time underneath. */
function Meter({ label, w, now }: { label: string; w?: UsageWindow; now: number }) {
  const pct = w ? Math.round(w.utilization * 100) : null;
  const tone = pct === null ? "bg-active" : pct >= 100 ? "bg-bad" : pct >= 80 ? "bg-warn" : "bg-ok";
  return (
    <div className="w-[132px]">
      <div className="flex items-center gap-2">
        <span className="w-[30px] shrink-0 text-[11px] text-subtle">{label}</span>
        <div className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-active">
          <div className={cx("h-full rounded-full transition-[width] duration-500", tone)} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
        </div>
        <span className={cx("w-[32px] shrink-0 text-right text-[11px] tabular-nums", pct !== null && pct >= 100 ? "font-medium text-bad" : "text-muted")}>{pct === null ? "–" : `${pct}%`}</span>
      </div>
      <div className="mt-0.5 h-[14px] truncate pl-[38px] text-[10.5px] text-subtle">{w?.resetsAt && pct ? `resets ${when(w.resetsAt, now)}` : ""}</div>
    </div>
  );
}

/** The one-word state of an account: in use, up next, standby, limited… */
function Role({ v, now }: { v: ClaudeAccountView; now: number }) {
  const pill = (cls: string, dot: string, text: string, title?: string) => (
    <span title={title} className={cx("inline-flex h-[22px] items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-medium whitespace-nowrap", cls)}>
      <span className={cx("size-1.5 rounded-full", dot)} />
      {text}
    </span>
  );
  const limited = limitedNow(v, now);
  if (v.account.disabled) return pill("bg-active text-subtle", "bg-subtle", "Off");
  if (!v.hasToken) return pill("bg-[color-mix(in_srgb,var(--red)_12%,transparent)] text-bad", "bg-bad", "No token");
  if (orgBlocked(v)) return pill("bg-active text-muted", "bg-bad", "Turned off by its org", `${v.status.message} Signing in again won't change this; an admin of that organization can.`);
  if (v.status.state === "invalid") return pill("bg-[color-mix(in_srgb,var(--red)_12%,transparent)] text-bad", "bg-bad", "Token rejected", v.status.message);
  if (limited) return pill("bg-[color-mix(in_srgb,var(--amber)_13%,transparent)] text-warn", "bg-warn", `Limited · back ${when(v.status.resetsAt, now)}`);
  if (v.active) return pill("bg-[color-mix(in_srgb,var(--green)_13%,transparent)] text-ok", "bg-ok", "In use");
  if (v.next) return pill("bg-accent-soft text-accent", "bg-accent", "Up next");
  if (v.status.state === "error") return pill("bg-active text-muted", "bg-warn", "Check failed", v.status.message);
  return pill("bg-active text-muted", "bg-subtle", "Standby");
}

export function ClaudeAccountsSection() {
  const accounts = useClaudeAccounts();
  const now = useNow(30000);
  const ops = useStore((s) => s.ops);
  const opOrder = useStore((s) => s.opOrder);
  const [auto, setAuto] = useState<boolean | null>(null);
  const [move, setMove] = useState(true);
  const onOld = useStore((s) => s.sessions.sessions.filter((x) => x.oldLogin && x.claude).length);
  const [strategy, setStrategy] = useState<"smart" | "order">("smart");
  const [source, setSource] = useState<"pool" | "login">("pool");
  const [localLogin, setLocalLogin] = useState<LocalLogin | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<ClaudeAccountView | null>(null);
  const [removing, setRemoving] = useState<ClaudeAccountView | null>(null);
  const [showing, setShowing] = useState<ClaudeAccountView | null>(null);
  useEffect(() => {
    api.claudeAutoSwitch().then(setAuto).catch(() => setAuto(true));
    api.claudeMoveSessions().then(setMove).catch(() => {});
    api.claudeStrategy().then(setStrategy).catch(() => {});
    api.claudeSource().then(setSource).catch(() => {});
  }, []);
  // Who this Mac's Claude Code is signed in to changes with /login; the list is sent again then.
  useEffect(() => {
    api.claudeLocalLogin().then(setLocalLogin).catch(() => setLocalLogin(null));
    api.claudeSource().then(setSource).catch(() => {});
  }, [accounts]);
  const follow = source === "login";
  const localNew = !!localLogin?.email && !localLogin.accountId;
  const smart = strategy === "smart";
  const autoOn = auto ?? true;
  const suggested = list0(accounts).find((v) => v.suggest);
  const checking = opOrder.some((id) => ops[id]?.info.running && ops[id]?.info.kind === "claude-check");
  const addingNow = opOrder.some((id) => ops[id]?.info.running && ops[id]?.info.kind === "claude-account");
  const list = accounts ?? [];
  const active = list.find((v) => v.active);
  const next = list.find((v) => v.next);
  const allLimited = list.length > 0 && !list.some((v) => !v.account.disabled && v.hasToken && v.status.state !== "invalid" && !limitedNow(v, now));
  const firstReset = list
    .map((v) => v.status.resetsAt)
    .filter((x): x is string => !!x && new Date(x).getTime() > now)
    .sort()[0];
  const act = (p: Promise<unknown>) => p.then(reload).catch((e) => toast("error", "Couldn't update", errText(e)));

  let summary: React.ReactNode = null;
  if (active && follow) {
    const name = <b className="font-medium text-fg">{active.account.label || active.account.email}</b>;
    const mac = localLogin?.email ? <b className="font-medium text-fg">{localLogin.email}</b> : "this Mac's login";
    summary = localNew ? (
      <>
        Sessions here use {mac}, the account Claude Code on this Mac is signed in to. Machines stay on {name} until you add it.
      </>
    ) : (
      <>Sessions here and on machines use {mac}, the account Claude Code on this Mac is signed in to. /login in any session switches all of them.</>
    );
  } else if (active) {
    const name = <b className="font-medium text-fg">{active.account.label || active.account.email}</b>;
    if (allLimited) summary = <>Every account is at its limit{firstReset ? <>; the first is back {when(firstReset, now)}</> : null}. Add another to keep machines working.</>;
    else if (limitedNow(active, now)) summary = <>{name} is at its limit{next ? <>; machines are moving to <b className="font-medium text-fg">{next.account.label}</b></> : null}.</>;
    else if (next && smart) summary = <>Sessions use {name}: {lower(active.reason)}. Next in line is <b className="font-medium text-fg">{next.account.label}</b>.</>;
    else if (next) summary = <>Sessions use {name}. If it hits a limit they move to <b className="font-medium text-fg">{next.account.label}</b> and stuck sessions resume.</>;
    else if (list.length > 1) summary = <>Sessions use {name}. {list.length === 2 ? "The other account is" : "The others are"} at the limit{firstReset ? <>, back {when(firstReset, now)}</> : null}.</>;
    else summary = <>Sessions use {name}. Add a second account and they'll switch to it when this one hits a limit.</>;
    if (onOld > 0)
      summary = (
        <>
          {summary}{" "}
          {onOld === 1 ? "One session is" : `${onOld} sessions are`} still on the previous login: {move ? "each moves over as soon as it is idle." : "they move when Claude next starts in them."}
        </>
      );
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-4">
        <h2 className="text-[11px] font-semibold tracking-[0.06em] text-subtle uppercase">Claude</h2>
        <div className="flex items-center gap-1">
          <span
            className="mr-2"
            title="Rotation: sessions sign in with the accounts below, each signed in once, and switch when one hits a limit. This Mac's login: sessions use whatever account Claude Code on this Mac is signed in to; /login in any session switches them all."
          >
            <Segmented
              value={source}
              onChange={(v) => {
                setSource(v);
                api
                  .setClaudeSource(v)
                  .then(reload)
                  .catch((e) => {
                    setSource(v === "login" ? "pool" : "login");
                    toast("error", "Couldn't save", errText(e));
                  });
              }}
              options={[
                { value: "pool", label: "Rotation" },
                { value: "login", label: "This Mac's login" },
              ]}
            />
          </span>
          {!follow && (
            <span className="mr-2" title="Smart: use whichever account has the most allowance about to expire, so nothing goes to waste. My order: use them top to bottom.">
              <Segmented
                value={strategy}
                onChange={(v) => {
                  setStrategy(v);
                  api.setClaudeStrategy(v).then(reload).catch((e) => toast("error", "Couldn't save", errText(e)));
                }}
                options={[
                  { value: "smart", label: "Smart" },
                  { value: "order", label: "My order" },
                ]}
              />
            </span>
          )}
          {!follow && (
            <label className="mr-2 flex items-center gap-2 text-[12px] text-muted" title="Move machines to the best account automatically, and resume sessions stuck on a limit">
              Auto-switch
              <Toggle
                checked={auto ?? true}
                onChange={(on) => {
                  setAuto(on);
                  api.setClaudeAutoSwitch(on).catch((e) => toast("error", "Couldn't save", errText(e)));
                }}
              />
            </label>
          )}
          <label
            className="mr-2 flex items-center gap-2 text-[12px] text-muted"
            title="Claude reads its login when it starts. With this on, sessions already running move to the new account too: each is restarted with its conversation the moment it is idle (never while it works or while you type)."
          >
            Move sessions
            <Toggle
              checked={move}
              onChange={(on) => {
                setMove(on);
                api.setClaudeMoveSessions(on).catch((e) => {
                  setMove(!on);
                  toast("error", "Couldn't save", errText(e));
                });
              }}
            />
          </label>
          <IconButton label="Check usage now" disabled={checking || list.length === 0} onClick={() => runOp(api.checkClaudeAccounts())}>
            <RefreshCw size={13} className={checking ? "spin" : ""} />
          </IconButton>
          <Button size="xs" variant="outline" icon={<Plus size={12} />} onClick={() => setAdding(true)}>
            Add account
          </Button>
        </div>
      </div>

      <div className={GROUP}>
        {accounts === null ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : list.length === 0 ? (
          <button onClick={() => setAdding(true)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-hover">
            <span className="flex size-9 items-center justify-center rounded-[10px] border border-dashed border-line-strong">
              <BrandIcon name="claude" size={18} />
            </span>
            <span>
              <span className="block text-[13px] font-medium text-fg">Add your Claude account</span>
              <span className="block text-[12px] text-subtle">Sessions here and on machines sign in with it. Add more than one and they switch when one hits a limit.</span>
            </span>
          </button>
        ) : (
          <>
            {summary && (
              <div className={cx("px-4 py-2.5 text-[12px] leading-relaxed", allLimited ? "bg-[color-mix(in_srgb,var(--red)_7%,transparent)] text-bad" : "text-muted")}>{summary}</div>
            )}
            {localNew && !addingNow && (
              <div className="flex items-center gap-3 bg-accent-soft px-4 py-2 text-[12px] text-fg">
                <span className="min-w-0 flex-1">
                  Claude Code on this Mac is signed in to <b className="font-medium">{localLogin!.email}</b>, which isn't in this list. Add it once (one approval in your browser) and sessions can switch to it without signing in again.
                </span>
                <Button size="xs" variant="primary" onClick={() => setAdding(true)}>
                  Add
                </Button>
              </div>
            )}
            {suggested && !autoOn && !follow && (
              <div className="flex items-center gap-3 bg-accent-soft px-4 py-2 text-[12px] text-fg">
                <span className="min-w-0 flex-1">
                  Suggested: move machines to <b className="font-medium">{suggested.account.label || suggested.account.email}</b> ({lower(suggested.reason)}).
                </span>
                <Button size="xs" variant="primary" onClick={() => runOp(api.useClaudeAccount(suggested.account.id))}>
                  Switch
                </Button>
              </div>
            )}
            {list.map((v, i) => {
              const name = v.account.label || v.account.email || "Claude account";
              return (
                <div key={v.account.id} className={cx(GROUP_ROW, "group flex items-center gap-3.5 py-3 hover:bg-hover", v.account.disabled && "opacity-55")}>
                  <span className={cx("relative flex size-9 shrink-0 items-center justify-center rounded-[10px]", v.active && !limitedNow(v, now) ? "bg-[color-mix(in_srgb,var(--green)_14%,transparent)]" : "bg-[color-mix(in_srgb,var(--fg)_6%,transparent)]")}>
                    <BrandIcon name="claude" size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-semibold text-fg">{name}</span>
                      {v.plan && <span className="shrink-0 rounded-[5px] bg-[color-mix(in_srgb,var(--fg)_6%,transparent)] px-1.5 text-[10.5px] leading-[16px] font-medium text-muted">{v.plan}</span>}
                      {v.local && <span className="shrink-0 text-[10.5px] text-subtle" title="This Mac's Claude Code is signed in to this account">this Mac</span>}
                    </div>
                    <div className="truncate text-[11.5px] text-subtle" title={[v.person, v.org].filter(Boolean).join(" · ")}>
                      {v.account.email && v.account.email !== name ? `${v.account.email} · ` : ""}
                      {v.reason || "Not checked yet"}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-5" title={v.status.checkedAt && !v.status.checkedAt.startsWith("0001") ? `Checked ${ago(v.status.checkedAt, now) === "now" ? "just now" : `${ago(v.status.checkedAt, now)} ago`}` : "Not checked yet"}>
                    <Meter label="5h" w={v.status.windows?.five_hour} now={now} />
                    <Meter label="Week" w={v.status.windows?.seven_day} now={now} />
                  </div>
                  <div className="flex w-[190px] shrink-0 justify-end">
                    <Role v={v} now={now} />
                  </div>
                  <Menu
                    trigger={
                      <IconButton label="More" className="size-7">
                        <MoreHorizontal size={14} />
                      </IconButton>
                    }
                    items={[
                      { label: "Use now", icon: <Check size={13} />, hint: follow ? "turns on rotation" : undefined, disabled: (v.active && !follow) || v.account.disabled || !v.hasToken, onClick: () => runOp(api.useClaudeAccount(v.account.id)) },
                      { label: "Check usage", icon: <RefreshCw size={13} />, onClick: () => runOp(api.checkClaudeAccounts()) },
                      "sep",
                      { label: "Copy token", icon: <Copy size={13} />, disabled: !v.hasToken, onClick: () => copyToken(v) },
                      { label: "Show token…", icon: <Eye size={13} />, disabled: !v.hasToken, onClick: () => setShowing(v) },
                      "sep",
                      ...(smart
                        ? []
                        : [
                            { label: "Move up", icon: <ArrowUp size={13} />, disabled: i === 0, hint: "switch order", onClick: () => act(api.moveClaudeAccount(v.account.id, -1)) },
                            { label: "Move down", icon: <ArrowDown size={13} />, disabled: i === list.length - 1, onClick: () => act(api.moveClaudeAccount(v.account.id, 1)) },
                          ]),
                      { label: "Rename…", icon: <Pencil size={13} />, onClick: () => setRenaming(v) },
                      { label: v.account.disabled ? "Turn on" : "Turn off", icon: <Power size={13} />, hint: v.account.disabled ? undefined : "skip when switching", onClick: () => act(api.setClaudeAccountEnabled(v.account.id, !!v.account.disabled)) },
                      "sep",
                      { label: "Remove…", icon: <Trash2 size={13} />, danger: true, onClick: () => setRemoving(v) },
                    ]}
                  />
                </div>
              );
            })}
          </>
        )}
      </div>

      <AddClaudeAccount open={adding} onClose={() => setAdding(false)} />
      {renaming && <RenameAccount v={renaming} onClose={() => setRenaming(null)} />}
      {showing && <ShowToken v={showing} onClose={() => setShowing(null)} />}
      {removing && (
        <Modal open onClose={() => setRemoving(null)} width={420}>
          <ModalHeader title={`Remove ${removing.account.label || removing.account.email}?`} subtitle="Its token is deleted from your keychain. Sessions move to another account on the next sync." onClose={() => setRemoving(null)} icon={<Trash2 size={15} />} />
          <div className="flex justify-end gap-2 px-5 py-4">
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const id = removing.account.id;
                setRemoving(null);
                act(api.removeClaudeAccount(id));
              }}
            >
              Remove
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function AddClaudeAccount({ open, onClose }: { open: boolean; onClose: () => void }) {
  const accounts = useStore((s) => s.claudeAccounts) ?? [];
  const [mode, setMode] = useState<"browser" | "token">("browser");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [local, setLocal] = useState<ClaudeStatus | null>(null);
  const [use, setUse] = useState(true);
  useEffect(() => {
    if (!open) return;
    setLabel("");
    setToken("");
    setUse(true);
    api.claude().then(setLocal).catch(() => setLocal(null));
  }, [open]);
  const localIsNew = !!local?.signedIn && !!local.email && !accounts.some((a) => a.account.email === local.email);
  const submit = () => {
    if (mode === "token" && !token.trim().startsWith("sk-ant-oat01-")) {
      toast("error", "That isn't a Claude Code token", "Tokens start with sk-ant-oat01-. Make one with `claude setup-token`.");
      return;
    }
    runOp(api.addClaudeAccount(label.trim(), mode === "token" ? token.trim() : "", use));
    onClose();
  };
  return (
    <Modal open={open} onClose={onClose} width={480}>
      <ModalHeader title="Add a Claude account" subtitle="Sessions can switch to it when the one in use hits a limit." onClose={onClose} icon={<BrandIcon name="claude" size={16} />} />
      <form
        className="flex flex-col gap-4 px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "browser", label: "Sign in with browser" },
            { value: "token", label: "Paste a token" },
          ]}
        />
        {mode === "browser" ? (
          <div className="flex gap-3 rounded-lg bg-[color-mix(in_srgb,var(--fg)_6%,transparent)] px-3.5 py-3 text-[12px] leading-relaxed text-muted">
            <Globe size={15} className="mt-0.5 shrink-0 text-accent" />
            <div>
              Your browser opens claude.ai to approve a token for <b className="font-medium text-fg">the account it's signed in to</b>. To add a different one, switch accounts on claude.ai first.
              {local && !local.installed && <div className="mt-1.5 text-subtle">Claude Code isn't on this Mac yet: Lungo installs it first, which takes a minute.</div>}
              {localIsNew && (
                <div className="mt-1.5 text-subtle">
                  This Mac's Claude Code is on <span className="text-fg">{local!.email}</span>. If that's the one you approve, it's named automatically.
                </div>
              )}
            </div>
          </div>
        ) : (
          <Field label="Token" hint={<>Run <code className="font-mono">claude setup-token</code> on any computer signed in to that account and paste what it prints.</>}>
            <Input autoFocus mono value={token} onChange={(e) => setToken(e.target.value)} placeholder="sk-ant-oat01-…" />
          </Field>
        )}
        <Field label="Name (optional)" hint="Left empty, it's named from the account when this Mac is signed in to it.">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={localIsNew ? local!.email : "Work, Personal, team@company.com…"} />
        </Field>
        <label className="flex items-center justify-between gap-3 text-[12.5px] text-fg">
          <span>
            Use it now
            <span className="block text-[11.5px] text-subtle">Sessions here and on machines move to it as soon as it's added (running ones when idle).</span>
          </span>
          <Toggle checked={use} onChange={setUse} label="Use it now" />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={mode === "browser" ? <Globe size={13} /> : <KeyRound size={13} />}>
            {mode === "browser" ? "Open browser sign-in" : "Add account"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function copyToken(v: ClaudeAccountView) {
  const name = v.account.label || v.account.email || "the account";
  api
    .copyClaudeAccountToken(v.account.id)
    .then(() => toast("success", "Token copied", `${name}'s sk-ant-oat01-… token is on the clipboard.`))
    .catch((err) => toast("error", "Couldn't copy the token", errText(err)));
}

/** An account's raw token, to read or copy. */
function ShowToken({ v, onClose }: { v: ClaudeAccountView; onClose: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.claudeAccountToken(v.account.id).then(setToken).catch((err) => setError(errText(err)));
  }, [v.account.id]);
  return (
    <Modal open onClose={onClose} width={520}>
      <ModalHeader title={`${v.account.label || v.account.email || "Claude account"} token`} subtitle="Anyone with it can use this account. Claude Code reads it from CLAUDE_CODE_OAUTH_TOKEN." onClose={onClose} icon={<KeyRound size={15} />} />
      <div className="flex flex-col gap-3 px-5 py-4">
        {error ? (
          <div className="text-[12.5px] text-bad">{error}</div>
        ) : token === null ? (
          <Spinner />
        ) : (
          <code className="block rounded-[8px] bg-[color-mix(in_srgb,var(--fg)_6%,transparent)] px-3 py-2.5 font-mono text-[12px] leading-[18px] break-all text-fg select-all">{token}</code>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
          <Button variant="primary" icon={<Copy size={13} />} disabled={!token} onClick={() => copyToken(v)}>
            Copy
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function RenameAccount({ v, onClose }: { v: ClaudeAccountView; onClose: () => void }) {
  const [label, setLabel] = useState(v.account.label);
  return (
    <Modal open onClose={onClose} width={400}>
      <ModalHeader title="Rename account" onClose={onClose} icon={<Pencil size={15} />} />
      <form
        className="flex flex-col gap-3 px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          api
            .renameClaudeAccount(v.account.id, label)
            .then(reload)
            .catch((err) => toast("error", "Couldn't rename", errText(err)));
          onClose();
        }}
      >
        <Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** One line for the Sync page: who machines sign in as, and how much is left. */
export function ActiveClaudeLine() {
  const accounts = useClaudeAccounts();
  const now = useNow(30000);
  const active = accounts?.find((a) => a.active);
  if (!accounts) return null;
  if (!active) return <span className="text-fg">No Claude account yet. Add one so machines can sign in.</span>;
  const five = active.status.windows?.five_hour;
  const week = active.status.windows?.seven_day;
  const next = accounts.find((a) => a.next);
  return (
    <span className="text-muted">
      Sessions sign in as <b className="font-medium text-fg">{active.account.label || active.account.email}</b>
      {limitedNow(active, now) ? (
        <span className="text-warn"> · at its limit, back {when(active.status.resetsAt, now)}</span>
      ) : (
        <>
          {five && <span> · 5-hour {Math.round(five.utilization * 100)}%</span>}
          {week && <span> · weekly {Math.round(week.utilization * 100)}%</span>}
        </>
      )}
      <span className="text-subtle"> · {next ? `next: ${next.account.label || next.account.email}` : "no backup account"}</span>
    </span>
  );
}
