package collab

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"skybuild/internal/model"
	"skybuild/internal/tailnet"
	"skybuild/internal/term"
)

func TestLinkRoundTrip(t *testing.T) {
	inv := Invite{Host: "100.67.119.107", Port: 47863, Share: "abc12345", Key: "k3y-_x", By: "Teddy Oweh", Title: "blockstreet: fix the build"}
	got, err := ParseLink("look at this " + inv.Link() + " thanks")
	if err != nil {
		t.Fatal(err)
	}
	if got != inv {
		t.Fatalf("round trip: got %+v want %+v", got, inv)
	}
	for _, bad := range []string{"", "https://example.com", "lungo://join/", "lungo://join/1.2.3.4:99/abcd", "lungo://join/nohost/abcd?k=x"} {
		if _, err := ParseLink(bad); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
	v6 := Invite{Host: "fd7a:115c:a1e0::1", Port: 1, Share: "abcd", Key: "k"}
	if got, err := ParseLink(v6.Link()); err != nil || got.Host != v6.Host {
		t.Fatalf("v6: %v %+v", err, got)
	}
}

func TestCodes(t *testing.T) {
	for range 200 {
		c := newCode("100.64.0.1")
		if len(c) != codeLen || c[0] != CodeHint("100.64.0.1") || !strings.ContainsAny(c, "23456789") || strings.Trim(c, codeChars) != "" || NormalCode(c) != c {
			t.Fatalf("code %q", c)
		}
	}
	for in, want := range map[string]string{"7KX-4PQ": "7KX4PQ", "7kx4pq": "7KX4PQ", " 7kx 4pq ": "7KX4PQ", "7KX-4P": "", "7KX-4P0": "", "OIL234": "", "7KX-4PQR": ""} {
		if got := NormalCode(in); got != want {
			t.Errorf("NormalCode(%q) = %q, want %q", in, got, want)
		}
	}
	for _, in := range []string{"7kx-4pq", "lungo://join/7KX-4PQ", "join me: lungo://join/7kx-4pq thanks", "come in, the code is 7KX-4PQ"} {
		if inv, err := ParseLink(in); err != nil || inv.Code != "7KX4PQ" {
			t.Errorf("%q: %+v %v", in, inv, err)
		}
	}
	if CodeLink("7KX4PQ") != "lungo://join/7KX-4PQ" {
		t.Fatal(CodeLink("7KX4PQ"))
	}
	// A share made before there were codes gets them, unlike the others' codes.
	a := NewShare("@local", "a", "a", "100.64.0.1")
	b := Share{EditKey: "e", ViewKey: "v"}
	b.Recode("100.64.0.1", []Share{a})
	if b.EditCode == "" || b.ViewCode == "" || b.EditCode == b.ViewCode || b.EditCode == a.EditCode || b.ViewCode == a.ViewCode {
		t.Fatalf("recode: %+v", b)
	}
	if r, k := a.codeRole(a.ViewCode); r != View || k != a.ViewKey {
		t.Fatal("view code")
	}
	if r, _ := a.codeRole(b.EditCode); r != "" {
		t.Fatal("another share's code")
	}
	if r, _ := a.codeRole(""); r != "" {
		t.Fatal("no code")
	}
}

func TestJoinByCode(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	// The code, as a link or typed; the edit code lets them type, the view code watch.
	for code, role := range map[string]string{CodeLink(w.share.EditCode): Edit, strings.ToLower(ShowCode(w.share.ViewCode)): View} {
		j, err := w.guest.Join(ctx, code)
		if err != nil {
			t.Fatalf("%s: %v", code, err)
		}
		if j.Share.Role != role || j.Share.ID != w.share.ID || NormalCode(j.Share.Code) != NormalCode(code[strings.LastIndex(code, "/")+1:]) {
			t.Fatalf("%s: %+v", code, j.Share)
		}
		// What the pane keeps to reconnect is the whole link: no asking around again.
		if inv, err := ParseLink(j.Link); err != nil || inv.Key == "" || inv.By != "Teddy" {
			t.Fatalf("kept link %q: %+v %v", j.Link, inv, err)
		}
	}
	// A share whose codes start with another computer's letter is still found.
	other := NewShare("@local", "claude-other", "other", "100.99.1.2")
	w.store.Update(func(s []Share) ([]Share, error) { return append(s, other), nil })
	if j, err := w.guest.Join(ctx, ShowCode(other.EditCode)); err != nil || j.Share.ID != other.ID {
		t.Fatalf("other: %+v %v", j, err)
	}
	// Nobody has a wrong code; guessing gets turned away soon.
	wrong := "7KX4PQ"
	if wrong == w.share.EditCode || wrong == w.share.ViewCode || wrong == other.EditCode || wrong == other.ViewCode {
		wrong = "8KX4PQ"
	}
	if _, err := w.guest.Join(ctx, wrong); err == nil || !strings.Contains(err.Error(), "nobody on your tailnet") {
		t.Fatalf("wrong code: %v", err)
	}
	for range wrongCodesAMinute {
		w.guest.Find(ctx, wrong)
	}
	if _, err := w.guest.Find(ctx, w.share.EditCode); err == nil || !strings.Contains(err.Error(), "too many wrong codes") {
		t.Fatalf("after guessing: %v", err)
	}
}

func TestRoles(t *testing.T) {
	s := NewShare("@local", "claude-x", "x", "100.64.0.1")
	if s.role(s.EditKey) != Edit || s.role(s.ViewKey) != View || s.role("nope") != "" || s.role("") != "" {
		t.Fatal("keys")
	}
	s.SetRole("ada/mac", View)
	if s.roleOf("ada/mac", Edit) != View {
		t.Fatal("view only")
	}
	s.SetRole("ada/mac", Edit)
	if s.roleOf("ada/mac", View) != Edit || len(s.ViewOnly) != 0 {
		t.Fatal("can type")
	}
	s.Remove("ada/mac")
	if s.roleOf("ada/mac", Edit) != "" {
		t.Fatal("removed")
	}
}

func TestTyping(t *testing.T) {
	for in, want := range map[string]bool{"a": true, "\r": true, "\x1b[A": true, "\x7f": true, "\x1b[<0;3;4M": false, "\x1b[I": false, "\x1b[?62;22c": false, "\x1b]11;rgb:0000/0000/0000\x1b\\": false, "\x1b[12;40R": false, "\x1b[?1;2c\x1b[>0;276;0c": false, "\x1b[?1;2cx": true} {
		if typing([]byte(in)) != want {
			t.Errorf("%q: want %v", in, want)
		}
	}
}

// fakeBackend is a session that is a shell running cat, with one port.
type fakeBackend struct {
	mu    sync.Mutex
	ports []model.Port
	cols  int
	rows  int
}

func (f *fakeBackend) AttachArgs(machine, session string) ([]string, error) {
	// What tmux does on attach: switch to the alternate screen, then the session (cat here).
	return []string{"/bin/sh", "-c", `printf 'attached\033[?1049h'; stty -echo; cat`}, nil
}
func (f *fakeBackend) Info(machine, session string) SessionInfo {
	return SessionInfo{Title: "fix the build", Folder: "blockstreet", Agent: "claude", State: "working"}
}
func (f *fakeBackend) WindowSize(ctx context.Context, machine, session string) (int, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cols, f.rows, nil
}
func (f *fakeBackend) Ports(ctx context.Context, machine, session string) ([]model.Port, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]model.Port(nil), f.ports...), nil
}
func (f *fakeBackend) DialPort(ctx context.Context, machine string, p model.Port) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p.Port)))
}
func (f *fakeBackend) Me(ctx context.Context) *tailnet.Person {
	return &tailnet.Person{Login: "teddy@example.com", Name: "Teddy", Device: "macbook"}
}
func (f *fakeBackend) WhoIs(ctx context.Context, addr string) (*tailnet.Person, error) {
	return &tailnet.Person{Login: "ada@example.com", Name: "Ada", Device: "ada-mac"}, nil
}

