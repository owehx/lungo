package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"skybuild/internal/model"
	"skybuild/internal/osx"
	"skybuild/internal/paths"
	"skybuild/internal/sshx"
)

// Session is a tmux session on a machine. Claude sessions report what Claude is doing
// through hooks sky installs (see syncer.SessionHook).
type Session struct {
	Machine  string    `json:"machine"`
	Name     string    `json:"name"`
	Created  time.Time `json:"created"`
	Activity time.Time `json:"activity"` // last output in the session (not keystrokes, not a client attaching)
	Attached int       `json:"attached"` // clients looking at it right now
	Windows  int       `json:"windows"`
	Path     string    `json:"path"`    // working directory of the active pane
	Command  string    `json:"command"` // process in the active pane
	Claude   bool      `json:"claude"`
	State    string    `json:"state,omitempty"` // working | waiting | idle
	StateAt  time.Time `json:"stateAt,omitempty"`
	Message  string    `json:"message,omitempty"` // e.g. "Claude needs your permission to use Bash"
	Title    string    `json:"title,omitempty"`   // what the program calls the session (Claude's task name)
	SID      string    `json:"sid,omitempty"`     // Claude's conversation ID, to resume it if the session is lost
	Flags    string    `json:"flags,omitempty"`   // how Claude was started (permission flags), to start it the same way again
	Branch   string    `json:"branch,omitempty"`  // the git branch of its folder, when it is in a repository
	// Claude reads its login when it starts. ClaudeSince is when the Claude in this session
	// started; LoginAt when the machine's login last changed (an account switch). A Claude
	// that started before that still runs on the old login: OldLogin.
	ClaudeSince time.Time `json:"claudeSince,omitzero"`
	LoginAt     time.Time `json:"loginAt,omitzero"`
	OldLogin    bool      `json:"oldLogin,omitempty"`
	// Mouse: the program in the session asked for the mouse (Claude's fullscreen view, vim,
	// htop), so clicks and drags are its; otherwise the app selects text itself. Alt: it uses
	// the whole screen rather than a command line. ScrollKey: the machine's tmux has sky's key
	// for leaving scrollback (see bootstrap.TmuxManaged), so typing after scrolling back goes
	// to the program instead of tmux's copy mode.
	Mouse     bool `json:"mouse,omitempty"`
	Alt       bool `json:"alt,omitempty"`
	ScrollKey bool `json:"scrollKey,omitempty"`
	// Agent is the coding agent running in the session ("claude", "codex", "grok", "mantis";
	// see Agents), "" for none. Claude is also Claude == true.
	Agent string `json:"agent,omitempty"`
	// Stale: as last seen; its machine (or this computer's tmux) can't be read right now.
	Stale bool `json:"stale,omitempty"`
	// Limit: Claude stopped at a usage limit, with these words, at LimitAt (read from its
	// conversation; see limits.go). The session is "waiting" with this as its message.
	Limit   string    `json:"limit,omitempty"`
	LimitAt time.Time `json:"limitAt,omitzero"`
}

// Key identifies a session across machines.
func (s Session) Key() string { return s.Machine + "/" + s.Name }

// listSessionsCmd prints the sessions, then each Claude state file, then for each pane an
// agent runs in: the agent's process and Claude's own record of it, and the pane's screen
// (hooks don't fire for every prompt Claude can stop at; the screen tells us). It costs the
// machine about six processes however many panes there are: one awk pass matches panes to
// processes and reads the records, one tmux call captures every screen (it used to be a dozen
// processes per pane, every five seconds). It runs in the machine's login shell, zsh as
// often as sh or bash: the names are split by a command substitution, which all three split
// alike (zsh doesn't split a plain $N).
const listSessionsCmd = `echo "@@sky-login@@ $(date +%s) $(stat -c %Y ~/.claude/.oauth-token 2>/dev/null || stat -f %m ~/.claude/.oauth-token 2>/dev/null)"; tmux list-sessions -F '#{session_name}	#{session_created}	#{window_activity}	#{session_attached}	#{session_windows}	#{pane_current_path}	#{pane_current_command}	#{host_short}	#{pane_title}	#{?mouse_any_flag,m,}#{?alternate_on,a,}#{?@sky-keys,k,}' 2>/dev/null; ` + branchesCmd + ` echo '@@sky-status@@'; find ~/.skybuild/status -name '*.json' -exec cat {} + 2>/dev/null; P=$(ps -A -o pid=,ppid=,etime=,args= 2>/dev/null); L=$(tmux list-panes -a -F '#{session_name}	#{pane_current_command}	#{pane_pid}' 2>/dev/null); H=$(printf '%s\n@@ps@@\n%s\n' "$L" "$P" | awk -v home="$HOME" '` + agentPanesAwk + `'); N=${H##*@@sky-cap@@}; printf '%s' "${H%@@sky-cap@@*}"; set --; for s in $(echo "$N"); do [ $# -gt 0 ] && set -- "$@" ';'; set -- "$@" display-message -p -t "=$s:" '@@sky-screen@@#{session_name}' ';' capture-pane -p -t "=$s:"; done; echo '@@sky-screens@@'; [ $# -gt 0 ] && tmux "$@" 2>/dev/null; echo '@@sky-limits@@'; ` + limitScript + `; true`

