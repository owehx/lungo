// Sharing a pane's session with people on the tailnet (the person sharing), and the same
// panel for a session someone shared with you. See lib/collab.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Eye, Globe, Keyboard, Link2, LocateFixed, LogOut, UserPlus, Users, X } from "lucide-react";
import {
  CODE_CHARS,
  closeJoin,
  collabApi,
  copyLink,
  findPerson,
  firstName,
  initials,
  joinLink,
  knownJoin,
  normalCode,
  readInvite,
  shareOf,
  showCode,
  useJoinAsk,
  usePresence,
  useShareOf,
  type JoinAsk,
  type Member,
  type ShareView,
} from "../lib/collab";
import { api, errText, type Session } from "../lib/api";
import { closeTab, paneTitle, persistent, toast, type Tab } from "../lib/store";
import { cx, mod } from "../lib/util";
import { AgentIcon } from "./Brand";
import { Button, Kbd, Modal, Segmented, Spinner } from "./ui";

/** Someone's face (their Tailscale picture, else their initials) in their colour. */
export function Avatar({ m, size = 18, title }: { m: Member; size?: number; title?: string }) {
  const [bad, setBad] = useState(false);
  return (
    <span
      title={title ?? m.name + (m.device ? ` · ${m.device}` : "")}
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: m.color, fontSize: Math.round(size * 0.42), boxShadow: `0 0 0 1.5px var(--term-bg), 0 0 0 2.5px ${m.color}` }}
    >
      {m.avatar && !bad ? <img src={m.avatar} alt="" referrerPolicy="no-referrer" onError={() => setBad(true)} className="size-full object-cover" /> : initials(m.name)}
    </span>
  );
}

/** A few faces, overlapping; how many more after them. */
export function Avatars({ people, size = 16, max = 3 }: { people: Member[]; size?: number; max?: number }) {
  const shown = people.slice(0, max);
  return (
    <span className="flex items-center gap-0">
      {shown.map((m, i) => (
        <span key={m.id} style={{ marginLeft: i ? -size * 0.3 : 0, zIndex: shown.length - i }} className="relative">
          <Avatar m={m} size={size} />
        </span>
      ))}
      {people.length > max && <span className="ml-1 text-[10.5px] text-subtle tabular-nums">+{people.length - max}</span>}
    </span>
  );
}

/** A panel under a button, drawn over everything, gone on a click elsewhere or Esc. */
function Popover({ anchor, onClose, children, width = 300 }: { anchor: DOMRect; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The panel is zoomed (.z) like the rest of the app's chrome: measure where positions land.
    el.style.left = el.style.top = "0px";
    const a = el.getBoundingClientRect();
    el.style.left = el.style.top = "100px";
    const b = el.getBoundingClientRect();
    const kx = (b.left - a.left) / 100 || 1;
    const ky = (b.top - a.top) / 100 || 1;
    const x = Math.max(8, Math.min(anchor.right - a.width, window.innerWidth - 8 - a.width));
    const y = Math.min(anchor.bottom + 6, window.innerHeight - 8 - a.height);
    setPos({ left: (x - a.left) / kx, top: (Math.max(8, y) - a.top) / ky });
  }, [anchor]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      className={cx("z fixed z-[80] rounded-xl border border-line-strong bg-raised p-1 shadow-pop", pos ? "anim-in" : "invisible")}
      style={{ width, ...(pos ?? { left: 0, top: 0 }) }}
    >
      {children}
    </div>,
    document.body,
  );
}

function Row({ icon, label, hint, danger, onClick }: { icon: ReactNode; label: string; hint?: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx("flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] transition-colors", danger ? "text-bad hover:bg-[color-mix(in_srgb,var(--red)_12%,transparent)]" : "text-fg hover:bg-hover")}
    >
      <span className="flex w-4 justify-center text-subtle">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="text-[11px] text-subtle">{hint}</span>}
    </button>
  );
}

const Sep = () => <div className="my-1 h-px bg-line" />;

/** The others in a pane's session, a face each: a click shows where they are on it. */
function Faces({ tab, people, size = 15, max = 3 }: { tab: Tab; people: Member[]; size?: number; max?: number }) {
  const shown = people.slice(0, max);
  return (
    <span className="flex items-center">
      {shown.map((m, i) => (
        <button
          key={m.id}
          onClick={(e) => {
            e.stopPropagation();
            findPerson(tab.key, m.id);
          }}
          onMouseDown={(e) => e.stopPropagation()} // not the start of dragging the pane
          className="relative flex rounded-full transition-transform duration-150 hover:z-10 hover:-translate-y-px"
          style={{ marginLeft: i ? -size * 0.3 : 0, zIndex: shown.length - i }}
        >
          <Avatar m={m} size={size} title={`${m.name}${m.device ? ` · ${m.device}` : ""}${m.host ? " · sharing" : ""}\nClick to see where they are`} />
        </button>
      ))}
      {people.length > max && <span className="ml-1 text-[10.5px] text-subtle tabular-nums">+{people.length - max}</span>}
    </span>
  );
}

