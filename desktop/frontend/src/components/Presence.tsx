// Everyone else in a shared session, drawn over its screen: where they point (an arrowhead in
// their colour, their name beside it while it moves), where they click, what they select (in
// their colour) and who is typing (their name at the cursor). It sits over the terminal and
// never takes the mouse. Positions are cells, and fractions of one, so they land on the same
// spot for everyone (a joined pane is drawn at the session's size).
//
// Pointers move many times a second: they are not React state. The connection keeps where
// each one is (lib/collab) and says when one moved; a frame loop here glides each drawn
// pointer to it, writing its position straight to the page, and stops when they all rest.
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { firstName, usePresence, usePresenceConn, type Member, type Sel } from "../lib/collab";
import { terminals } from "../lib/terminals";

const LABEL_FOR = 4000; // the name shows while the pointer moves, and this long after
const HIDE_AFTER = 30_000; // a pointer that hasn't moved this long goes
const TYPED_FOR = 1600; // how long "typing" shows after the last key
const FIND_FOR = 2700; // how long someone stands out after "where are they?" (three rings, index.css)
const GLIDE = 0.06; // seconds a pointer takes to catch up with where it was seen: smooths the network's bumps
const LABEL_X = 13; // where the name sits from the tip (index.css .pc-label)
const LABEL_Y = 16;

// An arrowhead, its tip at (1, 1).
const ARROW = "M1.037 1.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z";

interface Box {
  x: number; // the screen's offset in the layer
  y: number;
  cw: number; // a cell
  ch: number;
  cols: number;
  w: number; // the layer
  h: number;
  cursor: { x: number; y: number };
}

/** A drawn pointer, on its way to where it was seen. */
interface Glide {
  x: number;
  y: number;
  vx: number;
  vy: number;
  shown: boolean; // drawn somewhere: it glides from there (else it starts where it is seen)
  state: string;
  flip: string;
  findUntil: number;
  findTimer?: number;
}

