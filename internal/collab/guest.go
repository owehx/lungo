package collab

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"skybuild/internal/tailnet"
	"skybuild/internal/term"
)

// Guest is this computer's side of the sessions shared with it. The page reaches each one
// through the app (where Tailscale runs in userspace mode the page can't reach the tailnet
// itself), and the ports a shared session listens on are forwarded to localhost here.
type Guest struct {
	terms *term.Manager
	dial  func(ctx context.Context, host string, port int) (net.Conn, error)
	hosts func(ctx context.Context) ([]string, error) // where to look for a code
	// Ports are where computers serve their shares: DefaultPort (a development build looks on
	// its own port too).
	Ports []int

	mu    sync.Mutex
	joins map[string]*joined
}

type joined struct {
	inv Invite
	fwd map[int]*forward // the share's port → where it is here
}

type forward struct {
	lns   []net.Listener
	local int
}

// JoinInfo is a share joined from its link.
type JoinInfo struct {
	ID    string    `json:"id"` // this computer's name for the join
	Link  string    `json:"link"`
	Share ShareInfo `json:"share"`
	// Where the page connects (adding &c=<its id>): the screen, and everyone's pointers.
	Term     string `json:"term"`
	Presence string `json:"presence"`
}

// NewGuest serves the page's connections to shared sessions under /collab/ on the terminal
// server.
func NewGuest(terms *term.Manager) *Guest {
	g := &Guest{terms: terms, dial: tailnet.Dial, hosts: tailnetHosts, Ports: []int{DefaultPort}, joins: map[string]*joined{}}
	if terms != nil {
		terms.Mount("/collab/", http.HandlerFunc(g.serveProxy))
	}
	return g
}

func joinID(inv Invite) string {
	sum := sha256.Sum256([]byte(inv.Host + "|" + strconv.Itoa(inv.Port) + "|" + inv.Share + "|" + inv.Key))
	return hex.EncodeToString(sum[:6])
}

func (g *Guest) transport() *http.Transport {
	return &http.Transport{
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			n, _ := strconv.Atoi(port)
			return g.dial(ctx, host, n)
		},
		MaxIdleConnsPerHost: 2,
		IdleConnTimeout:     30 * time.Second,
	}
}

func (inv Invite) base() string {
	return "http://" + net.JoinHostPort(inv.Host, strconv.Itoa(inv.Port)) + "/v1/s/" + url.PathEscape(inv.Share)
}

func (inv Invite) wsURL(kind, client string) string {
	q := url.Values{"k": {inv.Key}, "c": {client}}
	return "ws" + strings.TrimPrefix(inv.base(), "http") + "/" + kind + "?" + q.Encode()
}

// unreachable says why the computer that shares a session can't be reached, in words.
func unreachable(inv Invite) error {
	who := "the computer that shares it"
	if inv.By != "" {
		who = inv.By + "'s computer"
	}
	return fmt.Errorf("couldn't reach %s over Tailscale. It needs to be on, with Lungo open, and on your tailnet (someone on another tailnet shares their computer with you in Tailscale first)", who)
}

