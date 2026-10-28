package collab

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"skybuild/internal/model"
	"skybuild/internal/tailnet"
	"skybuild/internal/term"
)

// Backend is what the hub needs from the app: how to show the session to a guest, what the
// session is doing, its ports, and who people are.
type Backend interface {
	// AttachArgs is the command that shows the session to one guest (attaching only).
	AttachArgs(machine, session string) ([]string, error)
	Info(machine, session string) SessionInfo
	WindowSize(ctx context.Context, machine, session string) (cols, rows int, err error)
	Ports(ctx context.Context, machine, session string) ([]model.Port, error)
	DialPort(ctx context.Context, machine string, p model.Port) (net.Conn, error)
	Me(ctx context.Context) *tailnet.Person
	WhoIs(ctx context.Context, addr string) (*tailnet.Person, error)
}

// SessionInfo is what the people in a share see of the session besides its screen.
type SessionInfo struct {
	Title  string `json:"title,omitempty"`
	Where  string `json:"where,omitempty"`  // the machine it runs on, as its owner calls it
	Folder string `json:"folder,omitempty"` // the name of its folder
	Branch string `json:"branch,omitempty"`
	Agent  string `json:"agent,omitempty"`
	State  string `json:"state,omitempty"` // working | waiting | idle
	Gone   bool   `json:"gone,omitempty"`  // the session isn't running
	// How the program in it takes the mouse and the screen (see engine.Session), so a guest's
	// pane selects, scrolls and types the way the person sharing's does.
	Mouse     bool `json:"mouse,omitempty"`
	Alt       bool `json:"alt,omitempty"`
	ScrollKey bool `json:"scrollKey,omitempty"`
}

// Member is a person in a share, as everyone in it sees them.
type Member struct {
	ID      string `json:"id"`  // their connection (one per pane that shows the session)
	Who     string `json:"who"` // the person, for the host to change their role or remove them
	Name    string `json:"name"`
	Login   string `json:"login,omitempty"`
	Device  string `json:"device,omitempty"`
	Avatar  string `json:"avatar,omitempty"`
	Color   string `json:"color"`
	Host    bool   `json:"host,omitempty"` // the person sharing it
	CanType bool   `json:"canType"`
}

// Colours people are told apart by: their pointer, their selection, their name.
var colors = []string{"#ff8a4c", "#4cb8ff", "#b48cff", "#3ecf8e", "#ff6fae", "#f5c451", "#2dd4bf", "#f2555a"}

// Hub serves this computer's shared sessions. One window of the app runs it: whichever
// claims the port first. The others reach it on localhost like the people on the tailnet do,
// and the shares themselves are in the Store, which any window may change.
type Hub struct {
	b     Backend
	terms *term.Manager
	store *Store
	port  int

	mu       sync.Mutex
	shares   map[string]Share
	loadedAt time.Time
	rooms    map[string]*room
	watchers map[chan struct{}]struct{}
	me       *tailnet.Person
	meAt     time.Time
	localKey string
	serving  atomic.Bool
	wrong    wrongCodes
}

func NewHub(b Backend, terms *term.Manager, store *Store, port int) *Hub {
	return &Hub{b: b, terms: terms, store: store, port: port, shares: map[string]Share{}, rooms: map[string]*room{}, watchers: map[chan struct{}]struct{}{}}
}

// Serving says whether this window runs the hub.
func (h *Hub) Serving() bool { return h.serving.Load() }

// Port is where the hub listens.
func (h *Hub) Port() int { return h.port }

// Run claims the port and serves until ctx ends. While another window has the port it keeps
// trying, so when that window goes this one takes over.
func (h *Hub) Run(ctx context.Context) {
	key, err := h.store.LocalKey()
	if err != nil {
		log.Printf("collab: %v", err)
		return
	}
	h.localKey = key
	srv := &http.Server{Handler: h.Handler(), ReadHeaderTimeout: 10 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	var ln net.Listener
	for {
		if ln, err = net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(h.port))); err == nil {
			break
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
	}
	h.serving.Store(true)
	defer h.serving.Store(false)
	go func() {
		<-ctx.Done()
		srv.Close()
		h.closeAll()
	}()
	go h.tend(ctx)
	go h.listenOnTailnet(ctx, srv)
	_ = srv.Serve(ln)
}