// agentPanesAwk reads the panes (session, command in front, shell pid), then "@@ps@@" and
// the process table, and prints a "@@sky-pane@@session<TAB>process<TAB>conversation status"
// line for each pane an agent runs in, then "@@sky-cap@@" and the names of those sessions.
// A pane whose command looks like Claude (by name, node, or a version-named binary) is
// listed even when its process isn't found; another agent's only when it is.
const agentPanesAwk = `BEGIN { sec = 1 }
$0 == "@@ps@@" { sec = 2; next }
sec == 1 {
  if (split($0, a, "\t") < 3) next
  c = a[2]
  if (c ~ /claude/ || c == "node" || c ~ /^[0-9][^.]*[.][^.]*[.]/) k = "c"
  else if (c ~ /^(codex|grok|mantis|python|Python)/) k = "o"
  else next
  n++; name[n] = a[1]; kind[n] = k; at[a[3]] = n
  next
}
sec == 2 {
  if (split($0, f, " ") < 4 || !(f[2] in at)) next
  i = at[f[2]]
  if (i in found) next
  if ((kind[i] == "c" && $0 ~ /claude|codex|grok|mantis/) || (kind[i] == "o" && $0 ~ /codex|grok|mantis/)) found[i] = $0
}
END {
  caps = ""
  for (i = 1; i <= n; i++) {
    if (kind[i] == "o" && !(i in found)) continue
    sid = ""; st = ""
    if (kind[i] == "c" && (i in found)) {
      split(found[i], f, " ")
      rec = home "/.claude/sessions/" f[1] ".json"
      while ((getline l < rec) > 0) {
        if (sid == "" && match(l, /"sessionId"[ ]*:[ ]*"[^"]*"/)) { sid = substr(l, RSTART, RLENGTH); sub(/^"sessionId"[ ]*:[ ]*"/, "", sid); sub(/"$/, "", sid) }
        if (st == "" && match(l, /"status"[ ]*:[ ]*"[a-z]*"/)) { st = substr(l, RSTART, RLENGTH); sub(/^"status"[ ]*:[ ]*"/, "", st); sub(/"$/, "", st) }
      }
      close(rec)
    }
    if (kind[i] == "c") printf "@@sky-pane@@%s\t%s\t%s %s\n", name[i], found[i], sid, st
    else printf "@@sky-pane@@%s\t%s\t\n", name[i], found[i]
    caps = caps " " name[i]
  }
  printf "@@sky-cap@@%s", caps
}`

// branchesCmd prints the branch of each folder a session is in (one look per folder; reading
// HEAD is all it takes). Folders outside a repository print nothing.
const branchesCmd = `echo '@@sky-git@@'; tmux list-sessions -F '#{pane_current_path}' 2>/dev/null | sort -u | while IFS= read -r p; do b=$(git -C "$p" symbolic-ref --short -q HEAD 2>/dev/null) && printf '%s\t%s\n' "$p" "$b"; done;`

// Sessions lists tmux sessions on one machine.
func (e *Engine) Sessions(ctx context.Context, name string) ([]Session, error) {
	m, err := e.Machine(name)
	if err != nil {
		return nil, err
	}
	return e.sessionsOn(ctx, m)
}

func (e *Engine) sessionsOn(ctx context.Context, m *model.Machine) ([]Session, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, err := sshx.Run(ctx, e.Target(m), listSessionsCmd)
	if err != nil {
		return nil, err
	}
	return parseSessions(m.Name, out), nil
}

