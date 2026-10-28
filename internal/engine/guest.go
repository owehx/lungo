package engine

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"skybuild/internal/sshx"
)

// A session shared with other people (see internal/collab) is shown to each of them by a
// tmux client of its own, on the computer that shares it.

// guestScript attaches to a session that is there, and only then: a session that ended is
// not made again for a guest ("[gone]" says it ended). The guest's client leaves the
// session's size to the panes of the person sharing it (ignore-size; tmux before 3.2 doesn't
// know it and attaches plainly).
func guestScript(tmux, session string) string {
	return `s=` + sshx.Quote(session) + `; if ! ` + tmux + ` has-session -t "=$s" 2>/dev/null; then echo '[gone]'; exit 0; fi; ` +
		tmux + ` attach-session -f ignore-size -t "=$s" 2>/dev/null || ` + tmux + ` attach-session -t "=$s"`
}

// GuestAttachArgs is the command that shows a session to someone it is shared with.
func (e *Engine) GuestAttachArgs(machine, session string) ([]string, error) {
	if session == "" {
		return nil, errors.New("a session name is needed")
	}
	if IsLocal(machine) {
		pre, err := localPrelude()
		if err != nil {
			return nil, err
		}
		return []string{"/bin/sh", "-c", pre + guestScript("tmux", session)}, nil
	}
	args, err := e.AttachArgsIn(machine, "", AttachOptions{}) // ssh to the machine, with a terminal
	if err != nil {
		return nil, err
	}
	return append(args, "--", sshx.RemotePath+guestScript("tmux -u", session)), nil
}

// WindowSize is the size of a session's window, in cells: what its own panes make it.
func (e *Engine) WindowSize(ctx context.Context, machine, session string) (cols, rows int, err error) {
	const format = "#{window_width} #{window_height}"
	var out string
	if IsLocal(machine) {
		out, _, err = localTmuxRun(ctx, "display-message", "-p", "-t", "="+session+":", format)
	} else {
		out, err = e.runOn(ctx, machine, "tmux display-message -p -t "+sshx.Quote("="+session+":")+" '"+format+"'")
	}
	if err != nil {
		return 0, 0, err
	}
	if _, err := fmt.Sscanf(strings.TrimSpace(out), "%d %d", &cols, &rows); err != nil || cols <= 0 || rows <= 0 {
		return 0, 0, fmt.Errorf("no window size for %s", session)
	}
	return cols, rows, nil
}
