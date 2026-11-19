package engine

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"skybuild/internal/claudeacct"
	"skybuild/internal/config"
	"skybuild/internal/paths"
)

// The Claude proxy: sessions never stop at a usage limit.
//
// Claude Code sends its requests to ANTHROPIC_BASE_URL when it is set; the claude wrapper
// points it here (127.0.0.1) while the proxy runs. The proxy sends each request on to Anthropic
// with the token of the account sessions use now. When an account is used up, Anthropic refuses
// the request (429, "rejected") before a byte of the answer comes back, so the proxy marks the
// account used up, moves sessions to the next one with room, and sends the same request again
// with it: Claude gets its answer as if nothing happened. No restart, nothing typed, agents and
// background jobs untouched. Every answer also says how much of its windows the account has
// used, which the proxy keeps (the accounts' usage, without checks).
//
// When every account is used up, the refusal goes back to Claude with the earliest reset of
// any of them, so Claude's own "continuing automatically at…" goes on as soon as one frees up.
//
// It runs on its own (launchd keeps it up; see desktop's claude proxy agent), so sessions keep
// it when the app is closed. A Claude started while it is down goes direct, as before.

// ClaudeProxyPort is where the proxy listens, on 127.0.0.1 only.
const ClaudeProxyPort = 47865

// ClaudeProxyHealth answers "ok <version>" while the proxy runs.
const ClaudeProxyHealth = "/lungo-proxy/health"

const anthropicAPI = "https://api.anthropic.com"

type claudeProxy struct {
	e       *Engine
	version string
	client  *http.Client
	mu      sync.Mutex
	saved   map[string]time.Time         // account → when its usage was last written
	last    map[string]string            // account → its state when last written
	limited map[string]claudeacct.Status // what the proxy saw refused, not yet in the file
}

// ServeClaudeProxy runs the proxy until ctx ends.
func (e *Engine) ServeClaudeProxy(ctx context.Context, version string) error {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", ClaudeProxyPort))
	if err != nil {
		return err
	}
	p := &claudeProxy{
		e:       e,
		version: version,
		client: &http.Client{Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment, ForceAttemptHTTP2: true, MaxIdleConnsPerHost: 32,
			IdleConnTimeout: 90 * time.Second, TLSHandshakeTimeout: 15 * time.Second, ResponseHeaderTimeout: 10 * time.Minute,
		}},
		saved: map[string]time.Time{}, last: map[string]string{}, limited: map[string]claudeacct.Status{},
	}
	srv := &http.Server{Handler: p, ReadHeaderTimeout: 30 * time.Second}
	go func() {
		<-ctx.Done()
		srv.Close()
	}()
	proxyLog("listening on %s (%s)", ln.Addr(), version)
	if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

var proxyHop = map[string]bool{"Connection": true, "Keep-Alive": true, "Proxy-Connection": true, "Proxy-Authorization": true, "Te": true, "Trailer": true, "Transfer-Encoding": true, "Upgrade": true, "Host": true, "Content-Length": true}

