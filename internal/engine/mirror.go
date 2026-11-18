package engine

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gofrs/flock"

	"skybuild/internal/paths"
	"skybuild/internal/sshx"
)

// Mirrors: after a session moves from this computer to a machine, this computer's copy of its
// folder follows what happens there (MirrorPull), so the files the session writes in the cloud
// show up here, in the same folder as before. The desktop app keeps them going while the
// session lives there; moving it back home ends the mirror.

// Mirror is one folder on a machine followed into a folder here.
type Mirror struct {
	Machine string    `json:"machine"`
	Remote  string    `json:"remote"` // absolute, on the machine
	Local   string    `json:"local"`  // absolute, here
	Since   time.Time `json:"since"`
}

func mirrorsPath() string { return filepath.Join(paths.State(), "mirrors.json") }

// Mirrors lists the folders followed from machines.
func Mirrors() []Mirror {
	b, err := os.ReadFile(mirrorsPath())
	if err != nil {
		return nil
	}
	var f struct {
		Mirrors []Mirror `json:"mirrors"`
	}
	if json.Unmarshal(b, &f) != nil {
		return nil
	}
	return f.Mirrors
}

// UpdateMirrors changes the list under a lock (every window may move a session).
func UpdateMirrors(fn func([]Mirror) []Mirror) error {
	if err := os.MkdirAll(paths.State(), 0o700); err != nil {
		return err
	}
	l := flock.New(mirrorsPath() + ".lock")
	if err := l.Lock(); err != nil {
		return err
	}
	defer l.Unlock()
	next := fn(Mirrors())
	if next == nil {
		next = []Mirror{}
	}
	b, err := json.MarshalIndent(struct {
		Mirrors []Mirror `json:"mirrors"`
	}{next}, "", "  ")
	if err != nil {
		return err
	}
	tmp := mirrorsPath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, mirrorsPath())
}

// NoteMove keeps the mirrors in line with a session's move: one that leaves this computer for a
// machine starts following there; one that moves on to another machine takes its mirror along;
// one that comes back here ends it.
func NoteMove(res MoveResult) error {
	if res.From == res.To || res.FromDir == "" || res.ToDir == "" {
		return nil
	}
	return UpdateMirrors(func(list []Mirror) []Mirror {
		local := ""
		out := list[:0]
		for _, m := range list {
			if m.Machine == res.From && m.Remote == res.FromDir {
				local = m.Local // it was being followed from where it was
				continue
			}
			out = append(out, m)
		}
		switch {
		case IsLocal(res.From) && !IsLocal(res.To):
			local = res.FromDir
		case IsLocal(res.To):
			local = ""
		}
		if local != "" {
			out = append(out, Mirror{Machine: res.To, Remote: res.ToDir, Local: local, Since: time.Now()})
		}
		return out
	})
}

// EndMirror stops following a folder.
func EndMirror(machine, remote string) error {
	return UpdateMirrors(func(list []Mirror) []Mirror {
		out := list[:0]
		for _, m := range list {
			if m.Machine != machine || m.Remote != remote {
				out = append(out, m)
			}
		}
		return out
	})
}

// mirrorStamp is the file on the machine whose time is the last pull from it.
func mirrorStamp(remote string) string {
	return `"$HOME"/.cache/sky-move/` + sshx.Quote("mirror"+claudeProjectName(remote)+".stamp")
}

// MirrorChanged says, cheaply (one find on the machine, over the shared connection), whether
// anything in a followed folder changed since the last MirrorPull.
func (e *Engine) MirrorChanged(ctx context.Context, m Mirror) (bool, error) {
	var prune []string
	for _, s := range append([]string{".git"}, MoveSkip...) {
		prune = append(prune, "-name "+sshx.Quote(s))
	}
	script := `st=` + mirrorStamp(m.Remote) + `; [ -f "$st" ] || { echo changed; exit 0; }
find ` + sshx.Quote(m.Remote) + ` \( ` + strings.Join(prune, " -o ") + ` \) -prune -o -type f -newer "$st" -print 2>/dev/null | head -1`
	out, err := e.shOn(ctx, m.Machine, script)
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(out) != "", nil
}

// FollowMirror brings a followed folder's changes here when there are any, and says how many
// files came.
func (e *Engine) FollowMirror(ctx context.Context, m Mirror) (int, error) {
	changed, err := e.MirrorChanged(ctx, m)
	if err != nil || !changed {
		return 0, err
	}
	// The new stamp is made before the pull, so what changes during it is seen next time.
	st := mirrorStamp(m.Remote)
	if _, err := e.shOn(ctx, m.Machine, `mkdir -p "$HOME/.cache/sky-move" && touch `+st+`.next`); err != nil {
		return 0, err
	}
	n, err := e.MirrorPull(ctx, m.Machine, m.Remote, m.Local)
	if err != nil {
		return n, err
	}
	_, err = e.shOn(ctx, m.Machine, `mv -f `+st+`.next `+st)
	return n, err
}

// ErrNotMirrored: no folder here follows that one.
var ErrNotMirrored = errors.New("not followed here")

// MirrorOf is the mirror that follows a folder on a machine (or a folder inside it).
func MirrorOf(machine, dir string) (Mirror, error) {
	for _, m := range Mirrors() {
		if m.Machine == machine && (dir == m.Remote || strings.HasPrefix(dir, m.Remote+"/")) {
			return m, nil
		}
	}
	return Mirror{}, ErrNotMirrored
}