// world is a hub with one share, and a guest that reaches it over plain localhost.
type world struct {
	t     *testing.T
	b     *fakeBackend
	hub   *Hub
	store *Store
	srv   *httptest.Server
	guest *Guest
	share Share
	inv   Invite
}

func newWorld(t *testing.T) *world {
	terms, err := term.NewManager()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(terms.CloseAll)
	w := &world{t: t, b: &fakeBackend{cols: 90, rows: 30}, store: NewStore(t.TempDir())}
	w.hub = NewHub(w.b, terms, w.store, 0)
	key, err := w.store.LocalKey()
	if err != nil {
		t.Fatal(err)
	}
	w.hub.localKey = key
	w.share = NewShare("@local", "claude-blockstreet", "blockstreet", "127.0.0.1")
	if err := w.store.Update(func(s []Share) ([]Share, error) { return append(s, w.share), nil }); err != nil {
		t.Fatal(err)
	}
	w.srv = httptest.NewServer(w.hub.Handler())
	t.Cleanup(w.srv.Close)
	host, port, _ := net.SplitHostPort(strings.TrimPrefix(w.srv.URL, "http://"))
	n, _ := strconv.Atoi(port)
	w.inv = Invite{Host: host, Port: n, Share: w.share.ID, Key: w.share.EditKey, By: "Teddy"}
	gterms, err := term.NewManager()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(gterms.CloseAll)
	w.guest = NewGuest(gterms)
	w.guest.dial = func(ctx context.Context, host string, port int) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	}
	// The "tailnet" is this computer, where the hub is on its port; a port nothing listens on
	// stands in for the computers that don't run Lungo.
	dead, _ := net.Listen("tcp", "127.0.0.1:0")
	dead.Close()
	w.guest.hosts = func(context.Context) ([]string, error) { return []string{"127.0.0.1"}, nil }
	w.guest.Ports = []int{dead.Addr().(*net.TCPAddr).Port, n}
	return w
}