func parseSessions(machine, out string) []Session {
	// Last, what each Claude's conversation says about a usage limit (after the screens, which
	// may show anything: the last marker is the real one).
	var limits map[string]limitFacts
	if i := strings.LastIndex(out, "@@sky-limits@@"); i >= 0 {
		limits = parseLimits(out[i+len("@@sky-limits@@"):])
		out = out[:i]
	}
	// "@@sky-login@@ <now> <when the login file changed>", from machines (not this computer).
	var now, loginAt int64
	if rest, ok := strings.CutPrefix(out, "@@sky-login@@"); ok {
		line, more, _ := strings.Cut(rest, "\n")
		f := strings.Fields(line)
		if len(f) >= 1 {
			now, _ = strconv.ParseInt(f[0], 10, 64)
		}
		if len(f) >= 2 {
			loginAt, _ = strconv.ParseInt(f[1], 10, 64)
		}
		out = more
	}
	list, status, _ := strings.Cut(out, "@@sky-status@@")
	list, gitRaw, _ := strings.Cut(list, "@@sky-git@@")
	branches := map[string]string{}
	for _, line := range strings.Split(gitRaw, "\n") {
		if p, b, ok := strings.Cut(strings.TrimRight(line, "\r"), "\t"); ok && b != "" {
			branches[p] = b
		}
	}
	status, panesRaw, _ := strings.Cut(status, "@@sky-pane@@")
	// The screens come after the panes, one "@@sky-screen@@session" chunk each (as captured:
	// the blank lines are dropped here, and the last 30 kept).
	panesRaw, screensRaw, hasScreens := strings.Cut(panesRaw, "@@sky-screens@@")
	screens := map[string]string{}
	if hasScreens {
		for _, chunk := range strings.Split(screensRaw, "@@sky-screen@@")[1:] {
			name, body, _ := strings.Cut(chunk, "\n")
			screens[strings.TrimSpace(name)] = screenTail(body, 30)
		}
	}
	panes := map[string]string{}
	flags := map[string]string{}
	running := map[string]int64{}    // session → seconds its Claude has been running
	agents := map[string]string{}    // session → the agent its pane's process is
	record := map[string][2]string{} // session → Claude's own record of it: conversation, status
	if panesRaw != "" {
		for _, chunk := range strings.Split("@@sky-pane@@"+panesRaw, "@@sky-pane@@") {
			if head, body, ok := strings.Cut(chunk, "\n"); ok {
				// The session; its claude process (pid, parent, age, command line); and what
				// Claude's own record of that process says (~/.claude/sessions/<pid>.json).
				name, rest, _ := strings.Cut(head, "\t")
				args, rec, _ := strings.Cut(rest, "\t")
				name = strings.TrimSpace(name)
				panes[name] = body
				if hasScreens {
					panes[name] = screens[name]
				}
				if f := strings.Fields(args); len(f) >= 4 {
					agents[name] = agentOfArgs(strings.Join(f[3:], " ")) // after pid, parent, age
				}
				flags[name] = ClaudeFlags(args)
				if f := strings.Fields(args); len(f) >= 3 {
					if secs, ok := parseEtime(f[2]); ok {
						running[name] = secs
					}
				}
				if f := strings.Fields(rec); len(f) >= 1 {
					r := [2]string{f[0]}
					if len(f) >= 2 {
						r[1] = f[1]
					}
					if !sessionID.MatchString(r[0]) {
						r[0] = ""
					}
					record[name] = r
				}
			}
		}
	}
	states := map[string]struct {
		Session string `json:"session"`
		State   string `json:"state"`
		At      int64  `json:"at"`
		Message string `json:"message"`
		SID     string `json:"sid"`
	}{}
	dec := json.NewDecoder(strings.NewReader(status))
	for dec.More() {
		var s struct {
			Session string `json:"session"`
			State   string `json:"state"`
			At      int64  `json:"at"`
			Message string `json:"message"`
			SID     string `json:"sid"`
		}
		if dec.Decode(&s) != nil {
			break
		}
		states[s.Session] = s
	}
	var res []Session
	for _, line := range strings.Split(strings.TrimSpace(list), "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 7 {
			continue
		}
		s := Session{Machine: machine, Name: f[0], Path: f[5], Command: f[6], Branch: branches[f[5]]}
		if len(f) >= 10 {
			// The last field says how the session takes the mouse and keys (see Mouse, Alt, ScrollKey).
			last := f[len(f)-1]
			s.Mouse, s.Alt, s.ScrollKey = strings.Contains(last, "m"), strings.Contains(last, "a"), strings.Contains(last, "k")
			f = append(f[:8:8], strings.Join(f[8:len(f)-1], "\t"))
		}
		if len(f) >= 9 {
			s.Title = cleanTitle(f[8], f[7])
		}
		if n, err := strconv.ParseInt(f[1], 10, 64); err == nil {
			s.Created = time.Unix(n, 0)
		}
		if n, err := strconv.ParseInt(f[2], 10, 64); err == nil {
			s.Activity = time.Unix(n, 0)
		}
		s.Attached, _ = strconv.Atoi(f[3])
		s.Windows, _ = strconv.Atoi(f[4])
		// Another agent (Codex, Grok, Mantis): by the program in the pane, or by its command
		// line where that program is Python or Node (Codex installed with npm is "node", which
		// otherwise means Claude). The Claude rules below are not for its pane.
		other := agents[s.Name]
		if a := agentOfCommand(s.Command); a != "" && a != "claude" {
			other = a
		}
		if other == "claude" {
			other = ""
		}
		if st, ok := states[s.Name]; ok && other == "" {
			s.Claude = true
			s.State, s.Message = st.State, st.Message
			s.StateAt = time.Unix(st.At, 0)
			if sessionID.MatchString(st.SID) {
				s.SID = st.SID
			}
		}
		if isClaudeCommand(s.Command) && other == "" {
			// On macOS the process is named after Claude Code's version ("2.1.92"); one name for the UI.
			if s.Command != "node" {
				s.Command = "claude"
			}
			s.Claude = true
		}
		// Claude's own record of the running session (~/.claude/sessions/<pid>.json) is the
		// surest word on what it is doing: the hooks say "working" when a turn starts but
		// nothing when one is interrupted or fails, so a session could look busy for hours.
		// It also names the conversation the running Claude is in, which the hooks can get wrong
		// (a resumed Claude gets a new ID they may never report).
		if r, ok := record[s.Name]; ok && s.Claude {
			if r[0] != "" { // the live process's own word beats the hooks', which can be stale
				s.SID = r[0]
			}
			switch r[1] {
			case "busy":
				s.State = "working"
			case "idle":
				s.State, s.Message = "idle", ""
			}
		}
		// "Claude is waiting for your input" is Claude saying it has been idle a while, not a question.
		if s.State == "waiting" && strings.Contains(strings.ToLower(s.Message), "waiting for your input") {
			s.State, s.Message = "idle", ""
		}
		if screen, ok := panes[s.Name]; ok && s.Claude {
			if state, msg := screenState(screen); state != "" {
				s.State = state
				if msg != "" {
					s.Message = msg
				}
			}
			s.Flags = flags[s.Name]
			if secs, ok := running[s.Name]; ok && now > 0 {
				s.ClaudeSince = time.Unix(now-secs, 0)
				if loginAt > 0 {
					s.LoginAt = time.Unix(loginAt, 0)
					// A couple of seconds of slack: ps counts whole seconds.
					s.OldLogin = now-secs < loginAt-2
				}
			}
		}
		if other != "" {
			s.Agent, s.Command = other, other
			s.Title = agentTitle(other, s.Title, s.Path)
			s.State, s.Message = "idle", ""
			if state, msg := agentScreenState(other, panes[s.Name]); state != "" {
				s.State, s.Message = state, msg
			}
		}
		if s.Claude && !isClaudeCommand(s.Command) {
			s.State = "" // claude has exited; a shell is in the pane now
			s.Claude = strings.HasPrefix(s.Name, "claude")
		}
		if s.Claude {
			s.Agent = "claude"
			if lf, ok := limits[s.Name]; ok {
				applyLimit(&s, lf, record[s.Name][1] == "busy" || record[s.Name][1] == "shell")
			}
		}
		res = append(res, s)
	}
	sort.Slice(res, func(i, j int) bool { return res[i].Created.After(res[j].Created) })
	return res
}

