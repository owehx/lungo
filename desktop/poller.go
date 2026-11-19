package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"skybuild/internal/engine"
	"skybuild/internal/model"
	"skybuild/internal/paths"
)

// poller keeps sessions and machine status fresh while the app is open, and notifies when
// a Claude session needs you or finishes.
//
// One window polls for all of them: the primary (see window.go). It publishes what it finds
// to ~/.skybuild/state/sessions-shared.json, which the other windows read within half a
// second; a window that opens shows the sessions at once. Any window refreshes on the spot
// after something it did (a session ended, one started) and shares the result the same way.
type poller struct {
	a *App

	mu         sync.Mutex
	last       SessionsView                // what the UI has: this computer's sessions, then the machines'
	local      []engine.Session            // this computer's part
	localErr   string                      // why it couldn't be read, last time
	remote     map[string][]engine.Session // each machine's part, as it last answered
	remoteErr  map[string]string           // machines that didn't answer, and why
	states     map[string]string           // session key → last Claude state
	primed     bool
	keep       map[string][]string // shell sessions this window's panes point at, per machine
	quietSince time.Time           // start, or the last wake: no tidying right after
	shared     struct {            // the shared file as last read
		mod  time.Time
		size int64
	}
	// When a refresh of the machines and one of this computer started (zero: none running).
	// A refresh that runs far too long no longer holds the next one back: see begin.
	remoteSince atomic.Int64
	localSince  atomic.Int64
	anchored    atomic.Bool // the sessions here answer to this app for folder access
	watching    atomic.Bool // tmux tells this window about changes here (see watchLocal)
	following   atomic.Bool // acting on a /login here (see FollowLocalLogin)
	nudged      atomic.Bool // a refresh asked for by tmux is waiting to run
	lastLocal   atomic.Int64
	limitKick   atomic.Int64 // when a session stopped at a limit last ran a rotation pass early
	mirrors     mirrors      // folders here following sessions that moved to machines (mirrors.go)
}

// begin starts a refresh unless one is already running, and reports whether it did. One
// that has been running longer than stuck is given up on (it is written to the log, with
// what every part of the app was doing): a refresh that hangs must not stop all the next.
func begin(since *atomic.Int64, stuck time.Duration, what string) (int64, bool) {
	now := time.Now().UnixNano()
	for {
		was := since.Load()
		if was != 0 && time.Duration(now-was) < stuck {
			return 0, false
		}
		if since.CompareAndSwap(was, now) {
			if was != 0 {
				noteErr("%s refresh running for %s: starting another", what, time.Duration(now-was).Round(time.Second))
				go writeStacks(what+" refresh stalled", false)
			}
			return now, true
		}
	}
}

// end marks a refresh finished, unless a newer one has taken over since.
func end(since *atomic.Int64, started int64) { since.CompareAndSwap(started, 0) }

func newPoller(a *App) *poller {
	empty := SessionsView{Sessions: []engine.Session{}, Errors: map[string]string{}}
	return &poller{a: a, states: map[string]string{}, last: empty, remote: map[string][]engine.Session{}, remoteErr: map[string]string{}, quietSince: time.Now()}
}

func (p *poller) primary() bool { return p.a.win.primary.Load() }

func sharedSessionsFile() string { return filepath.Join(paths.State(), "sessions-shared.json") }