// Join looks up the share a code or link is for and makes it reachable from the page.
func (g *Guest) Join(ctx context.Context, link string) (JoinInfo, error) {
	inv, err := ParseLink(link)
	if err != nil {
		return JoinInfo{}, err
	}
	if inv.Code != "" {
		if inv, err = g.Find(ctx, inv.Code); err != nil {
			return JoinInfo{}, err
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, inv.base()+"?"+url.Values{"k": {inv.Key}}.Encode(), nil)
	res, err := (&http.Client{Transport: g.transport()}).Do(req)
	if err != nil {
		return JoinInfo{}, unreachable(inv)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		why := strings.TrimSpace(string(body))
		if why == "" || res.StatusCode >= 500 {
			why = res.Status
		}
		return JoinInfo{}, errors.New(why)
	}
	var info ShareInfo
	if err := json.Unmarshal(body, &info); err != nil {
		return JoinInfo{}, unreachable(inv) // something else answers on that port
	}
	if inv.By == "" {
		inv.By, inv.Title = info.By.Name, info.Title // found from a code: the link kept says who
	}
	id := joinID(inv)
	g.mu.Lock()
	if g.joins[id] == nil {
		g.joins[id] = &joined{inv: inv, fwd: map[int]*forward{}}
	}
	g.mu.Unlock()
	out := JoinInfo{ID: id, Link: inv.Link(), Share: info}
	if g.terms != nil {
		out.Term = g.terms.URL("/collab/" + id + "/term")
		out.Presence = g.terms.URL("/collab/" + id + "/presence")
	}
	return out, nil
}

// Find asks the computers on the tailnet, this one too, which of them shares a session under
// code, and says how to reach it. Nothing is hosted anywhere to look codes up in: those whose
// codes start with its first character (CodeHint) are asked first, all at once, then the rest.
func (g *Guest) Find(ctx context.Context, code string) (Invite, error) {
	hosts, err := g.hosts(ctx)
	if err != nil {
		return Invite{}, err
	}
	var likely, rest []string
	for _, h := range hosts {
		if CodeHint(h) == code[0] {
			likely = append(likely, h)
		} else {
			rest = append(rest, h)
		}
	}
	busy := false
	for _, group := range [][]string{likely, rest} {
		inv, ok, refused := g.ask(ctx, group, code)
		if ok {
			return inv, nil
		}
		busy = busy || refused
	}
	if busy {
		return Invite{}, errors.New("a computer on your tailnet has had too many wrong codes put to it just now. Try again in a minute")
	}
	return Invite{}, fmt.Errorf("nobody on your tailnet is sharing %s. Check the code with them, and that Lungo is open on their computer", ShowCode(code))
}

// ask puts a code to hosts at once; the first that has it says the share and its key.
// refused: one of them turned the question away (too many wrong codes there).
func (g *Guest) ask(ctx context.Context, hosts []string, code string) (inv Invite, ok, refused bool) {
	if len(hosts) == 0 {
		return Invite{}, false, false
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	tr := g.transport()
	tr.DisableKeepAlives = true // one question each (in userspace mode each is a `tailscale nc`)
	client := &http.Client{Transport: tr}
	found := make(chan Invite, 1)
	var busy atomic.Bool
	var wg sync.WaitGroup
	at := make(chan struct{}, 32) // at most this many asked at a time
	for _, h := range hosts {
		for _, p := range g.Ports {
			wg.Add(1)
			go func() {
				defer wg.Done()
				select {
				case at <- struct{}{}:
					defer func() { <-at }()
				case <-ctx.Done():
					return
				}
				req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+net.JoinHostPort(h, strconv.Itoa(p))+"/v1/code/"+code, nil)
				res, err := client.Do(req)
				if err != nil {
					return
				}
				defer res.Body.Close()
				if res.StatusCode == http.StatusTooManyRequests {
					busy.Store(true)
				}
				var a CodeAnswer
				if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&a) != nil || !shareID.MatchString(a.Share) || a.Key == "" {
					return
				}
				select {
				case found <- Invite{Host: h, Port: p, Share: a.Share, Key: a.Key, Code: code}:
					cancel()
				default:
				}
			}()
		}
	}
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case inv = <-found:
		return inv, true, false
	case <-done:
		select {
		case inv = <-found:
			return inv, true, false
		default:
			return Invite{}, false, busy.Load()
		}
	}
}

// tailnetHosts is where a code is looked for: this computer and the others on the tailnet
// that are online and could run Lungo (computers shared from other tailnets too).
func tailnetHosts(ctx context.Context) ([]string, error) {
	s, err := tailnet.Local(ctx)
	if err != nil {
		return nil, errors.New("joining goes over Tailscale, and it isn't installed on this computer")
	}
	if s.BackendState != "Running" || s.Self.IPv4() == "" {
		return nil, errors.New("joining goes over Tailscale, and it isn't connected on this computer")
	}
	out := []string{s.Self.IPv4()}
	for _, p := range s.Peer {
		switch p.OS {
		case "iOS", "android", "tvOS":
			continue
		}
		if ip := p.IPv4(); ip != "" && p.Online {
			out = append(out, ip)
		}
	}
	return out, nil
}

func (g *Guest) invite(id string) (Invite, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	j := g.joins[id]
	if j == nil {
		return Invite{}, false
	}
	return j.inv, true
}