// parseEtime reads ps's elapsed time, "[[dd-]hh:]mm:ss", as seconds.
func parseEtime(s string) (int64, bool) {
	var days int64
	if d, rest, ok := strings.Cut(s, "-"); ok {
		n, err := strconv.ParseInt(d, 10, 64)
		if err != nil {
			return 0, false
		}
		days, s = n, rest
	}
	parts := strings.Split(s, ":")
	if len(parts) < 2 || len(parts) > 3 {
		return 0, false
	}
	var secs int64
	for _, p := range parts {
		n, err := strconv.ParseInt(p, 10, 64)
		if err != nil {
			return 0, false
		}
		secs = secs*60 + n
	}
	return days*86400 + secs, true
}

// screenState reads the bottom of a Claude pane: a choice prompt means Claude is waiting on
// you, "esc to interrupt" means it is working. Empty means the screen doesn't say.
func screenState(screen string) (string, string) {
	lines := strings.Split(screen, "\n")
	tail := lines[max(0, len(lines)-14):] // prompts sit at the bottom; older output above may mention anything
	lower := strings.ToLower(strings.Join(tail, "\n"))
	switch {
	case strings.Contains(lower, "enter to confirm") || strings.Contains(lower, "do you want to proceed") ||
		strings.Contains(lower, "❯ 1.") || strings.Contains(lower, "esc to cancel"):
		// A usage-limit prompt: say so, with the limit line when it is still on screen.
		if strings.Contains(lower, "limit to reset") || strings.Contains(lower, "usage credits") {
			for i := len(lines) - 1; i >= 0; i-- {
				if t := strings.TrimSpace(lines[i]); limitScreen.MatchString(t) && !strings.Contains(t, "Stop and wait") {
					return "waiting", strings.TrimSpace(strings.Trim(t, "⎿│ "))
				}
			}
			return "waiting", "Claude hit a usage limit"
		}
		for _, line := range tail {
			if t := strings.TrimSpace(line); strings.HasSuffix(t, "?") {
				return "waiting", strings.TrimSpace(strings.Trim(t, "⎿│ "))
			}
		}
		return "waiting", "Claude is waiting for your choice"
	case strings.Contains(lower, "esc to interrupt"):
		return "working", ""
	}
	return "", ""
}

// isClaudeCommand recognises Claude Code as the program in a pane: by name, as node (older
// installs), or by the version number its native binary is named after on macOS.
func isClaudeCommand(cmd string) bool {
	return strings.Contains(cmd, "claude") || cmd == "node" || versionName.MatchString(cmd)
}

var versionName = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

var (
	titleLead = regexp.MustCompile(`^[^\p{L}\p{N}~/.]+`) // Claude's status glyph and spinner frames
	hostTitle = regexp.MustCompile(`^[\w.-]+@[\w.-]+(:.*)?$`)
)

// cleanTitle turns a terminal title into a session name worth showing: Claude's task name
// without its status glyph. Titles that are just the host, a shell or "Claude Code" say
// nothing and come back empty.
func cleanTitle(raw, host string) string {
	t := strings.TrimSpace(titleLead.ReplaceAllString(strings.TrimSpace(raw), ""))
	low := strings.ToLower(t)
	switch {
	case t == "", strings.EqualFold(t, host), hostTitle.MatchString(t):
		return ""
	case low == "claude", low == "claude code", low == "tmux", low == "zsh", low == "bash", low == "fish", low == "sh":
		return ""
	}
	// Other agents title the window with their own name, perhaps and the folder ("mantis · api").
	for _, a := range Agents {
		if low == a.ID || strings.HasPrefix(low, a.ID+" · ") || strings.HasPrefix(low, a.ID+" - ") {
			return ""
		}
	}
	if strings.HasPrefix(low, strings.ToLower(host)+".") && !strings.Contains(t, " ") {
		return "" // a fully qualified hostname
	}
	return t
}

// AllSessions lists sessions on every running machine in parallel. Machines that can't be
// reached are skipped and reported in errs.
func (e *Engine) AllSessions(ctx context.Context) ([]Session, map[string]string) {
	all, _ := e.Machines()
	var mu sync.Mutex
	var out []Session
	errs := map[string]string{}
	var wg sync.WaitGroup
	for _, m := range all {
		if m.Status == model.StatusStopped || m.Status == model.StatusMissing {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			s, err := e.sessionsOn(ctx, m)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs[m.Name] = err.Error()
				return
			}
			out = append(out, s...)
		}()
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	return out, errs
}

// SessionOptions start a new session.
type SessionOptions struct {
	Name   string `json:"name"`   // tmux session name; generated from Dir when empty
	Dir    string `json:"dir"`    // working directory on the machine (~/… allowed)
	Claude bool   `json:"claude"` // start Claude Code in it
	Args   string `json:"args"`   // extra claude flags, e.g. --dangerously-skip-permissions
	Prompt string `json:"prompt"` // first message for Claude
	Agent  string `json:"agent"`  // another agent instead of Claude: "codex", "grok", "mantis" (see Agents)
}

var unsafeSession = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)

// SessionName makes a tmux-safe name.
func SessionName(s string) string {
	s = strings.Trim(unsafeSession.ReplaceAllString(s, "-"), "-")
	if len(s) > 40 {
		s = s[:40]
	}
	return s
}

