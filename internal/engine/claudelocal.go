package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"skybuild/internal/claudeacct"
	"skybuild/internal/config"
	"skybuild/internal/events"
	"skybuild/internal/osx"
	"skybuild/internal/paths"
	"skybuild/internal/proc"
	"skybuild/internal/sshx"
)

// Claude in the sessions on this computer.
//
// They sign in as the account the machines use, so a switch away from a limited account
// reaches them too. This computer's own Claude Code login is left alone:
//   - the active account's token is kept in a file only you can read (claude-token);
//   - claude-login.sh defines a `claude` that starts Claude with that token;
//   - sky's tmux server tells the shells in its panes where that script is (SKY_CLAUDE_LOGIN),
//     and one line in ~/.zshenv (or ~/.bashrc) loads it there and nowhere else.
//
// Claude in any other terminal, or started with its own CLAUDE_CONFIG_DIR, keeps its own
// login. A Claude running with another login is moved like one on a machine (see
// MoveToNewLogin). macOS doesn't show another process's environment, so the wrapper leaves a
// mark instead: it touches claude-login/<pid of the shell> as it starts Claude with the
// token. A Claude whose shell has no mark newer than the token started without it, or before
// the account changed.
//
// On a Mac that has never had Claude Code, the same wrapper installs it the first time a
// session asks for Claude, and sessions that sign in with the pool's token skip Claude's
// first-run screens (whose sign-in step would ask for a login they already have).

// localLoginLine loads the claude wrapper in the shells of sky's tmux server.
const localLoginLine = `[ -n "$SKY_CLAUDE_LOGIN" ] && [ -r "$SKY_CLAUDE_LOGIN" ] && . "$SKY_CLAUDE_LOGIN"  # skybuild:claude-login v1`

func localTokenFile() string   { return filepath.Join(paths.Root(), "claude-token") }
func localLoginScript() string { return filepath.Join(paths.Root(), "claude-login.sh") }
func localLoginMarks() string  { return filepath.Join(paths.Root(), "claude-login") }

// claudeInstaller installs Claude Code with Anthropic's installer: into ~/.local/bin, with
// nothing else needed (the npm package needs Node).
const claudeInstaller = "curl -fsSL https://claude.ai/install.sh | bash"

// localLoginScriptText is claude-login.sh. An empty token file means "this computer's own
// login" (see ClaudeFollowLogin): the shell is still marked, so sessions started on the pool's
// token before you chose that are moved to it. `function claude` rather than `claude()`: zsh
// refuses the latter when an alias named claude exists, as it may when the script is loaded
// into a shell that is already running. The mark is written before the token is read (a
// switch in between costs one needless move, never a missed one), with >| in case the shell
// has noclobber set. ~/.local/bin, where Claude's installer puts it, goes last on PATH (a new
// Mac's PATH doesn't have it), and /usr/bin/which looks for the program, not this function.
func localLoginScriptText() string {
	tok := sshx.Quote(localTokenFile())
	mark := sshx.Quote(localLoginMarks()) + `/$$`
	install := `if ! /usr/bin/which claude >/dev/null 2>&1; then echo "Installing Claude Code (Lungo does this once)..."; ` + claudeInstaller + `; hash -r; /usr/bin/which claude >/dev/null 2>&1 || { echo "Couldn't install Claude Code. Get it from https://claude.com/claude-code and try again." >&2; return 1; }; fi; `
	return `# Written by sky. Claude in Lungo's sessions on this computer signs in as the Claude account
# the machines use; Claude anywhere else keeps this computer's own login.
export SKY_CLAUDE_LOGIN=` + sshx.Quote(localLoginScript()) + `
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$PATH:$HOME/.local/bin" ;; esac
function claude { ` + install + `if [ -z "$CLAUDE_CONFIG_DIR" ] && [ -r ` + tok + ` ]; then printf . 2>/dev/null >| ` + mark + `; if [ -s ` + tok + ` ]; then CLAUDE_CODE_OAUTH_TOKEN="$(cat ` + tok + `)" command claude "$@"; else command claude "$@"; fi; else command claude "$@"; fi; }
`
}

// localLoginPrefix goes in front of a Claude command typed into a local session's shell, so
// one started before the wrapper existed gets it too: ". ~/.skybuild/claude-login.sh && ".
func localLoginPrefix() string {
	p := paths.Tilde(localLoginScript())
	if strings.HasPrefix(p, "~/") && !strings.ContainsAny(p[2:], " '\"\\$`!*?[]{}()<>|&;#~") {
		return ". " + p + " && "
	}
	return ". " + sshx.Quote(localLoginScript()) + " && "
}

// localLoginAt is when the login sessions on this computer use last changed (to another pool
// account, or to this computer's own login); zero when sky has never pointed them anywhere.
func localLoginAt() time.Time {
	st, err := os.Stat(localTokenFile())
	if err != nil {
		return time.Time{}
	}
	return st.ModTime()
}

// onOldLogin reports whether a Claude started from one of these shells (its parent, the
// pane's) runs on another login than the one sessions here have used since loginAt.
func onOldLogin(loginAt time.Time, shells ...int) bool {
	for _, pid := range shells {
		if pid <= 0 {
			continue
		}
		if st, err := os.Stat(filepath.Join(localLoginMarks(), strconv.Itoa(pid))); err == nil && !st.ModTime().Before(loginAt) {
			return false
		}
	}
	return true
}

