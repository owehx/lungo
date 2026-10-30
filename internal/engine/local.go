package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"skybuild/internal/bootstrap"
	"skybuild/internal/osx"
	"skybuild/internal/paths"
	"skybuild/internal/proc"
	"skybuild/internal/sshx"
)

// Sessions on this computer.
//
// They run in a tmux server of sky's own (its own socket and settings, apart from any tmux
// the user runs), so a local pane is a session exactly like one on a machine: it keeps
// running when the app quits and is there again when the app comes back. Where a function
// takes a machine name, LocalMachine means this computer.

// LocalMachine is the machine name that sessions on this computer carry. It can't be a real
// machine's name (those are letters, digits and dashes).
const LocalMachine = "@local"

// IsLocal reports whether a machine name means this computer.
func IsLocal(machine string) bool { return machine == LocalMachine }

// ErrNoLocalTmux: sessions on this computer need tmux, and it isn't installed.
var ErrNoLocalTmux = errors.New("tmux isn't installed on this computer")

// localSocket names sky's tmux server. SKY_TMUX_SOCKET gives a development build its own,
// so it never touches the sessions of the installed app.
func localSocket() string {
	if s := os.Getenv("SKY_TMUX_SOCKET"); s != "" {
		return s
	}
	return "skybuild"
}

// LocalTmux is the path of tmux on this computer, or "" when it isn't installed. A tmux you
// installed comes first; on a Mac without one it is the app's own (see bundledTmux).
func LocalTmux() string {
	if runtime.GOOS == "windows" {
		return ""
	}
	if os.Getenv("SKY_BUNDLED_TMUX") == "1" { // the app's own even where one is installed, to try it
		if p := bundledTmux(); p != "" {
			return p
		}
	}
	if p := osx.Which("tmux"); filepath.IsAbs(p) {
		return p
	}
	if p, err := exec.LookPath("tmux"); err == nil {
		return p
	}
	return bundledTmux()
}

// bundledTmux is the tmux that came inside Lungo.app (Contents/Helpers/tmux, built by
// scripts/build-tmux.sh), or "" outside the app. macOS doesn't come with tmux, and without it
// nothing on this computer is a session.
//
// It runs from a copy in ~/.skybuild/bin: the server outlives the app, and the app may be
// running from its DMG (a server started there keeps the disk from ejecting, and dies if it is
// forced) or from a path macOS made up for an app opened in Downloads. The copy is replaced
// by a rename, so a server already running keeps its program. That folder joins PATH (last,
// so a tmux installed later wins), so the server and the shells in its panes find `tmux` too.
var bundledTmux = sync.OnceValue(func() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	src := bundledTmuxFor(exe)
	if src == "" {
		return ""
	}
	p := filepath.Join(paths.Root(), "bin", "tmux")
	if err := copyProgram(src, p); err != nil {
		p = src // run it where it is rather than not at all
	}
	os.Setenv("PATH", os.Getenv("PATH")+string(os.PathListSeparator)+filepath.Dir(p))
	return p
})

// copyProgram puts the program src at dst, unless it is there already.
func copyProgram(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	_, err = paths.WriteFile(dst, b, 0o755)
	return err
}

// bundledTmuxFor is where the app whose program is exe keeps its tmux, if it has one.
func bundledTmuxFor(exe string) string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	p := filepath.Join(filepath.Dir(filepath.Dir(exe)), "Helpers", "tmux")
	if st, err := os.Stat(p); err != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0o111 == 0 {
		return ""
	}
	return p
}

// localTmuxConf is what sky's tmux server on this computer starts with: the settings every
// machine gets, no status line (the app shows what it would), and a terminal type every
// program on macOS knows.
const localTmuxConf = `# skybuild: tmux settings for sessions on this computer. Rewritten by the app.
set -g default-terminal "xterm-256color"
set -g status off
set -g base-index 1
setw -g pane-base-index 1
` + bootstrap.TmuxManaged

