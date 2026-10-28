package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"skybuild/internal/collab"
	"skybuild/internal/engine"
	"skybuild/internal/model"
	"skybuild/internal/paths"
	"skybuild/internal/tailnet"
)

// Sessions shared with other people, like a document: they see it, type into it, point at
// things in it and open its ports on their own computer (see internal/collab). It all goes
// over Tailscale; nothing is hosted anywhere.

type sharing struct {
	store *collab.Store
	hub   *collab.Hub
	guest *collab.Guest
	stop  context.CancelFunc

	mu      sync.Mutex
	pending string // an invite link the app was opened with, before the page asked
	me      *tailnet.Person
	meAt    time.Time
}

// collabPort is where this computer serves its shared sessions. A development build on its
// own tmux server gets its own (SKY_COLLAB_PORT sets it).
func collabPort() int {
	if v, err := strconv.Atoi(os.Getenv("SKY_COLLAB_PORT")); err == nil && v > 0 {
		return v
	}
	if os.Getenv("SKY_TMUX_SOCKET") != "" {
		return collab.DefaultPort + 1
	}
	return collab.DefaultPort
}

// collabDir keeps the shares. A build on its own tmux server has sessions of its own, so it
// keeps its own shares too.
func collabDir() string {
	if s := os.Getenv("SKY_TMUX_SOCKET"); s != "" {
		return filepath.Join(paths.Root(), "collab-"+s)
	}
	return filepath.Join(paths.Root(), "collab")
}

func newSharing() *sharing { return &sharing{store: collab.NewStore(collabDir())} }

// startSharing makes the hub and the guest side (once the terminal server is up).
func (a *App) startSharing() {
	a.share.hub = collab.NewHub(collabBackend{a}, a.terms, a.share.store, collabPort())
	a.share.guest = collab.NewGuest(a.terms)
	if os.Getenv("SKY_TMUX_SOCKET") != "" {
		// A development build finds codes of the others too (they serve on their own port).
		a.share.guest.Ports = []int{collab.DefaultPort, collab.DefaultPort + 1}
	}
}

func (a *App) runSharing() {
	ctx, cancel := context.WithCancel(context.Background())
	a.share.stop = cancel
	go a.share.hub.Run(ctx)
}

func (a *App) stopSharing() {
	if a.share.stop != nil {
		a.share.stop()
	}
	if a.share.guest != nil {
		a.share.guest.Close()
	}
}

// ---------- what the hub asks of the app ----------

type collabBackend struct{ a *App }

func (b collabBackend) AttachArgs(machine, session string) ([]string, error) {
	if !engine.IsLocal(machine) {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		b.a.eng.ReadyTerminals(ctx, machine) // ride on the machine's shared connection
		cancel()
	}
	return b.a.eng.GuestAttachArgs(machine, session)
}

func (b collabBackend) Info(machine, session string) collab.SessionInfo {
	info := collab.SessionInfo{Where: machine}
	if engine.IsLocal(machine) {
		info.Where = b.Me(context.Background()).Device
	}
	for _, s := range b.a.poll.current().Sessions {
		if s.Machine != machine || s.Name != session {
			continue
		}
		info.Title, info.Branch, info.State, info.Agent = s.Title, s.Branch, s.State, s.Agent
		info.Mouse, info.Alt, info.ScrollKey = s.Mouse, s.Alt, s.ScrollKey
		if s.Claude && info.Agent == "" {
			info.Agent = "claude"
		}
		if s.Path != "" {
			info.Folder = filepath.Base(s.Path)
		}
	}
	return info
}

func (b collabBackend) WindowSize(ctx context.Context, machine, session string) (int, int, error) {
	return b.a.eng.WindowSize(ctx, machine, session)
}

func (b collabBackend) Ports(ctx context.Context, machine, session string) ([]model.Port, error) {
	all, err := b.a.eng.SessionPorts(ctx, machine)
	if err != nil {
		return nil, err
	}
	return all[session], nil
}