export const PresenceLayer = memo(function PresenceLayer({ tabKey }: { tabKey: string }) {
  const conn = usePresenceConn(tabKey);
  const people = usePresence(tabKey, (s) => s.people);
  const you = usePresence(tabKey, (s) => s.you);
  const sels = usePresence(tabKey, (s) => s.sels);
  const typed = usePresence(tabKey, (s) => s.typed);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [, tick] = useState(0);
  const boxRef = useRef(box);
  boxRef.current = box;
  const fx = useRef<HTMLDivElement>(null); // clicks and "here they are", added and gone by themselves
  const cursors = useRef(new Map<string, HTMLDivElement>());
  const labels = useRef(new Map<string, { w: number; h: number }>());
  const wake = useRef(() => {});
  const now = Date.now();

  const others = (people ?? []).filter((m) => m.id !== you);
  const byId = new Map<string, Member>(others.map((m) => [m.id, m]));
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const typing = Object.entries(typed ?? {})
    .filter(([id, at]) => byId.has(id) && now - at < TYPED_FOR)
    .sort((a, b) => b[1] - a[1])[0];
  const anything = others.length > 0;

  // Where the screen is, and the size of a cell: again when the pane or its font changes,
  // and as the cursor moves while someone types.
  useEffect(() => {
    const t = terminals.get(tabKey);
    const screen = t?.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!t || !screen || !layer || !anything) return;
    const measure = () => {
      const s = screen.getBoundingClientRect();
      const l = layer.getBoundingClientRect();
      if (!t.cols || !t.rows || !s.width) return;
      const next: Box = { x: s.left - l.left, y: s.top - l.top, cw: s.width / t.cols, ch: s.height / t.rows, cols: t.cols, w: l.width, h: l.height, cursor: { x: t.buffer.active.cursorX, y: t.buffer.active.cursorY } };
      setBox((b) => (b && sameBox(b, next) ? b : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(screen);
    ro.observe(layer);
    const moved = t.onCursorMove(measure);
    const resized = t.onResize(measure);
    return () => {
      ro.disconnect();
      moved.dispose();
      resized.dispose();
    };
  }, [tabKey, layer, anything]);

  // The names' sizes, to keep each one inside the pane (it goes to the other side near an edge).
  useLayoutEffect(() => {
    for (const [id, el] of cursors.current) {
      const l = el.querySelector<HTMLElement>(".pc-label");
      if (l) labels.current.set(id, { w: l.offsetWidth, h: l.offsetHeight });
    }
    wake.current();
  });

  // The pointers, moved a frame at a time while any of them is on its way.
  useEffect(() => {
    if (!conn || !layer) return;
    const glides = new Map<string, Glide>();
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let timer = 0;
    let last = 0;
    const frame = (time: number) => {
      raf = 0;
      const dt = last ? Math.min(0.05, (time - last) / 1000) : 1 / 60;
      last = time;
      const b = boxRef.current;
      const t = Date.now();
      let moving = false;
      let next = Infinity; // when a name or a pointer goes next
      for (const [id, el] of cursors.current) {
        const p = conn.pointers.get(id);
        let g = glides.get(id);
        if (!g) glides.set(id, (g = { x: 0, y: 0, vx: 0, vy: 0, shown: false, state: "", flip: "", findUntil: 0 }));
        if (!p || !b) {
          g.shown = false;
          setState(el, g, "");
          continue;
        }
        if (!g.shown || !smooth) {
          [g.x, g.y, g.vx, g.vy, g.shown] = [p.c, p.r, 0, 0, true];
        } else {
          [g.x, g.vx] = glide(g.x, p.c, g.vx, dt);
          [g.y, g.vy] = glide(g.y, p.r, g.vy, dt);
          if (Math.abs(g.x - p.c) + Math.abs(g.y - p.r) < 0.004 && Math.abs(g.vx) + Math.abs(g.vy) < 0.05) [g.x, g.y, g.vx, g.vy] = [p.c, p.r, 0, 0];
          else moving = true;
        }
        const x = b.x + g.x * b.cw;
        const y = b.y + g.y * b.ch;
        el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
        const still = t - p.at;
        const finding = g.findUntil > t;
        setState(el, g, finding || still < LABEL_FOR ? "live" : still < HIDE_AFTER ? "still" : "");
        next = Math.min(next, finding ? g.findUntil : still < LABEL_FOR ? p.at + LABEL_FOR : still < HIDE_AFTER ? p.at + HIDE_AFTER : Infinity);
        const l = labels.current.get(id);
        const flip = l ? (x + LABEL_X + l.w > b.w - 4 ? "x" : "") + (y + LABEL_Y + l.h > b.h - 4 ? "y" : "") : "";
        if (flip !== g.flip) {
          g.flip = flip;
          el.dataset.flip = flip;
        }
      }
      if (moving) raf = requestAnimationFrame(frame);
      else {
        last = 0;
        if (next < Infinity) timer = window.setTimeout(go, Math.max(20, next - t + 10));
      }
    };
    const go = () => {
      window.clearTimeout(timer);
      if (!raf) raf = requestAnimationFrame(frame);
    };

    // A click: a ring where it landed, and the arrow pressed.
    const clicked = (id: string) => {
      const p = conn.pointers.get(id);
      const b = boxRef.current;
      const m = byIdRef.current.get(id);
      if (!p || !b || !m || !fx.current) return;
      const el = mark("pc-ripple", b.x + p.c * b.cw, b.y + p.r * b.ch, m.color);
      el.append(document.createElement("i"), document.createElement("b"));
      fx.current.appendChild(el);
      window.setTimeout(() => el.remove(), 800);
      const cur = cursors.current.get(id);
      if (cur) {
        cur.dataset.down = "";
        window.setTimeout(() => delete cur.dataset.down, 140);
      }
    };

    // "Where are they?": their pointer stands out, name and all; else where they type does.
    const found = (id: string, at?: string) => {
      const b = boxRef.current;
      const m = byIdRef.current.get(id);
      const el = cursors.current.get(id);
      if (!b || !m) return;
      if (at === "pointer" && el) {
        const g = glides.get(id);
        if (!g) return;
        g.findUntil = Date.now() + FIND_FOR;
        delete el.dataset.find;
        void el.offsetWidth; // the rings start again
        el.dataset.find = "";
        window.clearTimeout(g.findTimer);
        g.findTimer = window.setTimeout(() => delete el.dataset.find, FIND_FOR);
        return;
      }
      if (!fx.current) return;
      const f = mark("pc-flash", b.x + b.cursor.x * b.cw, b.y + b.cursor.y * b.ch, m.color);
      f.style.height = `${b.ch}px`;
      const halo = document.createElement("span");
      halo.className = "pc-halo";
      const bar = document.createElement("span");
      bar.className = "pc-bar";
      const tag = document.createElement("span");
      tag.className = "pc-pill pc-tag";
      tag.textContent = `${firstName(m.name)} typed here`;
      tag.style.background = m.color;
      tag.style.color = inkOn(m.color);
      f.append(halo, bar, tag);
      fx.current.appendChild(f);
      window.setTimeout(() => f.remove(), FIND_FOR + 400);
    };

    const off = conn.onPointer((n) => {
      if (n.t === "reset") glides.forEach((g) => (g.shown = false));
      if (n.t === "click") clicked(n.id);
      if (n.t === "find") found(n.id, n.at);
      go();
    });
    wake.current = go;
    go();
    return () => {
      off();
      wake.current = () => {};
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      glides.forEach((g) => window.clearTimeout(g.findTimer));
    };
  }, [conn, layer]);

  // The screen moved (the pane, its font): the pointers go with it.
  useEffect(() => wake.current(), [box]);

  // "Typing" goes by itself: drawn again on a clock while it shows.
  useEffect(() => {
    if (!typing) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 400);
    return () => window.clearInterval(timer);
  }, [!!typing]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={setLayer} className="pointer-events-none absolute inset-0 z-[15] overflow-hidden">
      {box &&
        Object.entries(sels ?? {}).map(([id, sel]) => {
          const m = byId.get(id);
          return m ? <Selection key={id} sel={sel} color={m.color} box={box} /> : null;
        })}
      {box && typing && <TypingFlag m={byId.get(typing[0])!} box={box} />}
      <div ref={fx} className="absolute inset-0" />
      {others.map((m) => (
        <div
          key={m.id}
          ref={(el) => void (el ? cursors.current.set(m.id, el) : cursors.current.delete(m.id))}
          className="pc"
          style={{ "--c": m.color } as CSSProperties}
        >
          <span className="pc-halo" />
          <svg className="pc-arrow" width="18" height="18" viewBox="0 0 19 19">
            <path d={ARROW} fill={m.color} />
          </svg>
          <span className="pc-pill pc-label" style={{ background: m.color, color: inkOn(m.color) }}>
            {nameOf(m, others)}
          </span>
        </div>
      ))}
    </div>
  );
});

const sameBox = (a: Box, b: Box) =>
  a.x === b.x && a.y === b.y && a.cw === b.cw && a.ch === b.ch && a.cols === b.cols && a.w === b.w && a.h === b.h && a.cursor.x === b.cursor.x && a.cursor.y === b.cursor.y;

function setState(el: HTMLElement, g: Glide, state: string) {
  if (g.state === state) return;
  g.state = state;
  el.dataset.state = state;
}

/** One step of a critically damped spring toward the target: no overshoot, and no jolt when
 *  the target moves (it keeps its speed). Game Programming Gems 4, 1.10. */
function glide(at: number, target: number, v: number, dt: number): [number, number] {
  const omega = 2 / GLIDE;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = at - target;
  const temp = (v + omega * change) * dt;
  return [target + (change + temp) * exp, (v - omega * temp) * exp];
}

/** An element at a spot in the layer, in someone's colour. */
function mark(className: string, x: number, y: number, color: string) {
  const el = document.createElement("div");
  el.className = className;
  el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
  el.style.setProperty("--c", color);
  return el;
}

/** Text that reads on someone's colour: white, or near black on a light one. */
function inkOn(color: string) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return "#fff";
  const [r, g, b] = m.slice(1).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Contrast against white and against the dark ink: whichever is higher.
  return 1.05 / (lum + 0.05) >= (lum + 0.05) / 0.06 ? "#fff" : "#17181c";
}