// serveProxy joins a connection from the page to the same one on the sharing computer.
func (g *Guest) serveProxy(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/collab/"), "/"), "/")
	if len(parts) != 2 || (parts[1] != "term" && parts[1] != "presence") {
		http.NotFound(w, r)
		return
	}
	inv, ok := g.invite(parts[0])
	client := r.URL.Query().Get("c")
	if !ok || !clientID.MatchString(client) {
		http.NotFound(w, r)
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	dctx, dcancel := context.WithTimeout(ctx, 15*time.Second)
	remote, res, err := websocket.Dial(dctx, inv.wsURL(parts[1], client), &websocket.DialOptions{HTTPClient: &http.Client{Transport: g.transport()}, CompressionMode: websocket.CompressionDisabled})
	dcancel()
	if err != nil {
		code, why := http.StatusBadGateway, unreachable(inv).Error()
		if res != nil && res.StatusCode >= 400 && res.StatusCode < 500 {
			code = res.StatusCode
			if res.Body != nil {
				b, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
				why = strings.TrimSpace(string(b))
			}
		}
		http.Error(w, why, code)
		return
	}
	defer remote.CloseNow()
	local, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	defer local.CloseNow()
	remote.SetReadLimit(32 << 20)
	local.SetReadLimit(4 << 20)

	errs := make(chan error, 2)
	go func() { errs <- relay(ctx, local, remote) }()
	go func() { errs <- relay(ctx, remote, local) }()
	err = <-errs
	// Whatever ended it says so on the other side too: the sharing computer's "stopped" reaches
	// the page, the page going away reaches the sharing computer.
	status, reason := websocket.StatusGoingAway, ""
	var ce websocket.CloseError
	if errors.As(err, &ce) {
		status, reason = ce.Code, ce.Reason
	}
	if status == websocket.StatusNoStatusRcvd || status == websocket.StatusAbnormalClosure {
		status = websocket.StatusGoingAway
	}
	local.Close(status, reason)
	remote.Close(status, reason)
}

func relay(ctx context.Context, dst, src *websocket.Conn) error {
	for {
		typ, b, err := src.Read(ctx)
		if err != nil {
			return err
		}
		if err := dst.Write(ctx, typ, b); err != nil {
			return err
		}
	}
}

// Forward makes a port the shared session listens on reachable on this computer: the same
// number when it is free here, the next free one when not. It returns the address.
func (g *Guest) Forward(id string, port int) (string, error) {
	g.mu.Lock()
	j := g.joins[id]
	if j == nil {
		g.mu.Unlock()
		return "", errors.New("not in that session")
	}
	if f := j.fwd[port]; f != nil {
		g.mu.Unlock()
		return localURL(f.local), nil
	}
	g.mu.Unlock()

	local := freePort(port)
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(local)))
	if err != nil {
		return "", err
	}
	f := &forward{lns: []net.Listener{ln}, local: local}
	// Browsers may try ::1 for "localhost" first.
	if l6, err := net.Listen("tcp", net.JoinHostPort("::1", strconv.Itoa(local))); err == nil {
		f.lns = append(f.lns, l6)
	}
	g.mu.Lock()
	if j.fwd[port] != nil { // two asked at once
		g.mu.Unlock()
		for _, l := range f.lns {
			l.Close()
		}
		return g.Forward(id, port)
	}
	j.fwd[port] = f
	inv := j.inv
	g.mu.Unlock()
	for _, l := range f.lns {
		go g.serveForward(l, inv, id, port)
	}
	return localURL(local), nil
}

func localURL(port int) string { return "http://localhost:" + strconv.Itoa(port) }

func (g *Guest) serveForward(ln net.Listener, inv Invite, id string, port int) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go func() {
			defer c.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			dctx, dcancel := context.WithTimeout(ctx, 15*time.Second)
			ws, _, err := websocket.Dial(dctx, inv.wsURL("port/"+strconv.Itoa(port), "port-"+id), &websocket.DialOptions{HTTPClient: &http.Client{Transport: g.transport()}, CompressionMode: websocket.CompressionDisabled})
			dcancel()
			if err != nil {
				return
			}
			nc := websocket.NetConn(ctx, ws, websocket.MessageBinary)
			defer nc.Close()
			Pipe(c, nc)
		}()
	}
}

// Forwarded lists the ports forwarded for a join: the share's port → the address here.
func (g *Guest) Forwarded(id string) map[int]string {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := map[int]string{}
	if j := g.joins[id]; j != nil {
		for p, f := range j.fwd {
			out[p] = localURL(f.local)
		}
	}
	return out
}

// Leave lets go of a share: its forwarded ports close.
func (g *Guest) Leave(id string) {
	g.mu.Lock()
	j := g.joins[id]
	delete(g.joins, id)
	g.mu.Unlock()
	if j == nil {
		return
	}
	for _, f := range j.fwd {
		for _, l := range f.lns {
			l.Close()
		}
	}
}

// Close leaves every share (the app is quitting).
func (g *Guest) Close() {
	g.mu.Lock()
	ids := make([]string, 0, len(g.joins))
	for id := range g.joins {
		ids = append(ids, id)
	}
	g.mu.Unlock()
	for _, id := range ids {
		g.Leave(id)
	}
}

// freePort is want when nothing here listens on it, else the next free one.
func freePort(want int) int {
	for p := want; p > 0 && p < want+200 && p < 65536; p++ {
		l, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p)))
		if err != nil {
			continue
		}
		l.Close()
		// Something on ::1 alone (a dev server on macOS often is) has the number too.
		if c, err := net.DialTimeout("tcp", net.JoinHostPort("::1", strconv.Itoa(p)), 100*time.Millisecond); err == nil {
			c.Close()
			continue
		}
		return p
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return want
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}