// NewSession starts a detached tmux session, optionally running Claude Code in it.
func (e *Engine) NewSession(ctx context.Context, machine string, o SessionOptions) (Session, error) {
	m, err := e.Machine(machine)
	if err != nil {
		return Session{}, err
	}
	if err := e.Ready(m); err != nil {
		return Session{}, err
	}
	dir := strings.TrimSpace(o.Dir)
	if dir == "" {
		dir = "~"
	}
	name := SessionName(o.Name)
	if name == "" {
		base := dir[strings.LastIndex(dir, "/")+1:]
		if base == "~" || base == "" {
			base = "home"
		}
		if o.Agent != "" && o.Agent != "claude" {
			base = o.Agent + "-" + base
		} else if o.Claude {
			base = "claude-" + base
		}
		name = SessionName(base)
	}
	// Unique among existing sessions.
	existing, _ := e.sessionsOn(ctx, m)
	taken := map[string]bool{}
	for _, s := range existing {
		taken[s.Name] = true
	}
	for i, n := 2, name; taken[name]; i++ {
		name = fmt.Sprintf("%s-%d", n, i)
	}
	cd := dir
	if strings.HasPrefix(cd, "~/") {
		cd = `"$HOME"/` + sshx.Quote(cd[2:])
	} else if cd == "~" {
		cd = `"$HOME"`
	} else {
		cd = sshx.Quote(cd)
	}
	cmd := "mkdir -p " + cd + " && cd " + cd + " && tmux new-session -d -s " + sshx.Quote(name) + " -c \"$PWD\""
	if o.Claude {
		// You picked this folder, so skip Claude's "do you trust this folder" prompt for it.
		if err := e.trustDir(ctx, m, cd); err != nil {
			return Session{}, err
		}
		line := "claude"
		if a := strings.TrimSpace(o.Args); a != "" {
			line += " " + a
		}
		if p := strings.TrimSpace(o.Prompt); p != "" {
			line += " " + sshx.Quote(p)
		}
		cmd += " && tmux send-keys -t " + sshx.Quote(name) + " " + sshx.Quote(line) + " Enter"
	} else if line := agentLine(o.Agent, "", strings.TrimSpace(o.Prompt)); line != "" {
		cmd += " && tmux send-keys -t " + sshx.Quote(name) + " " + sshx.Quote(line) + " Enter"
	}
	if _, err := sshx.Run(ctx, e.Target(m), cmd); err != nil {
		return Session{}, err
	}
	agent := o.Agent
	if agent == "" && o.Claude {
		agent = "claude"
	}
	return Session{Machine: machine, Name: name, Path: dir, Claude: o.Claude, Agent: agent, Created: time.Now(), Activity: time.Now(), Windows: 1}, nil
}

// trustDir marks a folder as trusted in the machine's ~/.claude.json (what answering
// "Yes, I trust this folder" does).
func (e *Engine) trustDir(ctx context.Context, m *model.Machine, cd string) error {
	t := e.Target(m)
	out, err := sshx.Run(ctx, t, "mkdir -p "+cd+" && cd "+cd+" && pwd && echo @@ && cat ~/.claude.json 2>/dev/null")
	if err != nil {
		return err
	}
	abs, raw, _ := strings.Cut(out, "\n@@\n")
	abs = strings.TrimSpace(abs)
	cfg := map[string]any{}
	if strings.TrimSpace(raw) != "" {
		if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
			return nil // don't touch a file we can't parse
		}
	}
	projects, _ := cfg["projects"].(map[string]any)
	if projects == nil {
		projects = map[string]any{}
	}
	p, _ := projects[abs].(map[string]any)
	if p == nil {
		p = map[string]any{}
	}
	if p["hasTrustDialogAccepted"] == true {
		return nil
	}
	p["hasTrustDialogAccepted"] = true
	projects[abs] = p
	cfg["projects"] = projects
	b, _ := json.MarshalIndent(cfg, "", "  ")
	_, err = sshx.RunInput(ctx, t, "umask 077 && cat > ~/.claude.json.sky-tmp && mv ~/.claude.json.sky-tmp ~/.claude.json", strings.NewReader(string(b)+"\n"))
	return err
}

// KillSession ends a tmux session (and whatever runs in it).
func (e *Engine) KillSession(ctx context.Context, machine, session string) error {
	_, err := e.runOn(ctx, machine, "tmux kill-session -t "+sshx.Quote("="+session)+"; rm -f ~/.skybuild/status/"+sshx.Quote(session+".json"))
	return err
}

// AttachOptions say how to open a session in a terminal when it doesn't exist yet.
type AttachOptions struct {
	Dir    string `json:"dir"`    // create the session in this folder ("" = home; ~/… allowed)
	Claude bool   `json:"claude"` // and start Claude Code in it
	// Resume brings a lost Claude session back instead of starting a new conversation: a
	// conversation ID, or "continue" for the latest one in the folder. It implies Claude.
	Resume string `json:"resume"`
	// Flags start Claude the way it was started before (see ClaudeFlags; anything else is dropped).
	Flags string `json:"flags"`
	// Prompt is Claude's first message in a session that is being made; when resuming a
	// conversation by its ID, the next message in it ("continue" takes none).
	Prompt string `json:"prompt"`
	// Run is a command typed into a new shell session once it is made (a recipe's command).
	Run string `json:"run"`
	// Agent starts a coding agent other than Claude ("codex", "grok", "mantis"; see Agents),
	// with Resume picking its conversation up again and Prompt as its first message.
	Agent string `json:"agent"`
	// Seen is when the session was last known to exist (unix seconds; 0 = it never did). A
	// session that is missing although tmux has been running since then was ended on purpose
	// (you left its shell, or killed it): it is not made again, and the script says "[gone]".
	// One missing because tmux itself restarted (the machine did) is brought back.
	Seen int64 `json:"seen"`
}

