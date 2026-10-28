// Package term runs commands in pseudo-terminals and serves them to the desktop app's
// terminal tabs over a local WebSocket. Binary frames carry terminal bytes both ways;
// text frames carry JSON control messages ({"type":"resize","cols":120,"rows":40}).
//
// A terminal outlives the WebSocket: the UI can drop and reconnect (a React re-render, a
// tab moved) and gets the recent output replayed. Closing a tab only detaches; for machine
// sessions tmux keeps the work running on the VM.
package term

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// replayLimit is how much recent output a reconnecting tab gets back.
const replayLimit = 512 * 1024

// staleQueries are what a program asked the terminal when it drew that output: what it is
// (tmux asks on attach), its colours, where the cursor is. Replayed to a tab that connects
// again, they would be answered again, long after the program stopped waiting, and the
// answers would arrive in it as keys typed (^[[?1;2c in a shell). The replay is for drawing
// only, so they are left out of it.
var staleQueries = regexp.MustCompile(`\x1b\[[>=]?0?c|\x1b\[\??[56]n|\x1b\[>0?q|\x1b\[\?u|\x1b\[\?[0-9]+\$p|\x1b\[1[468]t|\x1b\](1[0-2]|4;[0-9]+);\?(\x07|\x1b\\)|\x1bP[$+]q[^\x1b]*\x1b\\`)

// Info describes a running terminal.
type Info struct {
	ID      string    `json:"id"`
	Title   string    `json:"title"`
	URL     string    `json:"url"`
	Started time.Time `json:"started"`
	Exited  bool      `json:"exited"`
	Code    int       `json:"code"`
}

// Spec is what to run.
type Spec struct {
	Args  []string // program and arguments
	Env   []string // extra environment
	Dir   string
	Title string
	Cols  int
	Rows  int
	// Fixed: the size is set with Resize alone; what clients ask for is ignored. Someone a
	// session is shared with sees it at the session's own size.
	Fixed bool
	// Input sees what a client types before the program gets it; false drops it (someone who
	// may only watch).
	Input func([]byte) bool
}

// proc is the platform PTY: a reader/writer plus resize and wait.
type proc interface {
	io.ReadWriter
	Resize(cols, rows int) error
	Wait() (int, error)
	Kill()
	Close() error
	Pid() int
}

// Terminal is one running pseudo-terminal.
type Terminal struct {
	info  Info
	p     proc
	fixed bool
	input func([]byte) bool

	mu       sync.Mutex
	replay   []byte
	clients  map[*websocket.Conn]chan []byte
	lastSeen time.Time // when the last client left (or the terminal started)
	done     chan struct{}
}

// orphanAfter closes terminals nobody has looked at for this long (a reloaded UI loses
// its tabs; the processes behind them shouldn't linger). A tab that lost its connection
// gives up retrying after about a minute, so nothing can come back for one this old, and
// an abandoned attachment to a tmux session would keep influencing that session's size.
const orphanAfter = 2 * time.Minute

// Manager owns terminals and the WebSocket server.
type Manager struct {
	mu     sync.Mutex
	terms  map[string]*Terminal
	token  string
	addr   string
	srv    *http.Server
	mux    *http.ServeMux
	OnExit func(id string, code int)

	files map[string]string // files the page may load (a preview): unguessable ID → path
	pipes map[string]pipe   // commands the page may talk to (a machine's screen): ID → command
}

// pipe is a command whose input and output a page reaches as a WebSocket.
type pipe struct {
	name string
	args []string
}

// NewManager starts the WebSocket server on a random localhost port.
func NewManager() (*Manager, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	m := &Manager{terms: map[string]*Terminal{}, token: randHex(16), addr: ln.Addr().String()}
	mux := http.NewServeMux()
	mux.HandleFunc("/term/", m.serve)
	mux.HandleFunc("/file/", m.serveFile)
	mux.HandleFunc("/pipe/", m.servePipe)
	m.mux = mux
	m.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go m.srv.Serve(ln)
	go m.janitor()
	return m, nil
}

// Mount serves more of the page's connections under prefix (it ends in "/"), behind the same
// token as the terminals.
func (m *Manager) Mount(prefix string, h http.Handler) {
	m.mux.Handle(prefix, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("token")), []byte(m.token)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		h.ServeHTTP(w, r)
	}))
}

// URL is the page's address for path on this server (a WebSocket), token included.
func (m *Manager) URL(path string) string {
	return fmt.Sprintf("ws://%s%s?token=%s", m.addr, path, m.token)
}

// ShareFile lets the page load one file from this computer (to preview it) and returns the
// address. The address is the permission: it carries an ID nobody can guess, and nothing but
// that file is behind it.
func (m *Manager) ShareFile(path string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.files == nil {
		m.files = map[string]string{}
	}
	for id, p := range m.files {
		if p == path {
			return m.fileURL(id, path)
		}
	}
	id := randHex(16)
	m.files[id] = path
	return m.fileURL(id, path)
}