func (p *poller) run(ctx context.Context) {
	sessionsTick := time.NewTicker(5 * time.Second)
	machinesTick := time.NewTicker(60 * time.Second)
	claudeTick := time.NewTicker(60 * time.Second)
	reapTick := time.NewTicker(5 * time.Minute)
	localTick := time.NewTicker(2 * time.Second)
	shareTick := time.NewTicker(500 * time.Millisecond)
	mirrorTick := time.NewTicker(10 * time.Second)
	defer mirrorTick.Stop()
	accountsTick := time.NewTicker(3 * time.Second)
	defer accountsTick.Stop()
	defer shareTick.Stop()
	accountsSeen := accountFilesStamp()
	defer reapTick.Stop()
	defer localTick.Stop()
	go p.watchWake(ctx)
	defer sessionsTick.Stop()
	defer machinesTick.Stop()
	defer claudeTick.Stop()
	if p.primary() {
		go p.refreshLocal(ctx)
		go p.refresh(ctx)
		go p.a.RefreshMachines()
	} else {
		p.follow(ctx)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-sessionsTick.C:
			if p.primary() {
				go p.refresh(ctx)
			}
		case <-machinesTick.C:
			if p.primary() {
				go p.a.RefreshMachines()
			}
		case <-claudeTick.C:
			if p.primary() { // once, however many windows are open
				go p.claude(ctx)
			}
		case <-localTick.C:
			if p.primary() {
				p.watchLocal(ctx)
				// tmux says when something changes (watchLocal); this look catches what it
				// can't see, like Claude's own record of being busy.
				if time.Since(time.Unix(0, p.lastLocal.Load())) > 2500*time.Millisecond {
					go p.refreshLocal(ctx)
				}
				p.kickOnLimit(ctx)
			}
		case <-mirrorTick.C:
			if p.followsMirrors() {
				go p.followMirrors(ctx)
			}
		case <-shareTick.C:
			if !p.primary() {
				p.follow(ctx)
			}
		case <-accountsTick.C:
			// The accounts or the machines changed somewhere else (another window's refresh,
			// the background agent switched accounts, a usage check came in, the CLI): show
			// it now.
			// A /login in any Claude here: follow it now rather than at the next rotation pass.
			if p.primary() && engine.LocalLoginChanged() && !p.following.Swap(true) {
				go func() {
					defer p.following.Store(false)
					c, cancel := context.WithTimeout(ctx, 3*time.Minute)
					defer cancel()
					if to, err := p.a.eng.FollowLocalLogin(c, nil); err == nil && to != "" {
						p.a.announceFollow(to)
					}
					if acct := p.a.eng.LoginToAdd(); acct != nil {
						p.a.addLoginAccount(acct)
					}
					p.a.emitClaude()
				}()
			}
			if st := accountFilesStamp(); st != accountsSeen {
				accountsSeen = st
				p.a.emitClaude()
				if p.primary() {
					go p.refresh(ctx)
				} else {
					p.a.emitMachines()
				}
			}
		case <-reapTick.C:
			p.mu.Lock()
			keep, settled := p.keep, time.Since(p.quietSince) > 4*time.Minute
			p.mu.Unlock()
			// Not right after a start or a wake: panes are still finding their shells again.
			if p.primary() && settled {
				go p.a.eng.ReapShells(ctx, p.a.win.keepAll(keep)) // every window's shells, not only this one's
			}
		}
	}
}

// remoteList is every machine's sessions, newest first. Call with p.mu held.
func (p *poller) remoteList() []engine.Session {
	var out []engine.Session
	for _, list := range p.remote {
		out = append(out, list...)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	return out
}

// publishedSessions is every session the UI was last told about, this computer's included.
func (p *poller) publishedSessions() []engine.Session {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]engine.Session(nil), p.last.Sessions...)
}

// current is what the UI was last sent.
func (p *poller) current() SessionsView {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.last
}

// watchLocal has tmux report changes to this computer's sessions as they happen (the window
// that polls only, once): the list is looked at again right away, at most every 0.7s.
func (p *poller) watchLocal(ctx context.Context) {
	if !p.watching.CompareAndSwap(false, true) {
		return
	}
	go engine.WatchLocal(ctx, func() {
		if !p.nudged.CompareAndSwap(false, true) {
			return // one is on its way
		}
		go func() {
			defer p.nudged.Store(false)
			wait := 150 * time.Millisecond // let a burst of changes settle
			if since := time.Since(time.Unix(0, p.lastLocal.Load())); since < 700*time.Millisecond {
				wait = 700*time.Millisecond - since
			}
			time.Sleep(wait)
			p.refreshLocal(ctx)
		}()
	})
}

// refreshLocal lists the sessions on this computer. It is cheap (no network), so it runs
// often: a local pane's folder, title and Claude state follow within a couple of seconds.
// When the list can't be read, the sessions last seen stay (marked stale) and the reason is
// shown, rather than an empty list.
func (p *poller) refreshLocal(ctx context.Context) {
	started, ok := begin(&p.localSince, 20*time.Second, "local")
	if !ok {
		return
	}
	defer end(&p.localSince, started)
	p.lastLocal.Store(time.Now().UnixNano())
	if !p.anchored.Load() {
		p.anchored.Store(engine.AnchorLocalSessions(ctx, ownProgram()))
	}
	list, err := p.a.eng.LocalSessions(ctx)
	p.mu.Lock()
	if err != nil {
		if p.localErr != err.Error() {
			noteErr("local sessions: %v", err)
		}
		p.localErr = err.Error()
		p.local = staled(p.local)
	} else {
		p.localErr = ""
		p.local = list
	}
	p.mu.Unlock()
	p.publish()
}

// staled marks sessions as last known: their machine (or tmux) can't be read right now.
func staled(list []engine.Session) []engine.Session {
	out := make([]engine.Session, len(list))
	for i, s := range list {
		s.Stale = true
		out[i] = s
	}
	return out
}