// localConfText is localTmuxConf plus where the shells in its panes find the claude wrapper
// (see claudelocal.go).
func localConfText() string {
	text := localTmuxConf
	if p := localLoginScript(); !strings.ContainsAny(p, "'\n") {
		text += "set-environment -g SKY_CLAUDE_LOGIN '" + p + "'\n"
	}
	return text
}

func localConf() (string, error) {
	path := filepath.Join(paths.Root(), "tmux.local.conf")
	want := localConfText()
	if have, err := os.ReadFile(path); err == nil && string(have) == want {
		return path, nil
	}
	if err := os.MkdirAll(paths.Root(), 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(want), 0o600); err != nil {
		return "", err
	}
	// New settings reach a server that is already running (it read the file when it started).
	if tm := LocalTmux(); tm != "" {
		_ = exec.Command(tm, "-L", localSocket(), "source-file", path).Run()
	}
	return path, nil
}

// localPrelude makes `tmux` in a script mean sky's server on this computer. The variables
// it drops belong to a Claude Code session the app may have been started from; a session
// in a pane must not inherit them. -u: UTF-8 whatever the locale says (see osx.FixLocale),
// so lists keep their tabs and panes their ✳ and box lines.
func localPrelude() (string, error) {
	tm := LocalTmux()
	if tm == "" {
		return "", ErrNoLocalTmux
	}
	conf, err := localConf()
	if err != nil {
		return "", err
	}
	return "unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SSE_PORT; tmux() { " + sshx.Quote(tm) + " -u -L " + sshx.Quote(localSocket()) + " -f " + sshx.Quote(conf) + ` "$@"; }; `, nil
}

// localSh runs a script on this computer with `tmux` meaning sky's server.
func localSh(ctx context.Context, script string) (string, error) {
	pre, err := localPrelude()
	if err != nil {
		return "", err
	}
	r, err := osx.Exec(ctx, osx.Cmd{Name: "/bin/sh", Args: []string{"-c", pre + script}, Dir: paths.Home()})
	return r.Stdout, err
}

// runOn runs a script on a machine, or on this computer for LocalMachine.
func (e *Engine) runOn(ctx context.Context, machine, script string) (string, error) {
	if IsLocal(machine) {
		return localSh(ctx, script)
	}
	m, err := e.Machine(machine)
	if err != nil {
		return "", err
	}
	return sshx.Run(ctx, e.Target(m), script)
}

// LocalAttachArgs is the command that opens a session on this computer in a terminal,
// creating it first when it doesn't exist (see AttachArgsIn).
func (e *Engine) LocalAttachArgs(session string, o AttachOptions) ([]string, error) {
	pre, err := localPrelude()
	if err != nil {
		return nil, err
	}
	if session == "" {
		return nil, errors.New("a session name is needed")
	}
	// No exec at the end: `tmux` is a shell function here.
	return []string{"/bin/sh", "-c", pre + attachScriptWith("tmux", session, o)}, nil
}

// localListFormat is a session's line, as parseSessions reads it.
const localListFormat = "#{session_name}\t#{session_created}\t#{window_activity}\t#{session_attached}\t#{session_windows}\t#{pane_current_path}\t#{pane_current_command}\t#{host_short}\t#{pane_title}\t#{?mouse_any_flag,m,}#{?alternate_on,a,}#{?@sky-keys,k,}"

// localPaneMark starts a pane's line in the same listing.
const localPaneMark = "@@p\t"

// localTmuxRun runs tmux on sky's server directly, no shell: several tmux commands in one
// go are separated by a ";" argument. ok is false when no server is running (no sessions).
func localTmuxRun(ctx context.Context, args ...string) (out string, ok bool, err error) {
	tm := LocalTmux()
	if tm == "" {
		return "", false, ErrNoLocalTmux
	}
	conf, err := localConf()
	if err != nil {
		return "", false, err
	}
	r, err := osx.Exec(ctx, osx.Cmd{Name: tm, Args: append([]string{"-u", "-L", localSocket(), "-f", conf}, args...), Dir: paths.Home()})
	if err != nil {
		if msg := r.Stderr + err.Error(); strings.Contains(msg, "no server running") || strings.Contains(msg, "error connecting to") {
			return "", false, nil
		}
		return r.Stdout, true, err
	}
	return r.Stdout, true, nil
}