// listenOnTailnet: where Tailscale gives the OS a tailnet address (the Mac app, Linux,
// Windows), people on the tailnet arrive at that address, so the hub listens there too.
// In userspace mode tailscaled brings them to localhost itself.
func (h *Hub) listenOnTailnet(ctx context.Context, srv *http.Server) {
	var ln net.Listener
	at := ""
	for {
		if s, err := tailnet.Local(ctx); err == nil && s.TUN && s.BackendState == "Running" {
			if ip := s.Self.IPv4(); ip != "" && ip != at {
				if ln != nil {
					ln.Close()
				}
				if l, err := net.Listen("tcp", net.JoinHostPort(ip, strconv.Itoa(h.port))); err == nil {
					ln, at = l, ip
					go srv.Serve(l)
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(20 * time.Second):
		}
	}
}

// Handler is the hub's HTTP side (Run serves it; tests call it directly).
func (h *Hub) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/ping", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"app": "lungo", "v": 1})
	})
	mux.HandleFunc("GET /v1/code/{code}", h.serveCode)
	mux.HandleFunc("GET /v1/s/{id}", h.serveInfo)
	mux.HandleFunc("GET /v1/s/{id}/presence", h.servePresence)
	mux.HandleFunc("GET /v1/s/{id}/term", h.serveTerminal)
	mux.HandleFunc("GET /v1/s/{id}/port/{port}", h.servePort)
	mux.HandleFunc("GET /v1/local/watch", h.serveWatch)
	return mux
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

// ---------- shares ----------

// load reads the shares again when the file changed, and tells the rooms.
func (h *Hub) load() {
	mod := h.store.modified()
	h.mu.Lock()
	same := mod.Equal(h.loadedAt) && !mod.IsZero()
	h.mu.Unlock()
	if same {
		return
	}
	list, err := h.store.Load()
	if err != nil {
		return
	}
	next := map[string]Share{}
	for _, s := range list {
		next[s.ID] = s
	}
	h.mu.Lock()
	h.shares, h.loadedAt = next, mod
	rooms := make([]*room, 0, len(h.rooms))
	for _, rm := range h.rooms {
		rooms = append(rooms, rm)
	}
	h.mu.Unlock()
	for _, rm := range rooms {
		if s, ok := next[rm.id]; ok {
			rm.update(s)
		} else {
			rm.close("stopped")
		}
	}
	h.changed()
}

func (h *Hub) share(id string) (Share, bool) {
	h.load()
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.shares[id]
	return s, ok
}

// tend reloads the shares when they change and lets go of people who left.
func (h *Hub) tend(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for n := 0; ; n++ {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		h.load()
		if n%5 == 0 {
			h.mu.Lock()
			rooms := make([]*room, 0, len(h.rooms))
			for _, rm := range h.rooms {
				rooms = append(rooms, rm)
			}
			h.mu.Unlock()
			for _, rm := range rooms {
				rm.sweep()
			}
		}
	}
}

func (h *Hub) closeAll() {
	h.mu.Lock()
	rooms := make([]*room, 0, len(h.rooms))
	for _, rm := range h.rooms {
		rooms = append(rooms, rm)
	}
	h.mu.Unlock()
	for _, rm := range rooms {
		rm.close("")
	}
}

func (h *Hub) person(ctx context.Context) tailnet.Person {
	h.mu.Lock()
	if h.me != nil && time.Since(h.meAt) < time.Minute {
		p := *h.me
		h.mu.Unlock()
		return p
	}
	h.mu.Unlock()
	p := h.b.Me(ctx)
	if p == nil {
		p = &tailnet.Person{Name: "Host"}
	}
	h.mu.Lock()
	h.me, h.meAt = p, time.Now()
	h.mu.Unlock()
	return *p
}

// ---------- who is asking ----------

var clientID = regexp.MustCompile(`^[A-Za-z0-9_.:-]{4,64}$`)

// visitor is a connection let in: who it is and what its key allows.
type visitor struct {
	client  string
	person  tailnet.Person
	host    bool
	keyRole string
	who     string
}

type refusal struct {
	code int
	why  string
}

func (e refusal) Error() string { return e.why }