// DialPort reaches a port a session's program listens on: on this computer at the address it
// listens on, on a machine through a tunnel (the same one its pane's port button opens).
func (b collabBackend) DialPort(ctx context.Context, machine string, p model.Port) (net.Conn, error) {
	var d net.Dialer
	if !engine.IsLocal(machine) {
		t, err := b.a.eng.Forward(ctx, machine, p.Port, 0)
		if err != nil {
			return nil, err
		}
		wruntime.EventsEmit(b.a.ctx, "tunnels", b.a.Tunnels())
		return d.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(t.LocalPort)))
	}
	hosts := []string{"127.0.0.1", "::1"}
	if strings.Contains(p.Address, ":") && strings.Trim(p.Address, "[]:*") != "" && p.Address != "::" {
		hosts = []string{"::1", "127.0.0.1"} // listening on ::1 alone, as dev servers on macOS often do
	}
	var err error
	for _, h := range hosts {
		var c net.Conn
		if c, err = d.DialContext(ctx, "tcp", net.JoinHostPort(h, strconv.Itoa(p.Port))); err == nil {
			return c, nil
		}
	}
	return nil, err
}

// Me is who is signed in to Tailscale here (asked at most once a minute: the hub asks often).
func (b collabBackend) Me(ctx context.Context) *tailnet.Person {
	s := b.a.share
	s.mu.Lock()
	if s.me != nil && time.Since(s.meAt) < time.Minute {
		defer s.mu.Unlock()
		return s.me
	}
	s.mu.Unlock()
	me := &tailnet.Person{}
	if st, err := tailnet.Local(ctx); err == nil {
		me = st.Me()
	} else {
		me.Device, _ = os.Hostname()
		me.Name = me.Device
	}
	s.mu.Lock()
	s.me, s.meAt = me, time.Now()
	s.mu.Unlock()
	return me
}

func (b collabBackend) WhoIs(ctx context.Context, addr string) (*tailnet.Person, error) {
	return tailnet.WhoIs(ctx, addr)
}

// ---------- sharing a session ----------

// ShareView is a share with its codes and links, for the page.
type ShareView struct {
	ID       string `json:"id"`
	Machine  string `json:"machine"`
	Session  string `json:"session"`
	Title    string `json:"title"`
	EditCode string `json:"editCode"` // people with it can type: 7KX-4PQ
	ViewCode string `json:"viewCode"` // people with it can watch
	EditLink string `json:"editLink"` // the same as links: lungo://join/7KX-4PQ
	ViewLink string `json:"viewLink"`
}

// tailnetSelf is this computer's tailnet address.
func tailnetSelf(ctx context.Context) (string, error) {
	s, err := tailnet.Local(ctx)
	if err != nil {
		return "", errors.New("sharing goes over Tailscale, and it isn't installed on this computer")
	}
	if s.BackendState != "Running" || s.Self.IPv4() == "" {
		return "", errors.New("sharing goes over Tailscale, and it isn't connected on this computer")
	}
	return s.Self.IPv4(), nil
}

func (a *App) shareView(s collab.Share) ShareView {
	return ShareView{
		ID: s.ID, Machine: s.Machine, Session: s.Session, Title: s.Title,
		EditCode: collab.ShowCode(s.EditCode), ViewCode: collab.ShowCode(s.ViewCode),
		EditLink: collab.CodeLink(s.EditCode), ViewLink: collab.CodeLink(s.ViewCode),
	}
}

// hubUp makes sure some window of this app serves the shares (it may be another window).
func (a *App) hubUp(ctx context.Context) error {
	if a.share.hub.Serving() {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(a.share.hub.Port())+"/v1/ping", nil)
	res, err := http.DefaultClient.Do(req)
	if err == nil {
		res.Body.Close()
		if res.StatusCode == http.StatusOK {
			return nil
		}
	}
	return fmt.Errorf("another program is using port %d, which Lungo shares sessions on", a.share.hub.Port())
}

// ShareSession shares a session (or returns its share, when it is shared already).
func (a *App) ShareSession(machine, session, title string) (ShareView, error) {
	ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
	defer cancel()
	if session == "" {
		return ShareView{}, errors.New("only a session can be shared")
	}
	ip, err := tailnetSelf(ctx)
	if err != nil {
		return ShareView{}, err
	}
	if err := a.hubUp(ctx); err != nil {
		return ShareView{}, err
	}
	var out collab.Share
	err = a.share.store.Update(func(list []collab.Share) ([]collab.Share, error) {
		for i, s := range list {
			if s.Machine == machine && s.Session == session {
				if title != "" {
					list[i].Title = title
				}
				list[i].Recode(ip, list[:i])
				out = list[i]
				return list, nil
			}
		}
		out = collab.NewShare(machine, session, title, ip)
		out.Recode(ip, list) // two shares here never have the same code
		return append(list, out), nil
	})
	if err != nil {
		return ShareView{}, err
	}
	return a.shareView(out), nil
}