// LocalSessions lists the sessions on this computer. Claude's state comes from Claude Code's
// own record of its running sessions (no hooks are installed here) and from the screen.
// It costs two tmux calls and no shell: the processes, branches and screens are read here.
func (e *Engine) LocalSessions(ctx context.Context) ([]Session, error) {
	if LocalTmux() == "" {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	out, running, err := localTmuxRun(ctx, "list-sessions", "-F", localListFormat, ";", "list-panes", "-a", "-F", localPaneMark+"#{session_name}\t#{pane_pid}\t#{window_active}#{pane_active}")
	if err != nil {
		return nil, fmt.Errorf("tmux: %w", err)
	}
	if !running {
		return []Session{}, nil
	}
	var list, panesRaw strings.Builder
	for _, line := range strings.Split(out, "\n") {
		if rest, ok := strings.CutPrefix(line, localPaneMark); ok {
			panesRaw.WriteString(rest + "\n")
		} else if line != "" {
			list.WriteString(line + "\n")
		}
	}
	sessions := parseSessions(LocalMachine, list.String())
	for i := 0; i < len(sessions); i++ {
		if sessions[i].Name == watchSession { // the watcher's own (see WatchLocal): never shown
			sessions = append(sessions[:i], sessions[i+1:]...)
			break
		}
	}
	if len(sessions) == 0 {
		if strings.TrimSpace(list.String()) != "" {
			// Lines that don't read as sessions mean the listing broke (as when tmux once
			// printed tabs as "_"): say so rather than show no sessions.
			if first, _, _ := strings.Cut(list.String(), "\n"); !strings.HasPrefix(first, watchSession+"\t") || strings.Count(list.String(), "\n") > 1 {
				return nil, fmt.Errorf("tmux listed sessions that can't be read (%.80q)", first)
			}
		}
		return sessions, nil
	}
	for i := range sessions {
		sessions[i].Branch = localBranch(sessions[i].Path)
	}
	shells := map[string]int{} // session → pid of the shell in its active pane
	for _, line := range strings.Split(panesRaw.String(), "\n") {
		f := strings.Split(strings.TrimSpace(line), "\t")
		if len(f) < 3 {
			continue
		}
		if pid, err := strconv.Atoi(f[1]); err == nil && (f[2] == "11" || shells[f[0]] == 0) {
			shells[f[0]] = pid
		}
	}
	procs := processTable(ctx)
	var capture []string // sessions whose screen tells what their agent is doing
	claudes := map[string]int{}
	others := map[string]string{} // session → another agent running in it
	for i := range sessions {
		s := &sessions[i]
		pid := procs.claudeUnder(shells[s.Name])
		if pid == 0 {
			s.State, s.Message, s.Agent = "", "", ""       // no agent running, whatever the program in the pane looked like
			s.Claude = strings.HasPrefix(s.Name, "claude") // Claude has exited; a shell is in the pane now
			if a := procs.agentUnder(shells[s.Name]); a != "" {
				s.Claude, s.Agent, s.Command, s.State = false, a, a, "idle"
				s.Title = agentTitle(a, s.Title, s.Path)
				others[s.Name] = a
				capture = append(capture, s.Name)
			}
			continue
		}
		s.Agent = "claude"
		claudes[s.Name] = pid
		s.Claude, s.Command = true, "claude"
		s.Flags = ClaudeFlags(procs.args(pid))
		capture = append(capture, s.Name)
	}
	if len(claudes) == 0 && len(others) == 0 {
		return sessions, nil
	}
	screens := localScreens(ctx, capture)
	loginAt := localLoginAt()
	host, _ := os.Hostname()
	host, _, _ = strings.Cut(host, ".")
	for i := range sessions {
		s := &sessions[i]
		if a, ok := others[s.Name]; ok {
			if state, msg := agentScreenState(a, screens[s.Name]); state != "" {
				s.State, s.Message = state, msg
			}
			continue
		}
		pid, ok := claudes[s.Name]
		if !ok {
			continue
		}
		rec := readClaudeRecord(pid)
		s.SID = rec.SessionID
		if !loginAt.IsZero() && s.SID != "" { // no record here: a Claude with a config dir of its own
			s.LoginAt, s.OldLogin = loginAt, onOldLogin(loginAt, procs.Rows[pid].PPID, shells[s.Name])
		}
		switch rec.Status {
		case "busy", "shell":
			s.State = "working"
		case "idle":
			s.State = "idle"
		default:
			s.State = ""
		}
		if rec.StatusUpdatedAt > 0 {
			s.StateAt = time.UnixMilli(rec.StatusUpdatedAt)
		}
		if s.Title == "" {
			s.Title = cleanTitle(rec.Name, host)
		}
		// A prompt on screen is the surest sign Claude is waiting on you.
		if state, msg := screenState(screens[s.Name]); state == "waiting" || (state != "" && s.State == "") {
			s.State = state
			if msg != "" {
				s.Message = msg
			}
		}
		if s.State == "" {
			s.State = "idle"
		}
	}
	return sessions, nil
}

// claudeRecord is what Claude Code keeps about a running session in ~/.claude/sessions.
type claudeRecord struct {
	SessionID       string `json:"sessionId"`
	Name            string `json:"name"`
	Status          string `json:"status"`
	StatusUpdatedAt int64  `json:"statusUpdatedAt"`
}

func readClaudeRecord(pid int) claudeRecord {
	var rec claudeRecord
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	if dir == "" {
		dir = filepath.Join(paths.Home(), ".claude")
	}
	if b, err := os.ReadFile(filepath.Join(dir, "sessions", strconv.Itoa(pid)+".json")); err == nil {
		_ = json.Unmarshal(b, &rec)
	}
	if !sessionID.MatchString(rec.SessionID) {
		rec.SessionID = ""
	}
	return rec
}

// sessionID is the shape of a Claude Code conversation ID (it ends up on a command line).
var sessionID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$`)

// procTable is every process on this computer (see proc): parents, and command lines read
// when asked.
type procTable struct{ *proc.Table }

func processTable(ctx context.Context) procTable { return procTable{proc.List(ctx)} }

func (t procTable) args(pid int) string { return t.Args(pid) }

// agentUnder finds another coding agent (Codex, Grok, Mantis) among a shell's descendants
// and says which; "" when there is none.
func (t procTable) agentUnder(shell int) string {
	if shell <= 0 {
		return ""
	}
	var walk func(pid, depth int) string
	walk = func(pid, depth int) string {
		if a := agentOfArgs(t.args(pid)); a != "" && a != "claude" {
			return a
		}
		if depth > 8 {
			return ""
		}
		for _, k := range t.Kids[pid] {
			if a := walk(k, depth+1); a != "" {
				return a
			}
		}
		return ""
	}
	return walk(shell, 0)
}

// claudeUnder finds Claude Code among a shell's descendants: run by name, or as the
// versioned binary its installer keeps under …/claude/versions/. Zero when it isn't there.
func (t procTable) claudeUnder(shell int) int {
	if shell <= 0 {
		return 0
	}
	var walk func(pid, depth int) int
	walk = func(pid, depth int) int {
		arg0, _, _ := strings.Cut(t.args(pid), " ")
		if filepath.Base(arg0) == "claude" || strings.Contains(arg0, "/claude/versions/") {
			return pid
		}
		if depth > 8 {
			return 0
		}
		for _, k := range t.Kids[pid] {
			if p := walk(k, depth+1); p != 0 {
				return p
			}
		}
		return 0
	}
	return walk(shell, 0)
}