// admit decides whether a request gets in: with the window key (the person sharing), or with
// a key of the share and not removed. Tailscale says who it is.
func (h *Hub) admit(r *http.Request, needClient bool) (*room, visitor, error) {
	s, ok := h.share(r.PathValue("id"))
	if !ok {
		return nil, visitor{}, refusal{http.StatusNotFound, "This session isn't shared any more."}
	}
	q := r.URL.Query()
	v := visitor{client: q.Get("c")}
	if needClient && !clientID.MatchString(v.client) {
		return nil, visitor{}, refusal{http.StatusBadRequest, "missing client id"}
	}
	if lk := q.Get("local"); lk != "" && h.localKey != "" && subtle.ConstantTimeCompare([]byte(lk), []byte(h.localKey)) == 1 {
		v.host, v.keyRole, v.person = true, Edit, h.person(r.Context())
	} else {
		v.keyRole = s.role(q.Get("k"))
		if v.keyRole == "" {
			return nil, visitor{}, refusal{http.StatusForbidden, "This invite link doesn't work any more."}
		}
		p, err := h.b.WhoIs(r.Context(), r.RemoteAddr)
		if err != nil || p == nil {
			p = &tailnet.Person{Name: "Guest"}
		}
		v.person = *p
	}
	v.who = "c:" + v.client
	if v.person.Login != "" {
		v.who = v.person.Login + "/" + v.person.Device
	}
	if !v.host && s.roleOf(v.who, v.keyRole) == "" {
		return nil, visitor{}, refusal{http.StatusForbidden, "You were removed from this session."}
	}
	rm := h.room(s)
	if needClient && rm.full(v.client) {
		return nil, visitor{}, refusal{http.StatusTooManyRequests, "This session has as many people in it as it can take."}
	}
	return rm, v, nil
}

// maxPeople is how many panes can be in one shared session at once.
const maxPeople = 32

// full: someone new would be one too many (people already in come and go freely).
func (rm *room) full(client string) bool {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	_, in := rm.people[client]
	return !in && len(rm.people) >= maxPeople
}

func refuse(w http.ResponseWriter, err error) {
	var r refusal
	if errors.As(err, &r) {
		http.Error(w, r.why, r.code)
		return
	}
	http.Error(w, err.Error(), http.StatusInternalServerError)
}

// ---------- what is served ----------

// ShareInfo is what someone with the link learns before joining.
type ShareInfo struct {
	ID    string         `json:"id"`
	Title string         `json:"title"`
	By    tailnet.Person `json:"by"`
	Role  string         `json:"role"`
	Code  string         `json:"code,omitempty"` // the code of their key, to pass on
	Info  SessionInfo    `json:"info"`
	// The session's size: a guest's screen is made this size before anything is drawn on it.
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

func (h *Hub) serveInfo(w http.ResponseWriter, r *http.Request) {
	rm, v, err := h.admit(r, false)
	if err != nil {
		refuse(w, err)
		return
	}
	rm.mu.Lock()
	s := rm.share
	rm.mu.Unlock()
	cols, rows := rm.size(r.Context())
	code := s.EditCode
	if v.keyRole == View {
		code = s.ViewCode
	}
	writeJSON(w, ShareInfo{ID: s.ID, Title: s.Title, By: h.person(r.Context()), Role: s.roleOf(v.who, v.keyRole), Code: code, Info: h.b.Info(s.Machine, s.Session), Cols: cols, Rows: rows})
}

// CodeAnswer is what a computer that shares a code says to someone asking for it: the share,
// and the key the code stands for.
type CodeAnswer struct {
	Share string `json:"share"`
	Key   string `json:"key"`
}

// serveCode answers whoever asks for a code (someone on the tailnet joining): the share and
// its key when one of this computer's shares has it, else 404. Every computer on the tailnet
// is asked, so most answers are 404; a few dozen wrong codes a minute is all anyone gets.
func (h *Hub) serveCode(w http.ResponseWriter, r *http.Request) {
	if h.wrong.tooMany() {
		http.Error(w, "Too many wrong codes. Try again in a minute.", http.StatusTooManyRequests)
		return
	}
	code := NormalCode(r.PathValue("code"))
	h.load()
	h.mu.Lock()
	var out *CodeAnswer
	for _, s := range h.shares {
		if _, key := s.codeRole(code); key != "" {
			out = &CodeAnswer{Share: s.ID, Key: key}
			break
		}
	}
	h.mu.Unlock()
	if out == nil {
		h.wrong.add()
		http.Error(w, "no session shared with that code here", http.StatusNotFound)
		return
	}
	writeJSON(w, out)
}

// wrongCodes counts the codes asked for that no share has, a minute at a time: guessing a
// code takes far longer than any share lasts.
type wrongCodes struct {
	mu    sync.Mutex
	since time.Time
	n     int
}

const wrongCodesAMinute = 30

func (c *wrongCodes) tooMany() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.since) > time.Minute {
		c.since, c.n = time.Now(), 0
	}
	return c.n >= wrongCodesAMinute
}

func (c *wrongCodes) add() {
	c.mu.Lock()
	c.n++
	c.mu.Unlock()
}

func accept(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	// The key authenticates; the app's page (one origin per platform) and the guests' app
	// (no origin) both connect, so origins aren't checked.
	return websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
}