// publish sends the UI everything known: this computer's sessions and the machines'. What
// changed is shared with the other windows.
func (p *poller) publish() SessionsView {
	p.mu.Lock()
	remote := p.remoteList()
	all := make([]engine.Session, 0, len(p.local)+len(remote))
	all = append(append(all, p.local...), remote...)
	errs := map[string]string{}
	for k, v := range p.remoteErr {
		errs[k] = v
	}
	if p.localErr != "" {
		errs[engine.LocalMachine] = p.localErr
	}
	v := SessionsView{Sessions: all, Errors: errs, At: time.Now()}
	changed := !reflect.DeepEqual(v.Sessions, p.last.Sessions) || !reflect.DeepEqual(v.Errors, p.last.Errors)
	p.last = v
	p.mu.Unlock()
	if !changed {
		return v
	}
	p.notify(all)
	wruntime.EventsEmit(p.a.ctx, "sessions", v)
	p.share(v)
	return v
}

// share leaves the sessions for the other windows (only when they changed).
func (p *poller) share(v SessionsView) {
	b, err := json.Marshal(SessionsView{Sessions: v.Sessions, Errors: v.Errors})
	if err != nil {
		return
	}
	_ = os.MkdirAll(paths.State(), 0o700)
	if _, err := paths.WriteFile(sharedSessionsFile(), b, 0o600); err == nil {
		if fi, err := os.Stat(sharedSessionsFile()); err == nil {
			p.mu.Lock()
			p.shared.mod, p.shared.size = fi.ModTime(), fi.Size()
			p.mu.Unlock()
		}
	}
}

// follow takes up what another window shared. If nothing has been shared for a while (the
// window that polls is stuck), this one looks for itself.
func (p *poller) follow(ctx context.Context) {
	fi, err := os.Stat(sharedSessionsFile())
	if err != nil || time.Since(fi.ModTime()) > 20*time.Second {
		go p.refreshLocal(ctx)
		if err != nil || time.Since(fi.ModTime()) > 45*time.Second {
			go p.refresh(ctx)
		}
		if err != nil {
			return
		}
	}
	p.mu.Lock()
	seen := fi.ModTime().Equal(p.shared.mod) && fi.Size() == p.shared.size
	p.mu.Unlock()
	if seen {
		return
	}
	b, err := os.ReadFile(sharedSessionsFile())
	if err != nil {
		return
	}
	var v SessionsView
	if json.Unmarshal(b, &v) != nil {
		return
	}
	if v.Sessions == nil {
		v.Sessions = []engine.Session{}
	}
	if v.Errors == nil {
		v.Errors = map[string]string{}
	}
	v.At = time.Now()
	p.mu.Lock()
	p.shared.mod, p.shared.size = fi.ModTime(), fi.Size()
	same := reflect.DeepEqual(v.Sessions, p.last.Sessions) && reflect.DeepEqual(v.Errors, p.last.Errors)
	// Kept by part, so this window carries on from here if it becomes the one that polls.
	p.local, p.remote = nil, map[string][]engine.Session{}
	for _, s := range v.Sessions {
		if engine.IsLocal(s.Machine) {
			p.local = append(p.local, s)
		} else {
			p.remote[s.Machine] = append(p.remote[s.Machine], s)
		}
	}
	p.localErr = v.Errors[engine.LocalMachine]
	p.remoteErr = map[string]string{}
	for k, e := range v.Errors {
		if !engine.IsLocal(k) {
			p.remoteErr[k] = e
		}
	}
	p.last = v
	p.mu.Unlock()
	if !same {
		p.notify(v.Sessions)
		wruntime.EventsEmit(p.a.ctx, "sessions", v)
	}
}

// claude runs a Claude account rotation pass: scheduled usage checks, and a switch to the
// next account when the active one is limited.
func (p *poller) claude(ctx context.Context) {
	c, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	res, err := p.a.eng.ClaudeTick(c, p.publishedSessions(), nil)
	if err != nil {
		return
	}
	if res.Followed != "" {
		p.a.announceFollow(res.Followed)
	}
	if acct := p.a.eng.LoginToAdd(); acct != nil { // the rotation pass saw the /login first
		p.a.addLoginAccount(acct)
	}
	if res.Switched {
		p.a.announceSwitch(res)
	}
	p.a.emitClaude()
}