// msgs reads a presence connection's messages.
type msgs struct {
	t  *testing.T
	c  *websocket.Conn
	ch chan map[string]any
}

func dialPresence(t *testing.T, url string) *msgs {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	m := &msgs{t: t, c: c, ch: make(chan map[string]any, 100)}
	go func() {
		defer close(m.ch)
		for {
			_, b, err := c.Read(context.Background())
			if err != nil {
				m.ch <- map[string]any{"t": "closed", "why": websocket.CloseStatus(err), "err": err.Error()}
				return
			}
			var v map[string]any
			json.Unmarshal(b, &v)
			m.ch <- v
		}
	}()
	t.Cleanup(func() { c.CloseNow() })
	return m
}

// await reads messages until one of type typ (that ok accepts) arrives.
func (m *msgs) await(typ string, ok func(map[string]any) bool) map[string]any {
	m.t.Helper()
	deadline := time.After(6 * time.Second)
	for {
		select {
		case v, open := <-m.ch:
			if !open {
				m.t.Fatalf("closed while waiting for %s", typ)
			}
			if v["t"] == typ && (ok == nil || ok(v)) {
				return v
			}
		case <-deadline:
			m.t.Fatalf("no %s message", typ)
		}
	}
}

func (m *msgs) send(v any) {
	b, _ := json.Marshal(v)
	if err := m.c.Write(context.Background(), websocket.MessageText, b); err != nil {
		m.t.Fatal(err)
	}
}

func people(v map[string]any) []map[string]any {
	var out []map[string]any
	list, _ := v["people"].([]any)
	for _, p := range list {
		out = append(out, p.(map[string]any))
	}
	return out
}