// pruneLoginMarks forgets the marks of shells that have ended.
func pruneLoginMarks(ctx context.Context) {
	entries, err := os.ReadDir(localLoginMarks())
	if err != nil || len(entries) == 0 {
		return
	}
	procs := proc.List(ctx)
	for _, e := range entries {
		if pid, err := strconv.Atoi(e.Name()); err == nil {
			if _, alive := procs.Rows[pid]; alive {
				continue
			}
		}
		_ = os.Remove(filepath.Join(localLoginMarks(), e.Name()))
	}
}

// syncLocalLogin points the sessions on this computer at the active account: its token in
// the file, the wrapper, and the line that loads it. When they follow this computer's own
// login the file is left empty (Claude there then switches with /login like anywhere else).
// With no account in the pool the file is removed, and the wrapper stays for what else it
// does (installing Claude, ~/.local/bin on PATH).
func (e *Engine) syncLocalLogin(ctx context.Context) error {
	if LocalTmux() == "" {
		return nil // no sessions on this computer
	}
	token, follow := "", false
	if c, err := config.Load(); err == nil {
		if id := activeID(c); id != "" {
			token = claudeacct.Token(id)
		}
		follow = c.Settings.ClaudeFollowLogin() && token != ""
	}
	if err := paths.Ensure(); err != nil {
		return err
	}
	if err := os.MkdirAll(localLoginMarks(), 0o700); err != nil {
		return err
	}
	pruneLoginMarks(ctx)
	if _, err := paths.WriteFile(localLoginScript(), []byte(localLoginScriptText()), 0o600); err != nil {
		return err
	}
	switch {
	case follow:
		if _, err := paths.WriteFile(localTokenFile(), nil, 0o600); err != nil {
			return err
		}
	case token == "":
		if err := os.Remove(localTokenFile()); err != nil && !os.IsNotExist(err) {
			return err
		}
	default:
		if _, err := paths.WriteFile(localTokenFile(), []byte(token+"\n"), 0o600); err != nil {
			return err
		}
		if err := markClaudeOnboarded(); err != nil {
			return err
		}
	}
	return ensureLocalLoginLine()
}

// SyncLocalLogin is syncLocalLogin for the app to run as it starts: the first sessions then
// have the wrapper (Claude installed on first use, the pool's login) without waiting a minute
// for the first rotation pass.
func (e *Engine) SyncLocalLogin(ctx context.Context) error { return e.syncLocalLogin(ctx) }

// markClaudeOnboarded tells Claude Code on this computer that its first run is done (theme,
// sign-in, notes), as sync does on machines: sessions here sign in with the pool's token, and
// Claude's sign-in step would ask for a login anyway. Only that key changes, and a
// ~/.claude.json that doesn't read as JSON is left alone.
func markClaudeOnboarded() error {
	path := filepath.Join(paths.Home(), ".claude.json")
	cfg := map[string]any{}
	raw, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return err
	default:
		d := json.NewDecoder(bytes.NewReader(raw))
		d.UseNumber() // big numbers come back as they were
		if d.Decode(&cfg) != nil {
			return nil
		}
	}
	if cfg["hasCompletedOnboarding"] == true {
		return nil
	}
	cfg["hasCompletedOnboarding"] = true
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	_, err = paths.WriteFile(path, append(out, '\n'), 0o600)
	return err
}

// EnsureLocalClaude installs Claude Code on this computer when it isn't there (see
// claudeInstaller). The browser sign-in needs it: it is `claude setup-token`.
func EnsureLocalClaude(ctx context.Context, r events.Reporter) error {
	if osx.Has("claude") {
		return nil
	}
	events.Stepf(r, "Installing Claude Code")
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	res, err := osx.Exec(ctx, osx.Cmd{Name: "/bin/sh", Args: []string{"-c", claudeInstaller}, Dir: paths.Home()})
	for _, line := range strings.Split(strings.TrimSpace(res.Stdout+"\n"+res.Stderr), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			events.Logf(r, "%s", line)
		}
	}
	if err != nil {
		return errors.New("couldn't install Claude Code: " + err.Error())
	}
	if !osx.Has("claude") {
		return errors.New("the installer finished but Claude Code isn't in ~/.local/bin")
	}
	return nil
}

// ensureLocalLoginLine adds localLoginLine to the startup file of your shell (zsh: ~/.zshenv,
// read by every zsh; bash: ~/.bashrc), replacing an older version of it.
func ensureLocalLoginLine() error {
	file := ".zshenv"
	switch filepath.Base(os.Getenv("SHELL")) {
	case "bash":
		file = ".bashrc"
	case "fish", "nu", "elvish":
		return nil // not a shell that can load the script
	}
	path := filepath.Join(paths.Home(), file)
	cur, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	next, changed := withManagedLine(string(cur), localLoginLine, "skybuild:claude-login")
	if !changed {
		return nil
	}
	mode := os.FileMode(0o644)
	if st, err := os.Stat(path); err == nil {
		mode = st.Mode().Perm()
	}
	_, err = paths.WriteFile(path, []byte(next), mode)
	return err
}

// withManagedLine is text with line in it once (added at the end) and no older line carrying
// the same marker.
func withManagedLine(text, line, marker string) (string, bool) {
	var keep []string
	found := false
	for _, l := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		switch {
		case l == line && !found:
			found = true
			keep = append(keep, l)
		case strings.Contains(l, "# "+marker):
			// an older version of the line, or a second copy
		default:
			keep = append(keep, l)
		}
	}
	if !found {
		keep = append(keep, line)
	}
	next := strings.TrimLeft(strings.Join(keep, "\n"), "\n") + "\n"
	return next, next != text
}