// refresh polls every running machine's sessions, all at once, and publishes each machine's
// as soon as it answers: a slow machine doesn't hold the others back. A machine that doesn't
// answer keeps its sessions as last seen, marked stale, with the reason.
func (p *poller) refresh(ctx context.Context) SessionsView {
	started, ok := begin(&p.remoteSince, 60*time.Second, "machines")
	if !ok {
		return p.current()
	}
	defer end(&p.remoteSince, started)
	ms, _ := p.a.eng.Machines()
	running := map[string]bool{}
	for _, m := range ms {
		if m.Status != model.StatusStopped && m.Status != model.StatusMissing {
			running[m.Name] = true
		}
	}
	p.mu.Lock()
	for name := range p.remote {
		if !running[name] {
			delete(p.remote, name)
		}
	}
	for name := range p.remoteErr {
		if !running[name] {
			delete(p.remoteErr, name)
		}
	}
	p.mu.Unlock()
	if len(running) == 0 {
		return p.publish()
	}
	c, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for name := range running {
		wg.Add(1)
		go func() {
			defer wg.Done()
			list, err := p.a.eng.Sessions(c, name)
			p.mu.Lock()
			if err != nil {
				p.remoteErr[name] = err.Error()
				p.remote[name] = staled(p.remote[name])
			} else {
				delete(p.remoteErr, name)
				p.remote[name] = list
			}
			p.mu.Unlock()
			p.publish()
		}()
	}
	wg.Wait()
	p.mu.Lock()
	errs := map[string]string{}
	for k, v := range p.remoteErr {
		errs[k] = v
	}
	p.mu.Unlock()
	p.a.eng.TendTerminals(ctx, errs) // keep each machine ready for a pane to open instantly
	if p.primary() {
		go p.relogin(ctx, p.publishedSessions()) // this computer's sessions too
	}
	return p.current()
}

// kickOnLimit runs a rotation pass now, not at the next minute's, when a session was just
// stopped at a limit by the account it is on (at most every 15 seconds): the account is used
// up, and the session goes on with the next one in seconds (see ClaudeTick).
func (p *poller) kickOnLimit(ctx context.Context) {
	now := time.Now()
	for _, s := range p.publishedSessions() {
		if s.FreshLimit(now) && !s.OldLogin && !s.LoginAt.IsZero() {
			if now.UnixNano()-p.limitKick.Load() > int64(15*time.Second) {
				p.limitKick.Store(now.UnixNano())
				go p.claude(ctx)
			}
			return
		}
	}
}

// relogin moves sessions still on a login the machines have switched off (an account at its
// limit) onto the current one, with their conversations, as soon as each is idle. Sessions
// on this computer follow the machines' account too.
func (p *poller) relogin(ctx context.Context, list []engine.Session) {
	due := false
	for _, s := range list {
		if engine.ReloginCandidate(s) != "" {
			due = true
			break
		}
	}
	if !due {
		return
	}
	moved := p.a.eng.MoveToNewLogin(ctx, list)
	if len(moved) == 0 {
		return
	}
	wruntime.EventsEmit(p.a.ctx, "claude:moved", map[string]any{"count": len(moved), "names": engine.LoginSummary(moved), "account": p.a.activeAccountName()})
	go func() {
		time.Sleep(1500 * time.Millisecond)
		p.refresh(ctx)
	}()
}

func (p *poller) notify(list []engine.Session) {
	p.mu.Lock()
	defer p.mu.Unlock()
	// Every window shows the in-app notice; only the primary sends the native notification,
	// so three open windows don't ping three times.
	native := p.a.win.primary.Load()
	seen := map[string]bool{}
	for _, s := range list {
		k := s.Key()
		seen[k] = true
		prev, had := p.states[k]
		p.states[k] = s.State
		if !p.primed || !had || s.Agent == "" || prev == s.State { // any agent: Claude, Codex, Grok, Mantis
			continue
		}
		switch {
		case s.State == "waiting" && s.Limit != "":
			// Stopped at a usage limit: the rotation moves it to the next account and it goes
			// on (the switch is announced), so nothing needs you yet.
		case s.State == "waiting":
			body := s.Message
			if body == "" {
				body = engine.AgentName(s.Agent) + " is waiting for you"
			}
			if native {
				notify(sessionLabel(s)+" needs you", body)
			}
			wruntime.EventsEmit(p.a.ctx, "session:attention", s)
		case s.State == "idle" && prev == "working":
			if native {
				notify(sessionLabel(s)+" finished", engine.AgentName(s.Agent)+" is done and waiting for your next message")
			}
			wruntime.EventsEmit(p.a.ctx, "session:attention", s)
		}
	}
	for k := range p.states {
		if !seen[k] {
			delete(p.states, k)
		}
	}
	p.primed = true
}

// sessionLabel names a session in a notification: what Claude calls it, and where it runs.
func sessionLabel(s engine.Session) string {
	name := s.Title
	if name == "" {
		name = s.Name
	}
	if engine.IsLocal(s.Machine) {
		return name + " on this computer"
	}
	return name + " on " + s.Machine
}

// accountFilesStamp changes whenever the Claude accounts' state changes on disk: which one
// machines use (config.json) and what each was last seen to have left.
func accountFilesStamp() string {
	stamp := ""
	for _, f := range []string{paths.Config(), filepath.Join(paths.State(), "claude-accounts.json")} {
		if st, err := os.Stat(f); err == nil {
			stamp += fmt.Sprintf("%d:%d;", st.ModTime().UnixNano(), st.Size())
		}
	}
	return stamp
}