func TestShareEndToEnd(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()

	// A wrong key gets nowhere.
	bad := w.inv
	bad.Key = "wrong"
	if _, err := w.guest.Join(ctx, bad.Link()); err == nil || !strings.Contains(err.Error(), "doesn't work") {
		t.Fatalf("wrong key: %v", err)
	}
	j, err := w.guest.Join(ctx, w.inv.Link())
	if err != nil {
		t.Fatal(err)
	}
	if j.Share.Role != Edit || j.Share.By.Name != "Teddy" || j.Share.Info.Folder != "blockstreet" || j.Share.Cols != 90 || j.Share.Rows != 30 {
		t.Fatalf("join info: %+v", j.Share)
	}

	// The person sharing is in the room from their pane; the guest comes in through the app.
	host := dialPresence(t, "ws://"+strings.TrimPrefix(w.srv.URL, "http://")+"/v1/s/"+w.share.ID+"/presence?local="+w.hub.localKey+"&c=host-pane")
	hello := host.await("hello", nil)
	if hello["role"] != Edit {
		t.Fatalf("host hello: %v", hello)
	}
	guest := dialPresence(t, j.Presence+"&c=ada-pane1")
	gh := guest.await("hello", nil)
	if size := gh["size"].(map[string]any); size["cols"] != 90.0 || size["rows"] != 30.0 {
		t.Fatalf("size: %v", gh)
	}
	roster := host.await("people", func(v map[string]any) bool { return len(people(v)) == 2 })
	ps := people(roster)
	if ps[0]["host"] != true || ps[1]["name"] != "Ada" || ps[1]["who"] != "ada@example.com/ada-mac" || ps[1]["canType"] != true {
		t.Fatalf("roster: %v", ps)
	}

	// Pointers and selections go to the others, stamped with who they are from.
	host.send(map[string]any{"t": "ptr", "c": 12.345, "r": 3})
	p := guest.await("ptr", nil)
	if p["id"] != "host-pane" || p["c"] != 12.35 || p["r"] != 3.0 {
		t.Fatalf("ptr: %v", p)
	}
	guest.send(map[string]any{"t": "sel", "a": []int{1, 2}, "b": []int{9, 2}})
	if s := host.await("sel", nil); s["id"] != "ada-pane1" {
		t.Fatalf("sel: %v", s)
	}
	// A click shows where it landed (and moves the pointer there).
	guest.send(map[string]any{"t": "click", "c": 4.5, "r": 7.25})
	if c := host.await("click", nil); c["id"] != "ada-pane1" || c["c"] != 4.5 || c["r"] != 7.25 {
		t.Fatalf("click: %v", c)
	}
	// Someone who comes in later sees where everyone points, and how long ago it moved.
	late := dialPresence(t, "ws://"+strings.TrimPrefix(w.srv.URL, "http://")+"/v1/s/"+w.share.ID+"/presence?local="+w.hub.localKey+"&c=late-pane")
	late.await("hello", nil)
	if m := late.await("ptr", func(v map[string]any) bool { return v["id"] == "ada-pane1" }); m["c"] != 4.5 || m["idle"] == nil {
		t.Fatalf("late ptr: %v", m)
	}
	late.c.CloseNow()

	// The guest's screen, through the app, and typing into it.
	tctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	tc, _, err := websocket.Dial(tctx, j.Term+"&c=ada-pane1", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tc.CloseNow()
	readUntil := func(want string) {
		t.Helper()
		got := ""
		for !strings.Contains(got, want) {
			typ, b, err := tc.Read(tctx)
			if err != nil {
				t.Fatalf("reading the screen (have %q): %v", got, err)
			}
			if typ == websocket.MessageBinary {
				got += string(b)
			}
		}
	}
	readUntil("attached")
	// A guest asking for another size doesn't get it: the session keeps its own.
	tc.Write(tctx, websocket.MessageText, []byte(`{"type":"resize","cols":20,"rows":5}`))
	// The terminal's own answers to tmux never reach the session as typing.
	tc.Write(tctx, websocket.MessageBinary, []byte("\x1b[?1;2c\x1b[>0;276;0c"))
	tc.Write(tctx, websocket.MessageBinary, []byte("hello\n"))
	readUntil("hello")
	if typed := host.await("typed", nil); typed["id"] != "ada-pane1" {
		t.Fatalf("typed: %v", typed)
	}

	// The session grows: the guest's view follows.
	w.b.mu.Lock()
	w.b.cols, w.b.rows = 120, 40
	w.b.mu.Unlock()
	host.send(map[string]any{"t": "size"})
	if s := guest.await("size", nil); s["cols"] != 120.0 || s["rows"] != 40.0 {
		t.Fatalf("size: %v", s)
	}

	// Made view-only: what they type no longer reaches the session.
	if err := w.store.Update(func(s []Share) ([]Share, error) {
		s[0].SetRole("ada@example.com/ada-mac", View)
		return s, nil
	}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	w.hub.load()
	guest.await("people", func(v map[string]any) bool { ps := people(v); return len(ps) == 2 && ps[1]["canType"] == false })
	tc.Write(tctx, websocket.MessageBinary, []byte("secret\n"))
	tc.Write(tctx, websocket.MessageBinary, []byte{}) // nothing
	w.store.Update(func(s []Share) ([]Share, error) {
		s[0].SetRole("ada@example.com/ada-mac", Edit)
		return s, nil
	})
	time.Sleep(20 * time.Millisecond)
	w.hub.load()
	guest.await("people", func(v map[string]any) bool { ps := people(v); return len(ps) == 2 && ps[1]["canType"] == true })
	tc.Write(tctx, websocket.MessageBinary, []byte("again\n"))
	got := ""
	for !strings.Contains(got, "again") {
		_, b, err := tc.Read(tctx)
		if err != nil {
			t.Fatal(err)
		}
		got += string(b)
	}
	if strings.Contains(got, "secret") || strings.Contains(got, "276;0c") {
		t.Fatalf("a view-only guest's typing reached the session: %q", got)
	}

	// Stopping the share sees everyone out.
	w.store.Update(func(s []Share) ([]Share, error) { return nil, nil })
	time.Sleep(20 * time.Millisecond)
	w.hub.load()
	if bye := guest.await("bye", nil); bye["why"] != "stopped" {
		t.Fatalf("bye: %v", bye)
	}
	if _, err := w.guest.Join(ctx, w.inv.Link()); err == nil || !strings.Contains(err.Error(), "isn't shared") {
		t.Fatalf("join after stop: %v", err)
	}
}

func TestRemovedStaysOut(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	j, err := w.guest.Join(ctx, w.inv.Link())
	if err != nil {
		t.Fatal(err)
	}
	guest := dialPresence(t, j.Presence+"&c=ada-pane1")
	guest.await("hello", nil)
	w.store.Update(func(s []Share) ([]Share, error) {
		s[0].Remove("ada@example.com/ada-mac")
		return s, nil
	})
	time.Sleep(20 * time.Millisecond)
	w.hub.load()
	if bye := guest.await("bye", nil); bye["why"] != "removed" {
		t.Fatalf("bye: %v", bye)
	}
	if _, err := w.guest.Join(ctx, w.inv.Link()); err == nil || !strings.Contains(err.Error(), "removed") {
		t.Fatalf("rejoin: %v", err)
	}
}

func TestForwardPort(t *testing.T) {
	w := newWorld(t)
	// A "dev server" in the session: it answers with what it was sent.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				line, _ := bufio.NewReader(c).ReadString('\n')
				io.WriteString(c, "echo:"+line)
			}()
		}
	}()
	port := ln.Addr().(*net.TCPAddr).Port
	w.b.ports = []model.Port{{Port: port, Address: "127.0.0.1", Process: "node"}}

	j, err := w.guest.Join(context.Background(), w.inv.Link())
	if err != nil {
		t.Fatal(err)
	}
	addr, err := w.guest.Forward(j.ID, port)
	if err != nil {
		t.Fatal(err)
	}
	if addr2, _ := w.guest.Forward(j.ID, port); addr2 != addr {
		t.Fatalf("forwarded twice: %s %s", addr, addr2)
	}
	local := strings.TrimPrefix(addr, "http://localhost:")
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+local, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(8 * time.Second))
	io.WriteString(c, "ping\n")
	got, err := bufio.NewReader(c).ReadString('\n')
	if err != nil || got != "echo:ping\n" {
		t.Fatalf("through the forward: %q %v", got, err)
	}

	// Only the session's own ports: nothing else on the computer.
	other, _ := net.Listen("tcp", "127.0.0.1:0")
	defer other.Close()
	res, err := http.Get(w.srv.URL + "/v1/s/" + w.share.ID + "/port/" + strconv.Itoa(other.Addr().(*net.TCPAddr).Port) + "?k=" + w.share.EditKey + "&c=port-x1")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("a port outside the session: %d", res.StatusCode)
	}
	w.guest.Leave(j.ID)
	if _, err := net.DialTimeout("tcp", "127.0.0.1:"+local, time.Second); err == nil {
		t.Fatal("the forward outlived leaving")
	}
}

func TestWatch(t *testing.T) {
	w := newWorld(t)
	watch := dialPresence(t, "ws://"+strings.TrimPrefix(w.srv.URL, "http://")+"/v1/local/watch?local="+w.hub.localKey)
	first := watch.await("shares", nil)
	if list := first["shares"].([]any); len(list) != 1 {
		t.Fatalf("shares: %v", first)
	}
	j, err := w.guest.Join(context.Background(), w.inv.Link())
	if err != nil {
		t.Fatal(err)
	}
	g := dialPresence(t, j.Presence+"&c=ada-pane1")
	g.await("hello", nil)
	watch.await("shares", func(v map[string]any) bool {
		s := v["shares"].([]any)[0].(map[string]any)
		return len(s["people"].([]any)) == 1
	})
	// Without the window key there is nothing to watch.
	if _, _, err := websocket.Dial(context.Background(), "ws://"+strings.TrimPrefix(w.srv.URL, "http://")+"/v1/local/watch?local=nope", nil); err == nil {
		t.Fatal("watched without the key")
	}
}