/** One person in the panel: who, on what, and (for the person sharing) what they may do. A
 *  click on someone else shows where they are. */
function PersonRow({ m, you, onFind, onRole, onRemove }: { m: Member; you?: boolean; onFind?: () => void; onRole?: () => void; onRemove?: () => void }) {
  const find = !you && onFind;
  return (
    <div className="group/p flex h-8 items-center gap-1 rounded-md pr-2 pl-1">
      <button
        type="button"
        disabled={!find}
        onClick={find || undefined}
        title={find ? `Show where ${firstName(m.name)} is` : undefined}
        className={cx("flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left", find && "transition-colors hover:bg-hover")}
      >
        <Avatar m={m} size={18} title="" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">
          {m.name}
          <span className="text-subtle">{you ? " · you" : m.device ? ` · ${m.device}` : ""}</span>
        </span>
        {find && <LocateFixed size={12} className="shrink-0 text-subtle opacity-0 transition-opacity group-hover/p:opacity-100" />}
      </button>
      {m.host ? (
        <span className="text-[11px] text-subtle">sharing</span>
      ) : onRole ? (
        <button
          onClick={onRole}
          title={m.canType ? "Make them watch only" : "Let them type"}
          className="flex h-[22px] items-center gap-1 rounded-md border border-line-strong px-1.5 text-[11px] text-muted transition-colors hover:border-[var(--subtle)] hover:text-fg"
        >
          {m.canType ? <Keyboard size={11} /> : <Eye size={11} />}
          {m.canType ? "Can type" : "Watching"}
        </button>
      ) : (
        <span className="text-[11px] text-subtle">{m.canType ? "can type" : "watching"}</span>
      )}
      {onRemove && !m.host && (
        <button onClick={onRemove} title={`Remove ${firstName(m.name)}`} className="flex size-5 items-center justify-center rounded text-subtle opacity-0 transition-opacity group-hover/p:opacity-100 hover:bg-active hover:text-fg">
          <X size={11} />
        </button>
      )}
    </div>
  );
}