func (h *Hub) servePresence(w http.ResponseWriter, r *http.Request) {
	rm, v, err := h.admit(r, true)
	if err != nil {
		refuse(w, err)
		return
	}
	ws, err := accept(w, r)
	if err != nil {
		return
	}
	ws.SetReadLimit(64 << 10)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	pc := newPeerConn(ws)
	if !rm.join(v, pc) {
		ws.Close(websocket.StatusPolicyViolation, "stopped")
		return
	}
	defer rm.leave(v.client, pc)
	go pc.writeLoop(ctx, cancel)
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		rm.message(v.client, data)
	}
}

func (h *Hub) serveTerminal(w http.ResponseWriter, r *http.Request) {
	rm, v, err := h.admit(r, true)
	if err != nil {
		refuse(w, err)
		return
	}
	if v.host {
		http.Error(w, "the session's own panes attach themselves", http.StatusBadRequest)
		return
	}
	id, err := rm.terminalFor(r.Context(), v)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	h.terms.ServeTerminal(w, r, id)
}

// servePort carries one connection to a port a program in the session listens on (and only
// to those: nothing else on this computer is reachable this way).
func (h *Hub) servePort(w http.ResponseWriter, r *http.Request) {
	rm, _, err := h.admit(r, true)
	if err != nil {
		refuse(w, err)
		return
	}
	n, _ := strconv.Atoi(r.PathValue("port"))
	p, ok := rm.port(n)
	if !ok {
		rm.refreshPorts(r.Context())
		p, ok = rm.port(n)
	}
	if !ok {
		http.Error(w, "nothing in the session listens on port "+strconv.Itoa(n), http.StatusNotFound)
		return
	}
	rm.mu.Lock()
	machine := rm.share.Machine
	rm.mu.Unlock()
	dctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	conn, err := h.b.DialPort(dctx, machine, p)
	cancel()
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer conn.Close()
	ws, err := accept(w, r)
	if err != nil {
		return
	}
	ctx, stop := context.WithCancel(r.Context())
	defer stop()
	nc := websocket.NetConn(ctx, ws, websocket.MessageBinary)
	defer nc.Close()
	Pipe(nc, conn)
}

// Pipe copies both ways until either side ends.
func Pipe(a, b net.Conn) {
	done := make(chan struct{}, 2)
	cp := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if c, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		}
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	// One side finished: give the other a moment to deliver what is on its way.
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
}

// ---------- the windows of this computer ----------

// ShareState is a share as this computer's windows see it: who is in it right now.
type ShareState struct {
	ID      string   `json:"id"`
	Machine string   `json:"machine"`
	Session string   `json:"session"`
	Title   string   `json:"title"`
	People  []Member `json:"people"`
}

func (h *Hub) snapshot() []ShareState {
	h.load()
	h.mu.Lock()
	shares := make([]Share, 0, len(h.shares))
	for _, s := range h.shares {
		shares = append(shares, s)
	}
	rooms := map[string]*room{}
	for id, rm := range h.rooms {
		rooms[id] = rm
	}
	h.mu.Unlock()
	sort.Slice(shares, func(i, j int) bool { return shares[i].Created.Before(shares[j].Created) })
	out := make([]ShareState, 0, len(shares))
	for _, s := range shares {
		st := ShareState{ID: s.ID, Machine: s.Machine, Session: s.Session, Title: s.Title, People: []Member{}}
		if rm := rooms[s.ID]; rm != nil {
			st.People = rm.roster()
		}
		out = append(out, st)
	}
	return out
}

func (h *Hub) changed() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.watchers {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// serveWatch keeps a window up to date on every share: who joined, who left.
func (h *Hub) serveWatch(w http.ResponseWriter, r *http.Request) {
	if lk := r.URL.Query().Get("local"); h.localKey == "" || subtle.ConstantTimeCompare([]byte(lk), []byte(h.localKey)) != 1 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	ws, err := accept(w, r)
	if err != nil {
		return
	}
	ctx := ws.CloseRead(r.Context())
	ch := make(chan struct{}, 1)
	h.mu.Lock()
	h.watchers[ch] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.watchers, ch)
		h.mu.Unlock()
		ws.CloseNow()
	}()
	last := ""
	send := func() bool {
		b, _ := json.Marshal(map[string]any{"t": "shares", "shares": h.snapshot()})
		if string(b) == last {
			return true
		}
		last = string(b)
		return ws.Write(ctx, websocket.MessageText, b) == nil
	}
	if !send() {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ch:
			time.Sleep(50 * time.Millisecond) // a burst of changes is one message
			if !send() {
				return
			}
		}
	}
}

// ---------- one shared session ----------

