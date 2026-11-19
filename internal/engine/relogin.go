package engine

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"skybuild/internal/claudeacct"
	"skybuild/internal/config"
	"skybuild/internal/sshx"
)

// Moving running sessions to a new login.
//
// Claude Code reads its login when it starts (the claude wrapper sky installs reads the
// machine's token file each time). When the machines switch accounts, the token file
// changes at once but every Claude already running keeps the old login: an account at its
// limit, or one that has expired. So each of those is restarted with its conversation
// resumed, at a moment that costs nothing:
//   - idle at its prompt with no key pressed lately (a one-line draft in the input is typed
//     back after the restart);
//   - stuck on a usage-limit prompt (the old login's limit).
// One that is working is left until its turn ends; one asking a question is left for you.
// Only sessions whose conversation ID is known are moved: "the latest conversation in the
// folder" could be another session's when several share a folder. Sessions on this computer
// are moved the same way (see claudelocal.go).

// MoveSessionsOff reports whether moving sessions to a new login is turned off.
func MoveSessionsOff() bool {
	c, err := config.Load()
	return err == nil && c.Settings.ClaudeLeaveSessions
}

// ReloginCandidate says whether a session is due to be moved to the machine's new login, and
// in which way: "idle" (restart when nothing is typed) or "limit" (stuck on a limit prompt).
func ReloginCandidate(s Session) string {
	if !s.Claude || !s.OldLogin || !sessionID.MatchString(s.SID) {
		return ""
	}
	switch {
	case s.State == "waiting" && IsLimitMessage(s.Message):
		return "limit"
	case s.State == "idle":
		return "idle"
	}
	return ""
}

var relogin sync.Mutex