/** A code as six tiles, 7KX-4PQ: as the person sharing sees it, and where the others type it. */
export function CodeTiles({ code, caret, state }: { code: string; caret?: number; state?: "busy" | "error" }) {
  const chars = [...code.padEnd(6).slice(0, 6)];
  return (
    <span className="code-tiles" data-state={state}>
      {chars.map((ch, i) => (
        <Fragment key={i}>
          {i === 3 && <span className="code-dash" />}
          <span className="code-tile" style={{ ["--i" as string]: i }} data-on={caret === i || undefined} data-filled={ch.trim() ? "" : undefined}>
            {ch.trim()}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** The panel for a pane's own session, once it is shared: its code and link (one to type
 *  along, one to watch), who is in it, what they may do. */
function SharePanel({ tab, view, fresh, anchor, onClose }: { tab: Tab; view: ShareView; fresh: boolean; anchor: DOMRect; onClose: () => void }) {
  const share = useShareOf(tab);
  const guests = share?.people.filter((m) => !m.host) ?? [];
  const me = share?.people.find((m) => m.host);
  const [role, setRole] = useState<"edit" | "view">("edit");
  // Sharing it just now copied the link: say so.
  const [copied, setCopied] = useState<"link" | "code" | null>(fresh ? "link" : null);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(null), 2600);
    return () => window.clearTimeout(t);
  }, [copied]);
  const code = role === "edit" ? view.editCode : view.viewCode;
  const copy = (what: "link" | "code") => {
    const text = what === "code" ? code : role === "edit" ? view.editLink : view.viewLink;
    void api.copy(text).then(() => setCopied(what));
  };
  const act = (p: Promise<unknown>, what: string) => p.catch((e) => toast("error", what, errText(e)));
  return (
    <Popover anchor={anchor} onClose={onClose} width={308}>
      <div className="flex items-center gap-2 px-2 pt-1.5 pb-1">
        <span className="share-live" />
        <span className="text-[12.5px] font-medium text-fg">Sharing on your tailnet</span>
        <span className="ml-auto text-[11px] text-subtle">{guests.length ? `${guests.length} with you` : "nobody yet"}</span>
      </div>
      <div className="mx-1 mt-1 rounded-lg border border-line bg-[color-mix(in_srgb,var(--fg)_2.5%,transparent)] px-3 pt-2.5 pb-3">
        <div className="flex justify-center">
          <Segmented
            value={role}
            onChange={(r) => {
              setRole(r);
              setCopied(null);
            }}
            options={[
              { value: "edit", label: <span className="flex items-center gap-1"><Keyboard size={11} />Can type</span> },
              { value: "view", label: <span className="flex items-center gap-1"><Eye size={11} />Watch only</span> },
            ]}
          />
        </div>
        <button type="button" onClick={() => copy("code")} title="Copy the code" className="group/code mt-3 flex w-full flex-col items-center gap-1.5 rounded-lg py-0.5">
          <CodeTiles code={normalCode(code)} />
          <span className={cx("flex h-4 items-center gap-1 text-[11px] transition-colors", copied === "code" ? "text-ok" : "text-subtle group-hover/code:text-muted")}>
            {copied === "code" ? <><Check size={11} />Code copied</> : "The code to tell them"}
          </span>
        </button>
        <Button variant="primary" className="mt-2 w-full" icon={copied === "link" ? <Check size={13} /> : <Link2 size={13} />} onClick={() => copy("link")}>
          {copied === "link" ? "Link copied" : "Copy link"}
        </Button>
      </div>
      <div className="px-2 pt-2 pb-1 text-[11.5px] leading-snug text-subtle">
        They click the link, or press <Kbd>⇧{mod}J</Kbd> in Lungo and type the code. {role === "edit" ? "They can type here, as you." : "They see it and open its ports."}
      </div>
      {(me || guests.length > 0) && (
        <>
          <Sep />
          {me && <PersonRow m={me} you />}
          {guests.map((m) => (
            <PersonRow
              key={m.id}
              m={m}
              onFind={() => {
                onClose();
                findPerson(tab.key, m.id);
              }}
              onRole={() => act(collabApi.setRole(view.id, m.who, !m.canType), "Couldn't change that")}
              onRemove={() => act(collabApi.remove(view.id, m.who), `Couldn't remove ${firstName(m.name)}`)}
            />
          ))}
        </>
      )}
      <Sep />
      <Row
        icon={<X size={13} />}
        label="Stop sharing"
        danger
        onClick={() => {
          onClose();
          act(collabApi.stop(view.id), "Couldn't stop sharing").then(() => toast("info", "Stopped sharing", "The code and links don't work any more; everyone in it was seen out."));
        }}
      />
    </Popover>
  );
}

/** The share button on a pane whose session can be shared (it runs in tmux, here or on a
 *  machine). One click shares it, copies its link and shows its code. */
export function ShareButton({ tab, session, className }: { tab: Tab; session?: Session; className?: string }) {
  const share = useShareOf(tab);
  const [open, setOpen] = useState<{ anchor: DOMRect; view: ShareView; fresh: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  if (tab.kind === "joined" || !persistent(tab)) return null;
  void session;
  const guests = share?.people.filter((m) => !m.host) ?? [];
  const click = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (open) return setOpen(null);
    if (busy) return;
    const anchor = e.currentTarget.getBoundingClientRect();
    const fresh = !share;
    setBusy(true);
    const view = await shareOf(tab, paneTitle(tab));
    setBusy(false);
    if (!view) return;
    if (fresh) await copyLink(view, "edit").catch(() => {});
    setOpen({ anchor, view, fresh });
  };
  return (
    <>
      {guests.length > 0 && <Faces tab={tab} people={guests} />}
      <button
        title={share ? (guests.length ? `With ${guests.map((m) => firstName(m.name)).join(", ")}: the code, who may type` : "Shared on your tailnet: the code and link") : "Share this session: a link and a code for people on your tailnet"}
        onClick={(e) => void click(e)}
        onMouseDown={(e) => e.stopPropagation()} // not the start of dragging the pane
        className={cx("flex items-center justify-center rounded text-subtle transition-colors hover:bg-active hover:text-fg", share && "text-accent", className ?? "size-5")}
      >
        {busy ? <Spinner size={12} /> : share ? <Users size={13} /> : <UserPlus size={13} />}
      </button>
      {open && <SharePanel tab={tab} view={open.view} fresh={open.fresh} anchor={open.anchor} onClose={() => setOpen(null)} />}
    </>
  );
}

/** A joined pane's button: who is in it, what you may do, the link, leaving. */
export function JoinedButton({ tab, className }: { tab: Tab; className?: string }) {
  const people = usePresence(tab.key, (s) => s.people) ?? [];
  const you = usePresence(tab.key, (s) => s.you);
  const role = usePresence(tab.key, (s) => s.role);
  const info = usePresence(tab.key, (s) => s.info);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (tab.kind !== "joined") return null;
  const others = people.filter((m) => m.id !== you);
  const host = people.find((m) => m.host);
  const by = firstName(host?.name ?? tab.join?.by);
  const code = knownJoin(tab.key)?.share.code || tab.join?.code;
  return (
    <>
      {others.length > 0 && <Faces tab={tab} people={others} />}
      <button
        title={`${by}'s session${role === "view" ? " · you're watching" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect());
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className={cx("flex items-center justify-center gap-1 rounded text-subtle transition-colors hover:bg-active hover:text-fg", role === "view" ? "h-5 px-1" : (className ?? "size-5"))}
      >
        {role === "view" && <Eye size={12} />}
        <Users size={13} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div className="px-2 pt-1.5 pb-1">
            <div className="text-[12.5px] font-medium text-fg">{by}'s session</div>
            <div className="mt-0.5 text-[11.5px] leading-snug text-subtle">
              {[info?.where, info?.folder, info?.branch && info.branch !== "main" ? info.branch : ""].filter(Boolean).join(" · ") || "Shared with you over Tailscale"}
              {role === "view" ? ". You're watching." : ". You can type in it."}
            </div>
          </div>
          <Sep />
          {people.map((m) => (
            <PersonRow
              key={m.id}
              m={m}
              you={m.id === you}
              onFind={() => {
                setAnchor(null);
                findPerson(tab.key, m.id);
              }}
            />
          ))}
          <Sep />
          <Row
            icon={<Link2 size={13} />}
            label="Copy invite link"
            hint={code}
            onClick={() => {
              setAnchor(null);
              const link = code ? `lungo://join/${code}` : tab.join?.link;
              if (link) void api.copy(link).then(() => toast("info", "Invite link copied", code ? `Anyone on ${by}'s tailnet can join with it, or with the code ${code}.` : `Anyone on ${by}'s tailnet who has it can join.`));
            }}
          />
          <Row
            icon={<LogOut size={13} />}
            label="Leave"
            onClick={() => {
              setAnchor(null);
              closeTab(tab.key);
            }}
          />
        </Popover>
      )}
    </>
  );
}