// room is a shared session while people are in it.
type room struct {
	h  *Hub
	id string

	mu     sync.Mutex
	share  Share
	people map[string]*member
	joined int // people let in so far: their colours go round
	cols   int
	rows   int
	ports  []model.Port
	info   SessionInfo
	closed bool
	sizing *time.Timer
	stop   chan struct{} // ends the room's ticker; nil while nobody is in
}

type member struct {
	Member
	seq     int // the order people came in
	keyRole string
	conns   map[*peerConn]struct{}
	termMu  sync.Mutex
	term    string
	goneAt  time.Time // when its last connection went (zero while connected)
	pt      *point    // where it last pointed and what it selected, for people who join later
	sel     []byte
	typedAt time.Time
	clickAt time.Time
}

// point is where a pane's pointer is, in cells (fractions of them: the same spot for everyone).
type point struct {
	c, r float64
	at   time.Time
}

// mark is a pointer for someone who comes in later: how long it has been still too, so
// one left there a while ago doesn't show as if it just moved.
func (p *point) mark(client string) []byte {
	return mustJSON(map[string]any{"t": "ptr", "id": client, "c": p.c, "r": p.r, "idle": time.Since(p.at).Milliseconds()})
}

func (h *Hub) room(s Share) *room {
	h.mu.Lock()
	defer h.mu.Unlock()
	rm := h.rooms[s.ID]
	if rm == nil {
		rm = &room{h: h, id: s.ID, share: s, people: map[string]*member{}}
		h.rooms[s.ID] = rm
	}
	return rm
}

// memberFor is the member a visitor is (made the first time they connect). Locked.
func (rm *room) memberFor(v visitor) *member {
	m := rm.people[v.client]
	if m == nil {
		m = &member{keyRole: v.keyRole, conns: map[*peerConn]struct{}{}, goneAt: time.Now()}
		m.ID, m.Who, m.Host = v.client, v.who, v.host
		m.Name, m.Login, m.Device, m.Avatar = v.person.Name, v.person.Login, v.person.Device, v.person.Avatar
		m.Color = colors[rm.joined%len(colors)]
		m.seq = rm.joined
		rm.joined++
		rm.people[v.client] = m
	}
	m.CanType = v.host || rm.share.roleOf(m.Who, m.keyRole) == Edit
	return m
}

// roster is everyone connected: the person sharing first, then in the order they came.
func (rm *room) roster() []Member {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	return rm.rosterLocked()
}

func (rm *room) rosterLocked() []Member {
	var here []*member
	for _, m := range rm.people {
		if len(m.conns) > 0 {
			here = append(here, m)
		}
	}
	sort.Slice(here, func(i, j int) bool {
		if here[i].Host != here[j].Host {
			return here[i].Host
		}
		return here[i].seq < here[j].seq
	})
	out := make([]Member, len(here))
	for i, m := range here {
		out[i] = m.Member
	}
	return out
}

func (rm *room) join(v visitor, pc *peerConn) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	rm.mu.Lock()
	if rm.closed {
		rm.mu.Unlock()
		return false
	}
	m := rm.memberFor(v)
	m.conns[pc] = struct{}{}
	m.goneAt = time.Time{}
	known := rm.cols > 0
	if rm.stop == nil {
		rm.stop = make(chan struct{})
		go rm.tick(rm.stop)
	}
	rm.mu.Unlock()
	if !known {
		rm.refreshSize(ctx)
	}
	rm.refreshInfo()
	rm.mu.Lock()
	role := View
	if m.CanType {
		role = Edit
	}
	hello := map[string]any{
		"t": "hello", "you": v.client, "role": role,
		"share": map[string]string{"id": rm.share.ID, "title": rm.share.Title},
		"info":  rm.info, "size": map[string]int{"cols": rm.cols, "rows": rm.rows},
		"ports": nonNilPorts(rm.ports), "people": rm.rosterLocked(),
	}
	var marks [][]byte
	for id, o := range rm.people {
		if id != v.client {
			if o.pt != nil {
				marks = append(marks, o.pt.mark(id))
			}
			if o.sel != nil {
				marks = append(marks, o.sel)
			}
		}
	}
	rm.mu.Unlock()
	b, _ := json.Marshal(hello)
	pc.send(b)
	for _, mk := range marks {
		pc.send(mk)
	}
	rm.broadcastPeople()
	if !v.host {
		go rm.refreshPorts(context.Background())
	}
	return true
}

func (rm *room) leave(client string, pc *peerConn) {
	rm.mu.Lock()
	m := rm.people[client]
	if m != nil {
		delete(m.conns, pc)
		if len(m.conns) == 0 {
			m.goneAt = time.Now()
			m.pt, m.sel = nil, nil
		}
	}
	rm.mu.Unlock()
	if m != nil && len(m.conns) == 0 {
		// Their pointer and selection go with them.
		rm.broadcast(mustJSON(map[string]any{"t": "ptr", "id": client}), client)
		rm.broadcast(mustJSON(map[string]any{"t": "sel", "id": client}), client)
	}
	rm.broadcastPeople()
}