func (p *claudeProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == ClaudeProxyHealth {
		fmt.Fprintf(w, "ok %s\n", p.version)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 256<<20))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	// Only Claude's own requests are sent with the pool's accounts; anything else (an API key,
	// the login's profile) goes on as it came.
	// Only a request already signed in with one of the pool's tokens (the wrapper starts Claude
	// with the active one) is sent with the pool's accounts: another program here can't spend
	// them through the proxy.
	pooled := strings.HasPrefix(r.URL.Path, "/v1/messages") && poolToken(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	tried := map[string]bool{}
	var refused *http.Response
	var refusedBody []byte
	for {
		token, id := "", ""
		if pooled {
			id, token = p.account(tried)
			if id == "" {
				break // every account is used up, or none has a token
			}
		}
		resp, err := p.send(r, body, token)
		if err != nil {
			proxyLog("%s: %v", r.URL.Path, err)
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		if id != "" {
			switch {
			case resp.StatusCode == http.StatusTooManyRequests && strings.EqualFold(resp.Header.Get("Anthropic-Ratelimit-Unified-Status"), "rejected"):
				// Used up: mark it, and the same request goes again with the next account.
				p.noteLimited(id, resp.Header)
				tried[id] = true
				refusedBody, _ = io.ReadAll(resp.Body)
				resp.Body.Close()
				refused = resp
				continue
			case resp.StatusCode == http.StatusUnauthorized:
				p.noteRejected(id)
				tried[id] = true
				refusedBody, _ = io.ReadAll(resp.Body)
				resp.Body.Close()
				refused = resp
				continue
			}
			p.noteUsage(id, resp.Header)
		}
		relay(w, resp)
		return
	}
	if refused == nil { // no account with a token: go on with the session's own
		resp, err := p.send(r, body, "")
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		relay(w, resp)
		return
	}
	// Every account is used up: Claude waits for the first to come back.
	if next := earliestReset(); !next.IsZero() {
		at := strconv.FormatInt(next.Unix(), 10)
		for k := range refused.Header {
			if lk := strings.ToLower(k); strings.HasPrefix(lk, "anthropic-ratelimit-unified") && strings.HasSuffix(lk, "reset") {
				refused.Header.Set(k, at)
			}
		}
	}
	proxyLog("every account is used up; %s refused", r.URL.Path)
	refused.Body = io.NopCloser(bytes.NewReader(refusedBody))
	relay(w, refused)
}

// send sends a request on to Anthropic, with token as its login ("" keeps the one it came with).
func (p *claudeProxy) send(r *http.Request, body []byte, token string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(r.Context(), r.Method, anthropicAPI+r.URL.RequestURI(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for k, v := range r.Header {
		if !proxyHop[k] {
			req.Header[k] = v
		}
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return p.client.Do(req)
}

// relay sends an answer back to Claude as it comes (answers stream).
func relay(w http.ResponseWriter, resp *http.Response) {
	defer resp.Body.Close()
	for k, v := range resp.Header {
		if !proxyHop[k] {
			w.Header()[k] = v
		}
	}
	w.WriteHeader(resp.StatusCode)
	f, _ := w.(http.Flusher)
	buf := make([]byte, 32<<10)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if f != nil {
				f.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

// account is the account to send with: the one sessions use now while it has room, else the
// next with room (which becomes the one sessions use). Not those already tried.
func (p *claudeProxy) account(tried map[string]bool) (string, string) {
	c, err := config.Load()
	if err != nil {
		return "", ""
	}
	statuses := claudeacct.Load()
	p.mu.Lock()
	for id, st := range p.limited { // refused just now, maybe not in the file yet
		statuses[id] = st
	}
	p.mu.Unlock()
	has := func(id string) bool { return !tried[id] && claudeacct.Token(id) != "" }
	active := activeID(c)
	if active != "" && !tried[active] && statuses[active].Usable() {
		if t := claudeacct.Token(active); t != "" {
			return active, t
		}
	}
	next := ""
	if c.Settings.ClaudeSmart() {
		next = smartPick(rankAccounts(c, statuses, has), active)
	} else if a := pickNext(c.ClaudeAccounts, statuses, active, has); a != nil {
		next = a.ID
	}
	if next == "" || tried[next] || !statuses[next].Usable() {
		return "", ""
	}
	t := claudeacct.Token(next)
	if t == "" {
		return "", ""
	}
	if next != active {
		from := accountName(c, active)
		if name, err := p.e.setActiveAccount(next, false); err == nil {
			proxyLog("%s is used up: sessions go on with %s", from, name)
		}
	}
	return next, t
}

// poolToken reports whether a token is one of the pool's accounts'.
func poolToken(tok string) bool {
	if tok == "" {
		return false
	}
	c, err := config.Load()
	if err != nil {
		return false
	}
	for _, a := range c.ClaudeAccounts {
		if t := claudeacct.Token(a.ID); t != "" && t == tok {
			return true
		}
	}
	return false
}

func accountName(c *config.Config, id string) string {
	for _, a := range c.ClaudeAccounts {
		if a.ID == id {
			return a.Name()
		}
	}
	return id
}

// usageFrom reads an answer's usage headers into an account's status.
func usageFrom(h http.Header, now time.Time) (claudeacct.Status, bool) {
	get := func(k string) string { return h.Get("Anthropic-Ratelimit-Unified-" + k) }
	status := strings.ToLower(get("Status"))
	if status == "" {
		return claudeacct.Status{}, false
	}
	unix := func(s string) time.Time {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil || n <= 0 {
			return time.Time{}
		}
		return time.Unix(n, 0)
	}
	st := claudeacct.Status{CheckedAt: now, Windows: map[string]*claudeacct.Window{}}
	for short, name := range map[string]string{"5h": "five_hour", "7d": "seven_day"} {
		u := get(short + "-Utilization")
		if u == "" {
			continue
		}
		f, _ := strconv.ParseFloat(u, 64)
		st.Windows[name] = &claudeacct.Window{Utilization: f, ResetsAt: unix(get(short + "-Reset"))}
	}
	switch status {
	case "rejected":
		st.State, st.LimitType, st.ResetsAt = claudeacct.StateLimited, get("Representative-Claim"), unix(get("Reset"))
		if st.ResetsAt.IsZero() {
			st.ResetsAt = now.Add(time.Hour)
		}
		st.Message = "Used up until " + st.ResetsAt.Local().Format("Jan 2 3:04pm")
	case "allowed_warning":
		st.State = claudeacct.StateWarning
	default:
		st.State = claudeacct.StateOK
	}
	return st, true
}

// noteLimited marks an account used up, as Anthropic just said.
func (p *claudeProxy) noteLimited(id string, h http.Header) {
	st, ok := usageFrom(h, time.Now())
	if !ok {
		st = claudeacct.Status{State: claudeacct.StateLimited, ResetsAt: time.Now().Add(time.Hour), CheckedAt: time.Now()}
	}
	p.mu.Lock()
	p.limited[id] = st
	p.mu.Unlock()
	p.save(id, st)
}

// noteRejected marks an account whose token Anthropic turned down.
func (p *claudeProxy) noteRejected(id string) {
	st := claudeacct.Status{State: claudeacct.StateInvalid, Message: "Token rejected", CheckedAt: time.Now()}
	p.mu.Lock()
	p.limited[id] = st
	p.mu.Unlock()
	p.save(id, st)
}

// noteUsage keeps what an answer says about the account's usage (written at most every two
// minutes, or when its state changes).
func (p *claudeProxy) noteUsage(id string, h http.Header) {
	st, ok := usageFrom(h, time.Now())
	if !ok {
		return
	}
	p.mu.Lock()
	delete(p.limited, id)
	changed := p.last[id] != st.State
	due := time.Since(p.saved[id]) > 2*time.Minute
	p.mu.Unlock()
	if changed || due {
		p.save(id, st)
	}
}

func (p *claudeProxy) save(id string, st claudeacct.Status) {
	p.mu.Lock()
	p.saved[id], p.last[id] = time.Now(), st.State
	p.mu.Unlock()
	if err := claudeacct.Save(id, st); err != nil {
		proxyLog("saving %s: %v", id, err)
	}
}

// earliestReset is when the first used-up account frees up.
func earliestReset() time.Time {
	var next time.Time
	for _, st := range claudeacct.Load() {
		if st.State == claudeacct.StateLimited && st.ResetsAt.After(time.Now()) && (next.IsZero() || st.ResetsAt.Before(next)) {
			next = st.ResetsAt
		}
	}
	return next
}

// proxyLog notes what the proxy did (switches, errors) in ~/.skybuild/logs/claude-proxy.log.
func proxyLog(f string, a ...any) {
	dir := paths.Logs()
	_ = os.MkdirAll(dir, 0o700)
	fh, err := os.OpenFile(filepath.Join(dir, "claude-proxy.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer fh.Close()
	fmt.Fprintf(fh, "%s %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(f, a...))
}

// ClaudeProxyUp reports whether the proxy answers here, and its version.
func ClaudeProxyUp(ctx context.Context) (string, bool) {
	c, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(c, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", ClaudeProxyPort, ClaudeProxyHealth), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
	v, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "ok ")
	return v, ok && resp.StatusCode == http.StatusOK
}
