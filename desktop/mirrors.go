package main

import (
	"context"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"skybuild/internal/engine"
)

// Following folders whose sessions moved from this computer to a machine (engine.Mirror): every
// few seconds the primary window asks each machine whether anything in the folder changed, and
// brings what did into this computer's copy. A folder no session has been open in on its
// machine for an hour stops being followed, after a last pull.

type mirrors struct {
	busy   atomic.Bool
	mu     sync.Mutex
	seen   map[string]time.Time // mirror → when a session was last open in it (or first looked at)
	failed map[string]string    // mirror → the last error written to the log
}

const mirrorQuiet = time.Hour

// followsMirrors: the primary window does it. So does a hidden dev instance with a sky folder of
// its own (it never becomes primary, but its mirrors are its own).
func (p *poller) followsMirrors() bool {
	return p.primary() || (os.Getenv("SKY_HEADLESS") != "" && os.Getenv("SKYBUILD_HOME") != "")
}

func (p *poller) followMirrors(ctx context.Context) {
	f := &p.mirrors
	if !f.busy.CompareAndSwap(false, true) {
		return
	}
	defer f.busy.Store(false)
	list := engine.Mirrors()
	if len(list) == 0 {
		return
	}
	sessions := p.publishedSessions()
	f.mu.Lock()
	if f.seen == nil {
		f.seen, f.failed = map[string]time.Time{}, map[string]string{}
	}
	f.mu.Unlock()
	for _, m := range list {
		key := m.Machine + "\x00" + m.Remote
		live := false
		for _, s := range sessions {
			if s.Machine == m.Machine && (s.Path == m.Remote || strings.HasPrefix(s.Path, m.Remote+"/")) {
				live = true
				break
			}
		}
		f.mu.Lock()
		if _, ok := f.seen[key]; live || !ok {
			f.seen[key] = time.Now()
		}
		idle := time.Since(f.seen[key])
		f.mu.Unlock()

		c, cancel := context.WithTimeout(ctx, 10*time.Minute)
		n, err := p.a.eng.FollowMirror(c, m)
		cancel()
		f.mu.Lock()
		if err != nil {
			if f.failed[key] != err.Error() {
				f.failed[key] = err.Error()
				noteErr("following %s on %s into %s: %v", m.Remote, m.Machine, m.Local, err)
			}
		} else {
			delete(f.failed, key)
		}
		f.mu.Unlock()
		if n > 0 {
			noteErr("followed %s on %s: %d files into %s", m.Remote, m.Machine, n, m.Local)
		}
		if err == nil && !live && idle > mirrorQuiet {
			if engine.EndMirror(m.Machine, m.Remote) == nil {
				noteErr("stopped following %s on %s: no session there for %s", m.Remote, m.Machine, idle.Round(time.Minute))
				f.mu.Lock()
				delete(f.seen, key)
				f.mu.Unlock()
			}
		}
	}
}