// sweep lets go of people who have been gone a while.
func (rm *room) sweep() {
	rm.mu.Lock()
	var terms []string
	for id, m := range rm.people {
		if len(m.conns) == 0 && !m.goneAt.IsZero() && time.Since(m.goneAt) > 45*time.Second {
			if m.term != "" {
				terms = append(terms, m.term)
			}
			delete(rm.people, id)
		}
	}
	// The room itself stays as long as the share: only its ticker stops while nobody is in.
	if len(rm.people) == 0 && rm.stop != nil {
		close(rm.stop)
		rm.stop = nil
	}
	rm.mu.Unlock()
	for _, t := range terms {
		rm.h.terms.Close(t)
	}
}

// update takes the share as it is now: people whose role changed, people removed.
func (rm *room) update(s Share) {
	rm.mu.Lock()
	rm.share = s
	changed := false
	var out []*member
	for _, m := range rm.people {
		if m.Host {
			continue
		}
		role := s.roleOf(m.Who, m.keyRole)
		if role == "" {
			out = append(out, m)
			delete(rm.people, m.ID)
			changed = true
			continue
		}
		if can := role == Edit; can != m.CanType {
			m.CanType = can
			changed = true
		}
	}
	rm.mu.Unlock()
	for _, m := range out {
		rm.dismiss(m, "removed")
	}
	if changed {
		rm.broadcastPeople()
	}
}

// close ends the room: the share stopped (or the hub is going).
func (rm *room) close(why string) {
	rm.mu.Lock()
	if rm.closed {
		rm.mu.Unlock()
		return
	}
	rm.closed = true
	people := make([]*member, 0, len(rm.people))
	for _, m := range rm.people {
		people = append(people, m)
	}
	rm.people = map[string]*member{}
	if rm.stop != nil {
		close(rm.stop)
		rm.stop = nil
	}
	rm.mu.Unlock()
	for _, m := range people {
		rm.dismiss(m, why)
	}
	rm.h.mu.Lock()
	if rm.h.rooms[rm.id] == rm {
		delete(rm.h.rooms, rm.id)
	}
	rm.h.mu.Unlock()
}

// dismiss sees someone out: why, then their connections and their view of the session.
func (rm *room) dismiss(m *member, why string) {
	rm.mu.Lock()
	conns := make([]*peerConn, 0, len(m.conns))
	for pc := range m.conns {
		conns = append(conns, pc)
	}
	t := m.term
	rm.mu.Unlock()
	for _, pc := range conns {
		if why != "" {
			pc.send(mustJSON(map[string]any{"t": "bye", "why": why}))
		}
		pc.end(why)
	}
	if t != "" {
		rm.h.terms.Close(t)
	}
}

// message is what a pane says: where its pointer is, that it clicked, what it selected, that
// its person typed (the host: guests' typing is seen as it passes), its size (the host's pane).
func (rm *room) message(client string, data []byte) {
	var msg struct {
		T    string   `json:"t"`
		C    *float64 `json:"c"`
		R    *float64 `json:"r"`
		A    *[2]int  `json:"a"`
		B    *[2]int  `json:"b"`
		Cols int      `json:"cols"`
		Rows int      `json:"rows"`
	}
	if json.Unmarshal(data, &msg) != nil {
		return
	}
	rm.mu.Lock()
	m := rm.people[client]
	if m == nil || rm.closed {
		rm.mu.Unlock()
		return
	}
	host := m.Host
	var out []byte
	switch msg.T {
	case "ptr":
		o := map[string]any{"t": "ptr", "id": client}
		if msg.C != nil && msg.R != nil && finite(*msg.C) && finite(*msg.R) {
			m.pt = &point{round2(*msg.C), round2(*msg.R), time.Now()}
			o["c"], o["r"] = m.pt.c, m.pt.r
		} else {
			m.pt = nil
		}
		out = mustJSON(o)
	case "click":
		// Seen where it lands, like the pointer; what the click does in the session is the
		// terminal's business (and a watcher's goes nowhere).
		if msg.C != nil && msg.R != nil && finite(*msg.C) && finite(*msg.R) && time.Since(m.clickAt) > 40*time.Millisecond {
			m.clickAt = time.Now()
			m.pt = &point{round2(*msg.C), round2(*msg.R), time.Now()}
			out = mustJSON(map[string]any{"t": "click", "id": client, "c": m.pt.c, "r": m.pt.r})
		}
	case "sel":
		o := map[string]any{"t": "sel", "id": client}
		if msg.A != nil && msg.B != nil {
			o["a"], o["b"] = msg.A, msg.B
			out = mustJSON(o)
			m.sel = out
		} else {
			out = mustJSON(o)
			m.sel = nil
		}
	case "typed":
		if host && time.Since(m.typedAt) > 250*time.Millisecond {
			m.typedAt = time.Now()
			out = mustJSON(map[string]any{"t": "typed", "id": client})
		}
	case "size":
		if host {
			rm.sizeSoon()
		}
	}
	rm.mu.Unlock()
	if out != nil {
		rm.broadcast(out, client)
	}
}