var (
	permissionMode = regexp.MustCompile(`^[A-Za-z]{2,30}$`)
)

// ClaudeFlags picks out of a claude command line the flags worth repeating when the same
// session is started again: how it handles permissions. Nothing else gets through, so the
// result is safe to type into a shell.
func ClaudeFlags(args string) string {
	var keep []string
	f := strings.Fields(args)
	for i := 0; i < len(f); i++ {
		switch {
		case f[i] == "--dangerously-skip-permissions":
			keep = append(keep, f[i])
		case f[i] == "--permission-mode" && i+1 < len(f) && permissionMode.MatchString(f[i+1]):
			keep = append(keep, f[i], f[i+1])
			i++
		case strings.HasPrefix(f[i], "--permission-mode=") && permissionMode.MatchString(strings.TrimPrefix(f[i], "--permission-mode=")):
			keep = append(keep, f[i])
		}
	}
	return strings.Join(keep, " ")
}

// AttachArgs is the ssh command line that opens a session in a terminal (the desktop app
// runs it in a pseudo-terminal; the CLI runs it directly). An empty session opens a plain
// login shell, which lands in tmux through the machine's .zshrc.
func (e *Engine) AttachArgs(machine, session string) ([]string, error) {
	return e.AttachArgsIn(machine, session, AttachOptions{})
}