/** The icon of a joined pane: the agent in the session, else people. */
export function JoinedIcon({ tab, size = 13 }: { tab: Tab; size?: number }) {
  const agent = usePresence(tab.key, (s) => s.info?.agent);
  return agent ? <AgentIcon agent={agent} size={size} /> : <Users size={size} className="text-subtle" />;
}

const chip =
  "flex h-[22px] max-w-full min-w-0 items-center gap-1.5 rounded-md border border-line-strong px-2 text-[11.5px] text-muted transition-colors hover:border-[var(--subtle)] hover:text-fg";

/** Under a joined pane: whose it is and where, and the ports it listens on, open here. */
export function JoinedFooter({ tab, height }: { tab: Tab; height: number }) {
  const info = usePresence(tab.key, (s) => s.info);
  const ports = usePresence(tab.key, (s) => s.ports) ?? [];
  const forwarded = usePresence(tab.key, (s) => s.forwarded) ?? {};
  const host = usePresence(tab.key, (s) => s.people.find((m) => m.host));
  const where = [info?.where, info?.folder].filter(Boolean).join(" · ");
  return (
    <div className="z flex shrink-0 items-center gap-1.5 pr-1.5 pl-1.5" style={{ height, background: "var(--term-bg)" }}>
      <span className={cx(chip, "pointer-events-none")}>
        {host ? <Avatar m={host} size={13} /> : <Users size={12} className="shrink-0 text-subtle" />}
        <span className="truncate">
          {firstName(host?.name ?? tab.join?.by)}
          {where && <span className="text-subtle"> · {where}</span>}
        </span>
      </span>
      {ports.map((p) => {
        const addr = forwarded[p.port];
        return (
          <button
            key={p.port}
            onClick={() => addr && void api.openURL(addr)}
            title={addr ? `${p.process || "A program"} on port ${p.port}, open here at ${addr}` : `Opening port ${p.port} here…`}
            className={cx(chip, "shrink-0 tabular-nums", addr && "border-[color-mix(in_srgb,var(--accent)_55%,transparent)] text-fg")}
          >
            <Globe size={12} className={cx("shrink-0", addr ? "text-accent" : "text-subtle")} />
            {addr ? addr.replace(/^https?:\/\/localhost/, "") : p.port}
          </button>
        );
      })}
    </div>
  );
}