func (m *Manager) fileURL(id, path string) string {
	return fmt.Sprintf("http://%s/file/%s/%s", m.addr, id, url.PathEscape(filepath.Base(path)))
}

// Shared reports whether path was handed to the page with ShareFile.
func (m *Manager) Shared(path string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, p := range m.files {
		if p == path {
			return true
		}
	}
	return false
}

func (m *Manager) serveFile(w http.ResponseWriter, r *http.Request) {
	id, _, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/file/"), "/")
	m.mu.Lock()
	path := m.files[id]
	m.mu.Unlock()
	if path == "" {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	// The page reads text files itself (its origin differs by platform); media elements
	// ask for ranges, which ServeContent answers.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, filepath.Base(path), st.ModTime(), f)
}

// Pipe lets the page talk to a command over a WebSocket (binary frames both ways) and
// returns the address. Every connection runs the command afresh and ends it when it closes.
// It carries a machine's screen: the command is an ssh that reaches the screen sharing port.
func (m *Manager) Pipe(name string, args []string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pipes == nil {
		m.pipes = map[string]pipe{}
	}
	id := randHex(8)
	m.pipes[id] = pipe{name: name, args: args}
	return fmt.Sprintf("ws://%s/pipe/%s?token=%s", m.addr, id, m.token)
}

func (m *Manager) servePipe(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("token")), []byte(m.token)) != 1 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	m.mu.Lock()
	p, ok := m.pipes[strings.TrimPrefix(r.URL.Path, "/pipe/")]
	m.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	// A viewer may name the "binary" subprotocol; it is binary frames either way.
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled, Subprotocols: []string{"binary"}})
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(8 << 20)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	cmd := exec.CommandContext(ctx, p.name, p.args...)
	in, err := cmd.StdinPipe()
	if err != nil {
		return
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return
	}
	var errb strings.Builder
	cmd.Stderr = &errb
	if err := cmd.Start(); err != nil {
		c.Close(websocket.StatusInternalError, "couldn't start")
		return
	}
	go func() {
		defer cancel()
		buf := make([]byte, 64*1024)
		for {
			n, err := out.Read(buf)
			if n > 0 {
				if c.Write(ctx, websocket.MessageBinary, buf[:n]) != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		defer cancel()
		for {
			_, b, err := c.Read(ctx)
			if err != nil {
				return
			}
			if _, err := in.Write(b); err != nil {
				return
			}
		}
	}()
	<-ctx.Done()
	in.Close()
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	// Why it ended, for the page to show (ssh says when the port is closed or the machine is away).
	why := strings.TrimSpace(errb.String())
	if len(why) > 110 {
		why = why[:110]
	}
	c.Close(websocket.StatusNormalClosure, why)
}

func (m *Manager) janitor() {
	for range time.Tick(time.Minute) {
		m.mu.Lock()
		var stale []string
		for id, t := range m.terms {
			t.mu.Lock()
			if len(t.clients) == 0 && time.Since(t.lastSeen) > orphanAfter {
				stale = append(stale, id)
			}
			t.mu.Unlock()
		}
		m.mu.Unlock()
		for _, id := range stale {
			m.Close(id)
		}
	}
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Start launches a command in a new terminal.
func (m *Manager) Start(s Spec) (Info, error) {
	if len(s.Args) == 0 {
		return Info{}, errors.New("nothing to run")
	}
	if s.Cols <= 0 {
		s.Cols = 120
	}
	if s.Rows <= 0 {
		s.Rows = 32
	}
	p, err := start(s)
	if err != nil {
		return Info{}, err
	}
	id := randHex(6)
	t := &Terminal{
		info:     Info{ID: id, Title: s.Title, Started: time.Now()},
		p:        p,
		fixed:    s.Fixed,
		input:    s.Input,
		clients:  map[*websocket.Conn]chan []byte{},
		lastSeen: time.Now(),
		done:     make(chan struct{}),
	}
	t.info.URL = fmt.Sprintf("ws://%s/term/%s?token=%s", m.addr, id, m.token)
	m.mu.Lock()
	m.terms[id] = t
	m.mu.Unlock()
	go t.pump()
	go func() {
		code, _ := p.Wait()
		// Let the reader drain the last output before telling clients.
		time.Sleep(100 * time.Millisecond)
		t.mu.Lock()
		t.info.Exited, t.info.Code = true, code
		t.mu.Unlock()
		close(t.done)
		if m.OnExit != nil {
			m.OnExit(id, code)
		}
	}()
	return t.Info(), nil
}

// Info returns a terminal's current info.
func (t *Terminal) Info() Info {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.info
}

// pump copies PTY output into the replay buffer and to every connected client.
func (t *Terminal) pump() {
	buf := make([]byte, 32*1024)
	for {
		n, err := t.p.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			t.mu.Lock()
			t.replay = append(t.replay, chunk...)
			// Trimmed back in steps, not on every read: past the limit each trim copies it all.
			if len(t.replay) > replayLimit+replayLimit/4 {
				t.replay = append([]byte(nil), t.replay[len(t.replay)-replayLimit:]...)
			}
			for c, ch := range t.clients {
				select {
				case ch <- chunk:
				default:
					// A client this far behind would show a screen with pieces missing. It is
					// let go instead: it connects again and gets the screen whole from the
					// replay. (A stuck client must not block the terminal either way.)
					delete(t.clients, c)
					go c.Close(websocket.StatusTryAgainLater, "fell behind")
				}
			}
			t.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

// List returns all terminals.
func (m *Manager) List() []Info {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Info, 0, len(m.terms))
	for _, t := range m.terms {
		out = append(out, t.Info())
	}
	return out
}

// Get returns a terminal's info.
func (m *Manager) Get(id string) (Info, bool) {
	m.mu.Lock()
	t := m.terms[id]
	m.mu.Unlock()
	if t == nil {
		return Info{}, false
	}
	return t.Info(), true
}

// Probe reports what a terminal is doing right now: the folder of the program in front and
// whether Claude Code runs in it. The UI uses it to name local panes and to open new panes
// "like this one".
func (m *Manager) Probe(id string) (Probe, error) {
	m.mu.Lock()
	t := m.terms[id]
	m.mu.Unlock()
	if t == nil {
		return Probe{}, errors.New("no such terminal")
	}
	return probe(t.p.Pid()), nil
}

// Resize changes a terminal's size.
func (m *Manager) Resize(id string, cols, rows int) error {
	m.mu.Lock()
	t := m.terms[id]
	m.mu.Unlock()
	if t == nil {
		return errors.New("no such terminal")
	}
	return t.p.Resize(cols, rows)
}

// Close ends a terminal's process.
func (m *Manager) Close(id string) {
	m.mu.Lock()
	t := m.terms[id]
	delete(m.terms, id)
	m.mu.Unlock()
	if t == nil {
		return
	}
	t.p.Kill()
	t.p.Close()
}

// CloseAll ends every terminal and stops the server.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.terms))
	for id := range m.terms {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.Close(id)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	m.srv.Shutdown(ctx)
}

type control struct {
	Type string `json:"type"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
	Data string `json:"data"`
}

func (m *Manager) serve(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("token")), []byte(m.token)) != 1 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	m.ServeTerminal(w, r, strings.TrimPrefix(r.URL.Path, "/term/"))
}

// ServeTerminal connects a WebSocket to a terminal. The caller has checked who is asking
// (the page's own connections carry the token; a shared session's guests are let in by the
// share).
func (m *Manager) ServeTerminal(w http.ResponseWriter, r *http.Request, id string) {
	m.mu.Lock()
	t := m.terms[id]
	m.mu.Unlock()
	if t == nil {
		http.Error(w, "no such terminal", http.StatusNotFound)
		return
	}
	// The token authenticates; the webview's origin (wails://, wails.localhost or the
	// dev server) varies by platform, so origins aren't checked.
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	c.SetReadLimit(1 << 20)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	out := make(chan []byte, 1024)
	t.mu.Lock()
	replay := staleQueries.ReplaceAll(t.replay, nil)
	t.clients[c] = out
	exited, code := t.info.Exited, t.info.Code
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		delete(t.clients, c)
		t.lastSeen = time.Now()
		t.mu.Unlock()
		c.CloseNow()
	}()

	if len(replay) > 0 {
		if err := c.Write(ctx, websocket.MessageBinary, replay); err != nil {
			return
		}
	}
	if exited {
		sendExit(ctx, c, code)
		return
	}

	// Writer: PTY output and exit notice to the client.
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case b := <-out:
				// Coalesce whatever else is queued into one frame.
				for more := true; more; {
					select {
					case nb := <-out:
						b = append(b, nb...)
					default:
						more = false
					}
				}
				if err := c.Write(ctx, websocket.MessageBinary, b); err != nil {
					cancel()
					return
				}
			case <-t.done:
				for more := true; more; {
					select {
					case b := <-out:
						c.Write(ctx, websocket.MessageBinary, b)
					default:
						more = false
					}
				}
				sendExit(ctx, c, t.Info().Code)
				cancel()
				return
			}
		}
	}()

	// Reader: keystrokes and control messages from the client.
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageBinary {
			if t.input != nil && !t.input(data) {
				continue
			}
			if _, err := t.p.Write(data); err != nil {
				return
			}
			continue
		}
		var msg control
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		switch msg.Type {
		case "resize":
			if msg.Cols > 0 && msg.Rows > 0 && !t.fixed {
				t.p.Resize(msg.Cols, msg.Rows)
			}
		case "input":
			if t.input == nil || t.input([]byte(msg.Data)) {
				t.p.Write([]byte(msg.Data))
			}
		}
	}
}

func sendExit(ctx context.Context, c *websocket.Conn, code int) {
	b, _ := json.Marshal(map[string]any{"type": "exit", "code": code})
	c.Write(ctx, websocket.MessageText, b)
}