// MoveToNewLogin restarts, with their conversations, the Claude sessions still on a machine's
// old login (see ReloginCandidate). Each is tried once per login change, whichever process
// (the app or the background agent) gets there first. It returns the sessions moved.
func (e *Engine) MoveToNewLogin(ctx context.Context, sessions []Session) []Session {
	if !relogin.TryLock() {
		return nil
	}
	defer relogin.Unlock()
	if MoveSessionsOff() {
		return nil
	}
	var moved []Session
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, s := range sessions {
		how := ReloginCandidate(s)
		if how == "" {
			continue
		}
		// Once per session and login; a session that was busy is tried again a little later.
		key := fmt.Sprintf("relogin:%s:%d", s.Key(), s.LoginAt.Unix())
		if !claudeacct.Attempt(key, 45*time.Second) {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, cancel := context.WithTimeout(ctx, 75*time.Second)
			defer cancel()
			msg := ""
			if how == "limit" {
				msg = continueMoved // it stopped at the old login's limit: go on with the new one
			}
			if err := e.restartClaude(c, s.Machine, s.Name, s.SID, s.Flags, how, msg); err == nil {
				mu.Lock()
				moved = append(moved, s)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return moved
}

// errBusy: the session was not restarted because you are using it (or Claude is working).
var errBusy = errors.New("busy")

// restartClaude is RestartClaude with a check first. when is "" (restart now), "idle"
// (only if Claude is at its prompt with nothing typed and no key pressed for a minute and
// a half) or "limit" (Claude stopped at a usage limit: only if it isn't working). Once
// Claude is up again, msg (if any) is sent to it as the next prompt, unless a draft was
// typed back.
func (e *Engine) restartClaude(ctx context.Context, machine, session, sid, flags, when, msg string) error {
	// Text left in the input (a draft) is kept: it is typed back once Claude is up again. A
	// draft longer than one line counts as busy.
	const draft = `at=$(printf '%s\n' "$p" | grep -n '❯' | tail -1)
n=${at%%:*}
draft=$(printf '%s' "${at#*:}" | sed 's/^.*❯//' | sed "s/^$(printf '\302\240')//; s/^ //; s/[[:space:]]*$//")
case "$draft" in "Try \""*) draft="";; esac
if [ -n "$draft" ]; then case "$(printf '%s\n' "$p" | sed -n "$((n + 1))p")" in *─*) ;; *) echo busy; exit 3;; esac; fi
`
	check := ""
	switch when {
	case "idle":
		// Busy when Claude works or asks something, or when a key was pressed in the last 90
		// seconds.
		check = `last=$(tmux list-clients -t "=$s" -F '#{client_activity}' 2>/dev/null | sort -n | tail -1); now=$(date +%s)
[ -n "$last" ] && [ $((now - last)) -lt 90 ] && { echo busy; exit 3; }
p=$(tmux capture-pane -p -t "=$s:" 2>/dev/null)
case "$p" in *"esc to interrupt"*|*"❯ 1."*|*"Enter to confirm"*) echo busy; exit 3;; esac
` + draft
	case "limit":
		// Stopped at a limit: at its prompt, or waiting for the reset by itself ("continuing
		// automatically… esc to cancel"), or on an older Claude's limit menu (no draft there).
		check = `p=$(tmux capture-pane -p -t "=$s:" 2>/dev/null)
case "$p" in *"esc to interrupt"*) echo busy; exit 3;; esac
case "$p" in *"❯ 1."*|*"Enter to confirm"*) ;; *)
` + draft + `;; esac
`
	}
	f := ""
	if fl := ClaudeFlags(flags); fl != "" {
		f = " " + fl
	}
	given := ""
	if sessionID.MatchString(sid) && sid != "continue" {
		given = sid
	}
	// Which conversation to bring back is read from the Claude that is running, before it is
	// stopped: its own record (~/.claude/sessions/<pid>.json) names the conversation it is in.
	// The hooks' ID can be stale (a resumed Claude gets a new one), so it only counts when
	// there is no record. Then:
	//   - that conversation's transcript is on the machine: resume it;
	//   - the record is there but no transcript: this Claude never had a conversation, so a
	//     fresh one loses nothing;
	//   - neither: nothing is touched (exit 4).
	pick := `cp=$(pgrep -P "$(tmux display -p -t "=$s:" '#{pane_pid}')" 2>/dev/null | head -1)
rec=""; [ -n "$cp" ] && rec=$(sed -n 's/.*"sessionId" *: *"\([^"]*\)".*/\1/p' "$HOME/.claude/sessions/$cp.json" 2>/dev/null | head -1)
case "$rec" in *[!A-Za-z0-9_-]*) rec="";; esac
id=${rec:-` + sshx.Quote(given) + `}
if [ -n "$id" ] && ls "$HOME"/.claude/projects/*/"$id.jsonl" >/dev/null 2>&1; then line="claude --resume $id"` + sshx.Quote(f) + `
elif [ -n "$rec" ]; then line="claude"` + sshx.Quote(f) + `
else echo "can't tell which conversation this is"; exit 4; fi
`
	if IsLocal(machine) {
		// The shell may predate the claude wrapper (see claudelocal.go): load it first.
		pick += `line=` + sshx.Quote(localLoginPrefix()) + `"$line"
`
	}
	shell := `zsh|bash|fish|sh|dash|-zsh|-bash`
	script := `s=` + sshx.Quote(session) + `; draft=""; msg=` + sshx.Quote(msg) + `
tmux has-session -t "=$s" 2>/dev/null || { echo "no such session"; exit 1; }
` + check + pick + `tmux send-keys -t "=$s:" Escape; sleep 0.6
tmux send-keys -t "=$s:" C-c; sleep 0.4; tmux send-keys -t "=$s:" C-c
i=0; while [ $i -lt 16 ]; do sleep 0.5; case "$(tmux display -p -t "=$s:" '#{pane_current_command}')" in ` + shell + `) break;; esac; i=$((i+1)); done
case "$(tmux display -p -t "=$s:" '#{pane_current_command}')" in ` + shell + `) ;; *) echo "Claude is still running in it"; exit 1;; esac
tmux send-keys -t "=$s:" "$line" Enter
` + awaitPrompt + `
if [ -n "$draft" ]; then sleep 1; tmux send-keys -t "=$s:" -l "$draft"
elif [ -n "$msg" ] && [ -n "$up" ]; then sleep 1; tmux send-keys -t "=$s:" -l "$msg"; sleep 0.5; tmux send-keys -t "=$s:" Enter; fi
true`
	out, err := e.runOn(ctx, machine, script)
	if err != nil {
		msg := strings.TrimSpace(out)
		if msg == "busy" {
			return errBusy
		}
		if msg != "" {
			return errors.New(msg)
		}
		return err
	}
	return nil
}

// awaitPrompt waits (up to half a minute: a long conversation takes a while to load) for
// Claude, just started in session $s, to be ready for a prompt; up is set once it is. Claude's
// folder-trust question is answered yes on the way: the session was running in this folder.
const awaitPrompt = `up=""; trusted=""; i=0; while [ $i -lt 60 ]; do sleep 0.5; p=$(tmux capture-pane -p -t "=$s:" 2>/dev/null); case "$p" in *"trust this folder"*) if [ -z "$trusted" ]; then trusted=1; if printf %s "$p" | grep -q "❯.*Yes"; then tmux send-keys -t "=$s:" Enter; else tmux send-keys -t "=$s:" Down Enter; fi; fi;; *"? for shortcuts"*|*"shift+tab to cycle"*|*"esc to interrupt"*) up=1; break;; esac; i=$((i+1)); done`

// LoginSummary names sessions in a sentence: "api, web and 2 more".
func LoginSummary(list []Session) string {
	names := make([]string, 0, len(list))
	for _, s := range list {
		n := s.Title
		if n == "" {
			n = s.Name
		}
		names = append(names, n)
	}
	switch {
	case len(names) == 0:
		return ""
	case len(names) == 1:
		return names[0]
	case len(names) <= 3:
		return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
	}
	return strings.Join(names[:2], ", ") + " and " + strconv.Itoa(len(names)-2) + " more"
}