// AttachArgsIn is AttachArgs for a session that may not exist yet: one ssh command creates
// it in the given folder (starting Claude Code when asked) and attaches. That keeps "new pane
// like this one" to a single round trip over the machine's shared ssh connection.
func (e *Engine) AttachArgsIn(machine, session string, o AttachOptions) ([]string, error) {
	m, err := e.Machine(machine)
	if err != nil {
		return nil, err
	}
	if err := e.Ready(m); err != nil {
		return nil, err
	}
	t := e.Target(m)
	// A pane whose connection died (the laptop slept, the network changed) should find out
	// in half a minute, so it can attach again; ssh keeps the first value it is given.
	args := []string{"ssh", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3"}
	if sock := termSocket(); sock != "" {
		// Through the machine's terminal connection when it is up. The option comes first:
		// ssh keeps the first value it is given (TerminalOptions says "none").
		args = append(args, "-o", "ControlPath="+sock)
	}
	args = append(args, t.TerminalOptions()...)
	args = append(args, "-t", t.Dest())
	if session == "" {
		return args, nil
	}
	return append(args, "--", sshx.RemotePath+attachScript(session, o)), nil
}

// attachScript is the remote side of AttachArgsIn. Sessions are addressed as "=name" so a
// name that is a prefix of another (shell-ab, shell-abcd) can't attach to the wrong one.
// ---------- the terminals' shared connection ----------
//
// Opening an ssh connection to a machine takes 0.6–1.2s; opening one more session on a
// connection that is already up takes about 0.1s. So each machine gets one connection for
// its terminals, kept warm while the app runs (WarmTerminals), and panes attach through it.
// It is apart from the connection commands and the session poll share, so many open panes
// can't crowd those out and sshx.CloseMaster doesn't drop any pane.
//
// Panes never own that connection (it is opened by a command with no terminal, so closing a
// pane can't take it down) and never depend on it: when it isn't there, or the server
// refuses another session on it (sshd's MaxSessions, 10 by default), ssh connects directly.

// termSocket is the ControlPath of the terminals' connection; empty where ssh can't share.
func termSocket() string {
	if runtime.GOOS == "windows" { // Windows OpenSSH has no connection sharing
		return ""
	}
	dir := filepath.Join(paths.Root(), "cmt")
	_ = os.MkdirAll(dir, 0o700)
	return filepath.Join(dir, "%C")
}

// termControl runs an ssh control command (check, stop, exit) on the terminals' connection.
func termControl(t sshx.Target, op string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	args := append([]string{"-o", "ControlPath=" + termSocket()}, t.Options(true)...)
	_, err := osx.Exec(ctx, osx.Cmd{Name: "ssh", Args: append(args, "-O", op, t.Dest())})
	return err
}

var termWarm = struct {
	sync.Mutex
	at   map[string]time.Time     // machine → when its connection was last seen up
	busy map[string]chan struct{} // machine → closed once the look under way is done
}{at: map[string]time.Time{}, busy: map[string]chan struct{}{}}

// WarmTerminals makes sure the machine's terminal connection is up, so the next pane on it
// opens right away. Cheap to call often: it looks at most every 15 seconds.
func (e *Engine) WarmTerminals(ctx context.Context, machine string) {
	e.warmTerminals(ctx, machine, false)
}

// ReadyTerminals is WarmTerminals that waits for the connection before a pane opens. Panes
// opening together (twenty of them after a restart) then share one connection instead of
// each making its own at once, which sshd answers by turning some away (MaxStartups).
func (e *Engine) ReadyTerminals(ctx context.Context, machine string) {
	e.warmTerminals(ctx, machine, true)
}

func (e *Engine) warmTerminals(ctx context.Context, machine string, wait bool) {
	if termSocket() == "" {
		return
	}
	m, err := e.Machine(machine)
	if err != nil || e.Ready(m) != nil {
		return
	}
	termWarm.Lock()
	if time.Since(termWarm.at[machine]) < 15*time.Second {
		termWarm.Unlock()
		return
	}
	if ch, busy := termWarm.busy[machine]; busy {
		termWarm.Unlock()
		if wait {
			select {
			case <-ch:
			case <-ctx.Done():
			}
		}
		return
	}
	done := make(chan struct{})
	termWarm.busy[machine] = done
	termWarm.Unlock()
	defer close(done)
	t := e.Target(m)
	up := termControl(t, "check") == nil
	if !up {
		// ssh puts the connection in the background (ControlPersist) and returns once `true`
		// has run. It closes itself after 15 idle minutes, so nothing lingers after the app.
		c, cancel := context.WithTimeout(ctx, 20*time.Second)
		args := append([]string{"-o", "ControlPath=" + termSocket(), "-o", "ControlPersist=900", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3"}, t.Options(true)...)
		_, err := osx.Exec(c, osx.Cmd{Name: "ssh", Args: append(args, t.Dest(), "true")})
		cancel()
		up = err == nil
	}
	termWarm.Lock()
	delete(termWarm.busy, machine)
	if up {
		termWarm.at[machine] = time.Now()
	}
	termWarm.Unlock()
}

// TendTerminals is called after each session poll with the machines that didn't answer.
// Machines that answered get their terminal connection warmed. One that didn't may have a
// dead connection (the laptop slept, the network changed): it is told to take no new panes,
// so they connect directly instead of waiting on it. Panes already on it are left alone.
func (e *Engine) TendTerminals(ctx context.Context, failed map[string]string) {
	if termSocket() == "" {
		return
	}
	all, _ := e.Machines()
	for _, m := range all {
		if m.Status == model.StatusStopped || m.Status == model.StatusMissing {
			continue
		}
		if _, bad := failed[m.Name]; !bad {
			go e.WarmTerminals(ctx, m.Name)
			continue
		}
		termWarm.Lock()
		_, was := termWarm.at[m.Name]
		delete(termWarm.at, m.Name)
		termWarm.Unlock()
		if was {
			go termControl(e.Target(m), "stop")
		}
	}
}

// TerminalConnCloser returns a function that closes the machine's terminal connection, as
// the machine is addressed right now. Take it before an operation that changes where the
// machine answers (start, stop, resize, delete) and call it after: panes opened later then
// connect afresh instead of waiting on a connection to the old address.
func (e *Engine) TerminalConnCloser(machine string) func() {
	m, err := e.Machine(machine)
	if err != nil || termSocket() == "" {
		return func() {}
	}
	t := e.Target(m)
	return func() {
		termWarm.Lock()
		delete(termWarm.at, machine)
		termWarm.Unlock()
		_ = termControl(t, "exit")
	}
}

// A pane is a UTF-8 terminal: -u keeps Claude's ✳ and box lines when the machine's login
// has no UTF-8 locale.
func attachScript(session string, o AttachOptions) string {
	return attachScriptWith("exec tmux -u", session, o)
}

// attachScriptWith is attachScript with the command that ends it: "exec tmux -u" on a machine,
// plain "tmux" on this computer, where tmux is a shell function for sky's own server.
func attachScriptWith(final, session string, o AttachOptions) string {
	name := sshx.Quote(session)
	claude := o.Claude || o.Resume != ""
	cd := `cd "$HOME"`
	switch dir := strings.TrimSpace(o.Dir); {
	// A folder that is gone lands the session in the home folder, as a plain shell: nothing
	// is started there. Claude continuing "the latest conversation" or a recipe's message
	// would otherwise run in a folder they were never meant for.
	case strings.HasPrefix(dir, "~/"):
		cd = `{ cd "$HOME"/` + sshx.Quote(dir[2:]) + ` 2>/dev/null || { cd "$HOME"; gone=` + sshx.Quote(dir) + `; }; }`
	case dir != "" && dir != "~":
		cd = `{ cd ` + sshx.Quote(dir) + ` 2>/dev/null || { cd "$HOME"; gone=` + sshx.Quote(dir) + `; }; }`
	}
	// What is typed into a new session, unless its folder is gone: then a line saying so.
	typeLine := `if [ -n "$gone" ]; then tmux send-keys -t "=$s:" "# skybuild: $gone is not there any more, so nothing was started" Enter; else tmux send-keys -t "=$s:" "$line" Enter; fi`
	// No status line in sessions made for a pane: the app shows the machine and the name.
	create := `tmux new-session -d -s "$s" -c "$PWD" && tmux set-option -t "=$s:" status off >/dev/null 2>&1;`
	if claude {
		// Type claude into the session's own shell (it has the user's environment), then
		// answer Claude's "trust this folder" prompt: the user asked for Claude right here.
		// The prompt has started on "No, exit" in some versions and on "Yes" in others, so
		// look at which line the cursor is on.
		flags := ""
		if f := ClaudeFlags(o.Flags); f != "" {
			flags = " " + f
		}
		// The first message goes through a file, so anything can be in it: the session's shell
		// reads it back when it runs the command. With a given conversation picked up again it
		// is the next message in it (a session moved here in the middle of its work goes on);
		// "the latest conversation here" takes none, as it may not be the one meant.
		prep, first := "", ""
		if p := strings.TrimSpace(o.Prompt); p != "" {
			if len(p) > 32*1024 {
				p = p[:32*1024]
			}
			file := `"$HOME"/.skybuild/prompts/` + sshx.Quote(SessionName(session)+".txt")
			prep = `mkdir -p "$HOME"/.skybuild/prompts && printf '%s' ` + sshx.Quote(p) + ` > ` + file + `; `
			first = ` "$(cat ~/.skybuild/prompts/` + SessionName(session) + `.txt)"`
		}
		line := prep + `line=` + sshx.Quote("claude"+flags+first) + `;`
		switch {
		case sessionID.MatchString(o.Resume) && o.Resume != "continue":
			// The conversation this session had, when its transcript is on this machine.
			// No transcript means that Claude never had a conversation: it starts afresh (the
			// latest conversation in the folder could be another session's).
			line = prep + `if ls "$HOME"/.claude/projects/*/` + sshx.Quote(o.Resume+".jsonl") + ` >/dev/null 2>&1; then line=` + sshx.Quote("claude --resume "+o.Resume+flags+first) + `; else line=` + sshx.Quote("claude"+flags+first) + `; fi;`
		case o.Resume != "":
			line = `line=` + sshx.Quote("claude --continue"+flags) + `;`
		}
		create = line + ` ` + strings.TrimSuffix(create, ";") + `; ` + typeLine + ` && ( i=0; while [ $i -lt 16 ]; do sleep 0.5; p=$(tmux capture-pane -p -t "=$s:" 2>/dev/null); case "$p" in *"trust this folder"*) if printf %s "$p" | grep -q "❯.*Yes"; then tmux send-keys -t "=$s:" Enter; else tmux send-keys -t "=$s:" Down Enter; fi; break;; *"? for shortcuts"*|*"shift+tab to cycle"*|*"esc to interrupt"*) break;; esac; i=$((i+1)); done ) >/dev/null 2>&1 &`
	}
	if a := o.Agent; a != "" && a != "claude" {
		// Another agent: its command typed into the session's shell, picking a conversation
		// up again when asked. (Nothing to answer afterwards, unlike Claude's trust prompt.)
		if line := agentLine(a, o.Resume, strings.TrimSpace(o.Prompt)); line != "" {
			create = `line=` + sshx.Quote(line) + `; tmux new-session -d -s "$s" -c "$PWD" && tmux set-option -t "=$s:" status off >/dev/null 2>&1; ` + typeLine + `;`
		}
	}
	if run := strings.TrimSpace(strings.SplitN(o.Run, "\n", 2)[0]); run != "" && !claude && o.Agent == "" {
		create = `line=` + sshx.Quote(run) + `; ` + strings.TrimSuffix(create, ";") + `; ` + typeLine + `;`
	}
	gone := ""
	if o.Seen > 0 {
		// Two minutes of slack for clocks that disagree.
		gone = `st=$(tmux display-message -p '#{start_time}' 2>/dev/null); if [ -n "$st" ] && [ "$st" -lt ` + strconv.FormatInt(o.Seen-120, 10) + ` ]; then echo '[gone]'; exit 0; fi; `
	}
	return `s=` + name + `; ` + cd + `; if ! tmux has-session -t "=$s" 2>/dev/null; then ` + gone + create + ` fi; ` + final + ` attach-session -t "=$s"`
}

// ShellPrefix names the tmux sessions behind plain shell panes. They exist so a pane can
// reconnect to the same shell, and are removed once nobody is using them.
const ShellPrefix = "shell-"

const idleShell = `case "$(tmux display -p -t "$s" '#{pane_current_command}' 2>/dev/null)" in zsh|bash|fish|sh|dash|-zsh|-bash) [ "$(tmux list-panes -s -t "$s" 2>/dev/null | wc -l)" -le 1 ];; *) false;; esac`

// CloseShell ends a pane's tmux session when it is only an idle shell. A session that is
// running something (Claude, a dev server, a build) is left alone and shows up under sessions.
func (e *Engine) CloseShell(ctx context.Context, machine, session string) error {
	// Shell panes, and Claude sessions Claude has left: both are just a shell by now.
	if !strings.HasPrefix(session, ShellPrefix) && !strings.HasPrefix(session, "claude") {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	_, err := e.runOn(ctx, machine, "s="+sshx.Quote(session)+"; if "+idleShell+"; then tmux kill-session -t \"$s\"; fi; true")
	return err
}

// ReapShells removes shell-pane sessions nobody is attached to and nothing is running in
// (left behind when a pane's connection dropped for good), once they are a few minutes old.
// keep lists, per machine, the sessions open panes still point at: those stay, so a pane
// that lost its connection finds its shell again.
func (e *Engine) ReapShells(ctx context.Context, keep map[string][]string) {
	script := func(machine string) string {
		kept := " " + strings.Join(keep[machine], " ") + " "
		return `kept=` + sshx.Quote(kept) + `; now=$(date +%s); tmux list-sessions -F '#{session_name} #{session_attached} #{session_activity}' 2>/dev/null | while read -r s att act; do case "$s" in ` + ShellPrefix + `*) case "$kept" in *" $s "*) continue;; esac; [ "$att" = 0 ] && [ $((now - act)) -gt 300 ] && if ` + idleShell + `; then tmux kill-session -t "$s"; fi;; esac; done; true`
	}
	if LocalTmux() != "" {
		c, cancel := context.WithTimeout(ctx, 10*time.Second)
		_, _ = localSh(c, script(LocalMachine))
		cancel()
	}
	all, _ := e.Machines()
	for _, m := range all {
		if m.Status == model.StatusStopped || m.Status == model.StatusMissing {
			continue
		}
		c, cancel := context.WithTimeout(ctx, 15*time.Second)
		_, _ = sshx.Run(c, e.Target(m), script(m.Name))
		cancel()
	}
}

// screenTail is the last n lines of a screen that aren't blank.
func screenTail(screen string, n int) string {
	var keep []string
	for _, line := range strings.Split(screen, "\n") {
		if strings.TrimSpace(line) != "" {
			keep = append(keep, line)
		}
	}
	if len(keep) > n {
		keep = keep[len(keep)-n:]
	}
	return strings.Join(keep, "\n")
}