/** Someone's name as shown: their first name, and their device too when two share it. */
function nameOf(m: Member, all: Member[]) {
  const first = firstName(m.name);
  const twins = all.filter((x) => firstName(x.name) === first);
  return twins.length > 1 && m.device ? `${first} · ${m.device}` : first;
}

/** What someone selected, row by row, in their colour. */
function Selection({ sel, color, box }: { sel: Sel; color: string; box: Box }) {
  let [a, b] = [sel.a, sel.b];
  if (b[1] < a[1] || (b[1] === a[1] && b[0] < a[0])) [a, b] = [b, a];
  const rows: { x: number; y: number; w: number }[] = [];
  for (let y = Math.max(0, a[1]); y <= b[1] && rows.length < 400; y++) {
    const x0 = y === a[1] ? a[0] : 0;
    const x1 = y === b[1] ? b[0] : box.cols;
    if (x1 > x0) rows.push({ x: x0, y, w: x1 - x0 });
  }
  return (
    <>
      {rows.map((r) => (
        <div
          key={r.y}
          className="absolute rounded-[2px]"
          style={{ left: box.x + r.x * box.cw, top: box.y + r.y * box.ch, width: r.w * box.cw, height: box.ch, background: `color-mix(in srgb, ${color} 30%, transparent)`, boxShadow: `inset 0 -1px 0 color-mix(in srgb, ${color} 70%, transparent)` }}
        />
      ))}
    </>
  );
}

/** Who is typing: their name over the cursor, and the cursor in their colour. */
function TypingFlag({ m, box }: { m: Member; box: Box }) {
  return (
    <div className="anim-fade absolute top-0 left-0" style={{ transform: `translate(${box.x + box.cursor.x * box.cw}px, ${box.y + box.cursor.y * box.ch}px)`, height: box.ch, "--c": m.color } as CSSProperties}>
      <span className="pc-bar" />
      <span className="pc-pill pc-tag" style={{ background: m.color, color: inkOn(m.color) }}>
        {firstName(m.name)}
      </span>
    </div>
  );
}