func finite(f float64) bool    { return !math.IsNaN(f) && !math.IsInf(f, 0) && f > -1000 && f < 10000 }
func round2(f float64) float64 { return math.Round(f*100) / 100 }

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func nonNilPorts(p []model.Port) []model.Port {
	if p == nil {
		return []model.Port{}
	}
	return p
}

// broadcast sends a message to everyone but the one it came from.
func (rm *room) broadcast(b []byte, except string) {
	rm.mu.Lock()
	var to []*peerConn
	for id, m := range rm.people {
		if id == except {
			continue
		}
		for pc := range m.conns {
			to = append(to, pc)
		}
	}
	rm.mu.Unlock()
	for _, pc := range to {
		pc.send(b)
	}
}

func (rm *room) broadcastPeople() {
	rm.broadcast(mustJSON(map[string]any{"t": "people", "people": rm.roster()}), "")
	rm.h.changed()
}

// tick keeps the room's view of the session fresh while people are in it: its size (what its
// own panes make it), what it is doing, and the ports it listens on.
func (rm *room) tick(stop chan struct{}) {
	t := time.NewTicker(3 * time.Second)
	defer t.Stop()
	for n := 1; ; n++ {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		rm.mu.Lock()
		guests := false
		for _, m := range rm.people {
			guests = guests || (!m.Host && len(m.conns) > 0)
		}
		rm.mu.Unlock()
		if !guests { // the host alone: nobody to keep up to date
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		rm.refreshSize(ctx)
		rm.refreshInfo()
		if n%2 == 0 {
			rm.refreshPorts(ctx)
		}
		cancel()
	}
}

// sizeSoon: the host's pane changed size. tmux has it a moment later.
func (rm *room) sizeSoon() {
	if rm.sizing != nil {
		rm.sizing.Stop()
	}
	rm.sizing = time.AfterFunc(150*time.Millisecond, func() {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		rm.refreshSize(ctx)
	})
}

// refreshSize reads the session's size; when it changed, every guest's view follows it.
func (rm *room) refreshSize(ctx context.Context) {
	rm.mu.Lock()
	machine, session := rm.share.Machine, rm.share.Session
	rm.mu.Unlock()
	cols, rows, err := rm.h.b.WindowSize(ctx, machine, session)
	if err != nil {
		return
	}
	rm.mu.Lock()
	changed := cols != rm.cols || rows != rm.rows
	rm.cols, rm.rows = cols, rows
	var terms []string
	for _, m := range rm.people {
		if m.term != "" {
			terms = append(terms, m.term)
		}
	}
	rm.mu.Unlock()
	if !changed {
		return
	}
	for _, t := range terms {
		_ = rm.h.terms.Resize(t, cols, rows)
	}
	rm.broadcast(mustJSON(map[string]any{"t": "size", "cols": cols, "rows": rows}), "")
}

func (rm *room) refreshInfo() {
	rm.mu.Lock()
	machine, session := rm.share.Machine, rm.share.Session
	rm.mu.Unlock()
	info := rm.h.b.Info(machine, session)
	rm.mu.Lock()
	changed := info != rm.info
	rm.info = info
	rm.mu.Unlock()
	if changed {
		rm.broadcast(mustJSON(map[string]any{"t": "info", "info": info}), "")
	}
}

func (rm *room) refreshPorts(ctx context.Context) {
	rm.mu.Lock()
	machine, session := rm.share.Machine, rm.share.Session
	rm.mu.Unlock()
	ports, err := rm.h.b.Ports(ctx, machine, session)
	if err != nil {
		return
	}
	rm.mu.Lock()
	changed := !slices.Equal(ports, rm.ports)
	rm.ports = ports
	rm.mu.Unlock()
	if changed {
		rm.broadcast(mustJSON(map[string]any{"t": "ports", "ports": nonNilPorts(ports)}), "")
	}
}

func (rm *room) port(n int) (model.Port, bool) {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	for _, p := range rm.ports {
		if p.Port == n {
			return p, true
		}
	}
	return model.Port{}, false
}

func (rm *room) size(ctx context.Context) (int, int) {
	rm.mu.Lock()
	cols, rows := rm.cols, rm.rows
	rm.mu.Unlock()
	if cols > 0 {
		return cols, rows
	}
	rm.refreshSize(ctx)
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if rm.cols > 0 {
		return rm.cols, rm.rows
	}
	return 120, 32
}

// terminalFor is the guest's own view of the session: a tmux client on this computer, kept
// while they come and go (a connection that drops gets the screen back from it).
func (rm *room) terminalFor(ctx context.Context, v visitor) (string, error) {
	rm.mu.Lock()
	if rm.closed {
		rm.mu.Unlock()
		return "", errors.New("this session isn't shared any more")
	}
	m := rm.memberFor(v)
	machine, session := rm.share.Machine, rm.share.Session
	rm.mu.Unlock()

	m.termMu.Lock()
	defer m.termMu.Unlock()
	if m.term != "" {
		if info, ok := rm.h.terms.Get(m.term); ok && !info.Exited {
			return m.term, nil
		}
		rm.h.terms.Close(m.term)
	}
	args, err := rm.h.b.AttachArgs(machine, session)
	if err != nil {
		return "", err
	}
	cols, rows := rm.size(ctx)
	home, _ := os.UserHomeDir()
	info, err := rm.h.terms.Start(term.Spec{Args: args, Title: "shared " + session, Dir: home, Cols: cols, Rows: rows, Fixed: true, Input: rm.gate(v.client)})
	if err != nil {
		return "", err
	}
	rm.mu.Lock()
	m.term = info.ID
	rm.mu.Unlock()
	return info.ID, nil
}

// gate passes what a guest types to the session when they may type, and tells the others
// who is typing.
func (rm *room) gate(client string) func([]byte) bool {
	return func(b []byte) bool {
		// A guest's terminal answers tmux's questions about it (what it is, its colours), and
		// over the network the answers come late enough that tmux takes them for keys typed
		// into the session. tmux does without them.
		if reports.Match(b) {
			return false
		}
		rm.mu.Lock()
		m := rm.people[client]
		ok := m != nil && m.CanType && !rm.closed
		say := ok && typing(b) && time.Since(m.typedAt) > 250*time.Millisecond
		if say {
			m.typedAt = time.Now()
		}
		rm.mu.Unlock()
		if say {
			rm.broadcast(mustJSON(map[string]any{"t": "typed", "id": client}), client)
		}
		return ok
	}
}

// reports are what a terminal answers by itself (tmux asks it what it can do): not typing.
var reports = regexp.MustCompile(`^(\x1b(\[[?>]?[0-9;]*[cRnt]|\][^\x07\x1b]*(\x07|\x1b\\)|P[^\x1b]*\x1b\\))+$`)

// typing tells keys from the mouse, focus changes and the terminal's own answers.
func typing(b []byte) bool {
	s := string(b)
	return s != "" && !strings.HasPrefix(s, "\x1b[<") && !strings.HasPrefix(s, "\x1b[M") && s != "\x1b[I" && s != "\x1b[O" && !reports.MatchString(s)
}

// ---------- a connection to a pane ----------

type frame struct {
	b   []byte
	end bool
	why string
}

// peerConn sends to one pane in order, and never holds anyone up: a pane that falls this far
// behind is let go (it connects again).
type peerConn struct {
	ws   *websocket.Conn
	out  chan frame
	once sync.Once
}

func newPeerConn(ws *websocket.Conn) *peerConn {
	return &peerConn{ws: ws, out: make(chan frame, 512)}
}

func (pc *peerConn) send(b []byte) {
	select {
	case pc.out <- frame{b: b}:
	default:
		pc.end("fell behind")
	}
}

func (pc *peerConn) end(why string) {
	pc.once.Do(func() {
		select {
		case pc.out <- frame{end: true, why: why}:
		default:
			pc.ws.Close(websocket.StatusTryAgainLater, why)
		}
	})
}

func (pc *peerConn) writeLoop(ctx context.Context, cancel context.CancelFunc) {
	defer cancel()
	for {
		select {
		case <-ctx.Done():
			return
		case f := <-pc.out:
			if f.end {
				pc.ws.Close(websocket.StatusNormalClosure, f.why)
				return
			}
			wctx, c := context.WithTimeout(ctx, 10*time.Second)
			err := pc.ws.Write(wctx, websocket.MessageText, f.b)
			c()
			if err != nil {
				return
			}
		}
	}
}