// Shares lists this computer's shared sessions with their codes.
func (a *App) Shares() []ShareView {
	out := []ShareView{}
	list, _ := a.share.store.Load()
	for _, s := range list {
		if s.EditCode == "" || s.ViewCode == "" {
			// Shared before there were codes: give them some (once).
			ctx, cancel := context.WithTimeout(a.ctx, 8*time.Second)
			ip, err := tailnetSelf(ctx)
			cancel()
			if err == nil && a.share.store.Update(func(l []collab.Share) ([]collab.Share, error) {
				for i := range l {
					l[i].Recode(ip, l[:i])
				}
				return l, nil
			}) == nil {
				list, _ = a.share.store.Load()
			}
			break
		}
	}
	for _, s := range list {
		out = append(out, a.shareView(s))
	}
	return out
}

func (a *App) changeShare(id string, fn func(*collab.Share)) error {
	return a.share.store.Update(func(list []collab.Share) ([]collab.Share, error) {
		for i := range list {
			if list[i].ID == id {
				fn(&list[i])
				return list, nil
			}
		}
		return list, errors.New("that session isn't shared any more")
	})
}

// StopSharing ends a share: everyone in it is seen out, and its links stop working.
func (a *App) StopSharing(id string) error {
	return a.share.store.Update(func(list []collab.Share) ([]collab.Share, error) {
		return slices.DeleteFunc(list, func(s collab.Share) bool { return s.ID == id }), nil
	})
}

// SetShareRole lets someone in a share type, or only watch.
func (a *App) SetShareRole(id, who string, canType bool) error {
	role := collab.View
	if canType {
		role = collab.Edit
	}
	return a.changeShare(id, func(s *collab.Share) { s.SetRole(who, role) })
}

// RemoveFromShare takes someone out of a share; their link no longer lets them in.
func (a *App) RemoveFromShare(id, who string) error {
	return a.changeShare(id, func(s *collab.Share) { s.Remove(who) })
}

// CollabLocal is how this computer's own panes reach the hub: everyone's state (watch) and,
// per share, the pointers and selections (presence, with the share's id in place of %s).
type CollabLocal struct {
	Watch    string `json:"watch"`
	Presence string `json:"presence"`
}

func (a *App) CollabLocal() (CollabLocal, error) {
	key, err := a.share.store.LocalKey()
	if err != nil {
		return CollabLocal{}, err
	}
	base := "ws://127.0.0.1:" + strconv.Itoa(a.share.hub.Port())
	return CollabLocal{Watch: base + "/v1/local/watch?local=" + key, Presence: base + "/v1/s/%s/presence?local=" + key}, nil
}

// ---------- joining someone else's ----------

// JoinShare opens an invite, a code or a link: the share it is for, and how the page
// reaches it.
func (a *App) JoinShare(link string) (collab.JoinInfo, error) {
	return a.share.guest.Join(a.ctx, link)
}

// LeaveShare lets go of a joined share (its forwarded ports close).
func (a *App) LeaveShare(id string) { a.share.guest.Leave(id) }

// ForwardSharedPort makes a port of a joined share's session reachable here; it returns the
// address to open.
func (a *App) ForwardSharedPort(id string, port int) (string, error) {
	return a.share.guest.Forward(id, port)
}

// SharedPorts lists the ports forwarded for a joined share: its port → the address here.
func (a *App) SharedPorts(id string) map[int]string { return a.share.guest.Forwarded(id) }

// openedWith: the app was asked to open a link (an invite clicked in a chat).
func (a *App) openedWith(link string) {
	if !strings.HasPrefix(link, "lungo:") {
		return
	}
	a.share.mu.Lock()
	a.share.pending = link
	a.share.mu.Unlock()
	if a.ctx != nil {
		wruntime.EventsEmit(a.ctx, "collab:link", link)
	}
}

// PendingLink is the invite link the app was opened with, once ("" when none).
func (a *App) PendingLink() string {
	a.share.mu.Lock()
	defer a.share.mu.Unlock()
	l := a.share.pending
	a.share.pending = ""
	return l
}