// ---------- joining ----------

/** The join box, when it is open (⇧⌘J, the palette, a link clicked in a chat). */
export function JoinHost() {
  const ask = useJoinAsk();
  return ask ? <JoinBox key={ask.n} ask={ask} /> : null;
}

const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? "" : ".") : s);

/** Type the code they gave you (it joins as the sixth character goes in), or paste their link. */
function JoinBox({ ask }: { ask: JoinAsk }) {
  const first = readInvite(ask.value);
  const [code, setCode] = useState(first.code ?? "");
  const [link, setLink] = useState(first.link ?? ""); // a whole link: it says where already
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [why, setWhy] = useState("");
  const [focused, setFocused] = useState(true);
  const [clip, setClip] = useState(ask.clip); // still what was on the clipboard
  const input = useRef<HTMLInputElement>(null);
  const busy = state === "busy";

  const go = async (to: { code?: string; link?: string } = { code, link }) => {
    const what = to.link || (to.code?.length === 6 ? showCode(to.code) : "");
    if (!what || busy) return;
    setState("busy");
    setWhy("");
    try {
      await joinLink(what);
      closeJoin();
    } catch (e) {
      setState("error");
      setWhy(sentence(errText(e)));
      setLink("");
      window.requestAnimationFrame(() => input.current?.select());
    }
  };
  useEffect(() => {
    input.current?.focus();
    input.current?.select(); // typing replaces what it opened with
    if (ask.go) void go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const typed = (v: string) => {
    if (busy) return;
    // A link, or a message with one in it, pasted: take the invite out of it.
    if (/lungo:\/\//i.test(v) || v.length > 8) {
      const inv = readInvite(v);
      if (inv.link || inv.code) {
        setLink(inv.link ?? "");
        setCode(inv.code ?? "");
        void go(inv);
        return;
      }
    }
    const c = [...v.toUpperCase()].filter((ch) => CODE_CHARS.includes(ch)).join("").slice(0, 6);
    setCode(c);
    setLink("");
    setClip(false);
    if (state === "error") setState("idle");
    if (c.length === 6 && c !== code) void go({ code: c });
  };

  const tiles: "busy" | "error" | undefined = busy ? "busy" : state === "error" ? "error" : undefined;
  return (
    <Modal open onClose={closeJoin} width={400}>
      <div className="relative px-6 pt-6 pb-4 text-center">
        <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Users size={18} />
        </div>
        <div className="text-[15px] font-semibold text-fg">Join a session</div>
        <div className="mt-1 text-[12.5px] text-muted">Type the code they gave you, or paste their link.</div>
        {link ? (
          <div className="mx-auto mt-5 flex h-[42px] max-w-full items-center justify-center gap-2 rounded-lg border border-line-strong bg-[var(--bg)] px-3">
            <Link2 size={13} className="shrink-0 text-subtle" />
            <span className="min-w-0 truncate font-mono text-[12px] text-muted">{link.replace(/\?.*$/, "")}</span>
          </div>
        ) : (
          <label className="relative mt-5 inline-flex cursor-text" onMouseDown={() => window.requestAnimationFrame(() => input.current?.focus())}>
            <CodeTiles code={code} caret={focused && !tiles ? Math.min(code.length, 5) : undefined} state={tiles} />
          </label>
        )}
        <input
          ref={input}
          value={link || code}
          onChange={(e) => typed(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void go();
            }
          }}
          aria-label="The code or link"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="pointer-events-none absolute size-px opacity-0"
        />
        <div className="mx-auto mt-3.5 flex min-h-[36px] max-w-[330px] items-start justify-center text-[12px] leading-snug">
          {busy ? (
            <span className="inline-flex items-center gap-1.5 text-muted">
              <Spinner size={12} />
              {link ? "Joining…" : "Looking for it on your tailnet…"}
            </span>
          ) : state === "error" ? (
            <span className="text-bad">{why}</span>
          ) : clip ? (
            <span className="text-muted">From your clipboard. Press Join, or type another code.</span>
          ) : (
            <span className="text-subtle">A code looks like 7KX-4PQ. It goes over Tailscale, straight to their computer.</span>
          )}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
        <Button variant="ghost" onClick={closeJoin}>
          Cancel
        </Button>
        <Button variant="primary" loading={busy} disabled={!link && code.length < 6} onClick={() => void go()}>
          Join
        </Button>
      </div>
    </Modal>
  );
}
