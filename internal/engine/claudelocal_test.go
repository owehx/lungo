package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"skybuild/internal/paths"
	"skybuild/internal/proc"
)

// The wrapper, loaded the way a pane's shell loads it, starts Claude with the pool's token
// and marks the shell; outside sky's panes, or with a config dir of its own, it changes
// nothing.
func TestLocalLoginWrapper(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	t.Setenv("SKYBUILD_HOME", root)
	t.Setenv("HOME", home)
	bin := t.TempDir()
	fake := "#!/bin/sh\necho \"token=${CLAUDE_CODE_OAUTH_TOKEN:-none} args=$*\"\n"
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(fake), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(localLoginScript(), []byte(localLoginScriptText()), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(localLoginMarks(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(localTokenFile(), []byte("sk-ant-oat01-pool\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, sh := range []string{"zsh", "bash"} {
		path, err := exec.LookPath(sh)
		if err != nil {
			continue
		}
		run := func(env []string, script string) string {
			t.Helper()
			cmd := exec.Command(path, "-c", script)
			cmd.Env = append([]string{"HOME=" + home, "PATH=" + bin + ":/usr/bin:/bin"}, env...)
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("%s: %v\n%s", sh, err, out)
			}
			return strings.TrimSpace(string(out))
		}
		load := localLoginLine + "\n"
		inPane := []string{"SKY_CLAUDE_LOGIN=" + localLoginScript()}

		if got := run(inPane, load+`claude --resume abc "two words"; echo "pid=$$"`); !strings.HasPrefix(got, "token=sk-ant-oat01-pool args=--resume abc two words\npid=") {
			t.Errorf("%s in a pane: %q", sh, got)
		} else if pid := strings.TrimPrefix(got[strings.LastIndex(got, "pid="):], "pid="); !fileExists(filepath.Join(localLoginMarks(), pid)) {
			t.Errorf("%s: no mark for shell %s", sh, pid)
		}
		if got := run(nil, load+"claude"); got != "token=none args=" {
			t.Errorf("%s outside a pane: %q", sh, got)
		}
		if got := run(append(inPane, "CLAUDE_CONFIG_DIR=/x"), load+"claude"); got != "token=none args=" {
			t.Errorf("%s with its own config dir: %q", sh, got)
		}
		// An alias named claude, and noclobber, in a shell that loads the script late (as the
		// command typed by a move does).
		late := "set -o noclobber; alias claude='claude --x'\n" + localLoginPrefix() + "claude --resume abc"
		if sh == "bash" {
			late = "shopt -s expand_aliases\n" + late
		}
		// (bash expands the alias on the typed line; zsh -c parsed it before the alias existed)
		if got := run(nil, late); got != "token=sk-ant-oat01-pool args=--resume abc" && got != "token=sk-ant-oat01-pool args=--x --resume abc" {
			t.Errorf("%s loaded late: %q", sh, got)
		}
		// With the token gone (no account in the pool), this computer's own login.
		os.Rename(localTokenFile(), localTokenFile()+".x")
		if got := run(inPane, load+"claude"); got != "token=none args=" {
			t.Errorf("%s without a token: %q", sh, got)
		}
		os.Rename(localTokenFile()+".x", localTokenFile())
		// Following this computer's own login: an empty token file. The shell is still marked.
		os.WriteFile(localTokenFile(), nil, 0o600)
		if got := run(inPane, load+`claude; echo "pid=$$"`); !strings.HasPrefix(got, "token=none args=\npid=") {
			t.Errorf("%s following the login: %q", sh, got)
		} else if pid := strings.TrimPrefix(got[strings.LastIndex(got, "pid="):], "pid="); !fileExists(filepath.Join(localLoginMarks(), pid)) {
			t.Errorf("%s following the login: no mark for shell %s", sh, pid)
		}
		os.WriteFile(localTokenFile(), []byte("sk-ant-oat01-pool\n"), 0o600)
	}
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func TestOnOldLogin(t *testing.T) {
	t.Setenv("SKYBUILD_HOME", t.TempDir())
	os.MkdirAll(localLoginMarks(), 0o700)
	now := time.Now()
	mark := func(pid int, at time.Time) {
		p := filepath.Join(localLoginMarks(), strconv.Itoa(pid))
		os.WriteFile(p, []byte("."), 0o600)
		os.Chtimes(p, at, at)
	}
	mark(100, now.Add(time.Minute))
	mark(200, now.Add(-time.Minute))
	switch {
	case onOldLogin(now, 100):
		t.Error("started through the wrapper after the change")
	case !onOldLogin(now, 200):
		t.Error("started before the change")
	case !onOldLogin(now, 300):
		t.Error("started without the wrapper")
	case onOldLogin(now, 300, 100):
		t.Error("the pane's shell has a fresh mark")
	}
}

func TestWithManagedLine(t *testing.T) {
	line := localLoginLine
	cases := []struct{ in, want string }{
		{"", line + "\n"},
		{"export A=1\n", "export A=1\n" + line + "\n"},
		{"export A=1", "export A=1\n" + line + "\n"},
		{"export A=1\n" + line + "\n", "export A=1\n" + line + "\n"},
		{"x  # skybuild:claude-login v0\nexport A=1\n", "export A=1\n" + line + "\n"},
		{line + "\nexport A=1\n" + line + "\n", line + "\nexport A=1\n"},
	}
	for _, c := range cases {
		got, changed := withManagedLine(c.in, line, "skybuild:claude-login")
		if got != c.want || changed != (c.in != c.want) {
			t.Errorf("withManagedLine(%q) = %q, %v; want %q", c.in, got, changed, c.want)
		}
	}
}

func TestLocalReloginCandidate(t *testing.T) {
	s := Session{Machine: LocalMachine, Name: "shell-ab12", Claude: true, OldLogin: true, SID: "0f3a9c1e-1111-2222-3333-444455556666", State: "idle"}
	if got := ReloginCandidate(s); got != "idle" {
		t.Errorf("idle local session on the old login: %q", got)
	}
	s.State, s.Message = "waiting", "You've hit your weekly limit · resets Oct 12 at 9am"
	if got := ReloginCandidate(s); got != "limit" {
		t.Errorf("local session at a limit: %q", got)
	}
	s.OldLogin = false
	if got := ReloginCandidate(s); got != "" {
		t.Errorf("local session on the current login: %q", got)
	}
}

func TestLocalLoginPrefix(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SKYBUILD_HOME", filepath.Join(home, ".skybuild"))
	if got := localLoginPrefix(); got != ". ~/.skybuild/claude-login.sh && " {
		t.Errorf("prefix = %q", got)
	}
	t.Setenv("SKYBUILD_HOME", "/tmp/a b")
	if got := localLoginPrefix(); got != ". '/tmp/a b/claude-login.sh' && " {
		t.Errorf("prefix = %q", got)
	}
}

// In a tmux server of the test's own: a pane's shell loads the wrapper from ~/.zshenv, and
// the listing tells a Claude started through it from one started around it, and notices
// when the account changes under one.
func TestLocalSessionsOldLogin(t *testing.T) {
	if testing.Short() {
		t.Skip("starts a tmux server and waits on a restart")
	}
	zsh, err := exec.LookPath("zsh")
	if LocalTmux() == "" || err != nil {
		t.Skip("needs tmux and zsh")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SKYBUILD_HOME", filepath.Join(home, ".skybuild"))
	t.Setenv("SHELL", zsh)
	t.Setenv("ZDOTDIR", "") // restored after the test
	os.Unsetenv("ZDOTDIR")  // zsh reads $ZDOTDIR/.zshenv when it is set, even empty
	bin := t.TempDir()
	if err := os.Symlink("/bin/sleep", filepath.Join(bin, "claude")); err != nil {
		t.Fatal(err)
	}
	// Only the stand-in may be found: no Homebrew on the PATH, and shells that aren't login
	// shells (macOS's /etc/zprofile would put /opt/homebrew/bin, and a real claude, first).
	t.Setenv("PATH", bin+":/usr/bin:/bin")
	t.Setenv("SKY_TMUX_SOCKET", fmt.Sprintf("skytest-login-%d", os.Getpid()))
	ctx := context.Background()
	t.Cleanup(func() { _, _ = localSh(ctx, "tmux kill-server 2>/dev/null; true") })

	os.MkdirAll(localLoginMarks(), 0o700)
	os.WriteFile(localLoginScript(), []byte(localLoginScriptText()), 0o600)
	os.WriteFile(localTokenFile(), []byte("sk-ant-oat01-one\n"), 0o600)
	if err := ensureLocalLoginLine(); err != nil {
		t.Fatal(err)
	}
	e := New()
	dir := t.TempDir()
	if _, err := localSh(ctx, "tmux new-session -d -s first -c "+dir+" && tmux set -g default-command "+zsh+" && tmux new-session -d -s shell-in -c "+dir+" && tmux new-session -d -s shell-out -c "+dir); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Second) // the shells start
	localSh(ctx, `tmux send-keys -t "=shell-in:" 'whence -p claude >| `+dir+`/which' Enter`)
	time.Sleep(300 * time.Millisecond)
	if b, _ := os.ReadFile(filepath.Join(dir, "which")); strings.TrimSpace(string(b)) != filepath.Join(bin, "claude") {
		t.Fatalf("claude in the pane is %q, not the stand-in", b)
	}
	localSh(ctx, `tmux send-keys -t "=shell-in:" 'claude 300' Enter; tmux send-keys -t "=shell-out:" 'command claude 300' Enter`)
	// Claude's record of each running session, which names its conversation.
	sid := "0f3a9c1e-1111-2222-3333-444455556666"
	os.MkdirAll(filepath.Join(home, ".claude", "sessions"), 0o700)
	claudeIn := func(session string) int {
		for range 50 {
			pane := mustAtoi(t, strings.TrimSpace(must(localSh(ctx, `tmux display -p -t "=`+session+`:" '#{pane_pid}'`))))
			if kids := proc.List(ctx).Kids[pane]; len(kids) == 1 {
				return kids[0]
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Fatalf("no stand-in Claude in %s", session)
		return 0
	}
	for _, name := range []string{"shell-in", "shell-out"} {
		os.WriteFile(filepath.Join(home, ".claude", "sessions", strconv.Itoa(claudeIn(name))+".json"), []byte(`{"sessionId":"`+sid+`"}`), 0o600)
	}
	sessions := func() map[string]Session {
		by := map[string]Session{}
		for range 50 {
			list, _ := e.LocalSessions(ctx)
			for _, s := range list {
				by[s.Name] = s
			}
			if by["shell-in"].Claude && by["shell-out"].Claude {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		return by
	}
	by := sessions()
	if in := by["shell-in"]; !in.Claude || in.OldLogin || in.LoginAt.IsZero() {
		marks, _ := os.ReadDir(localLoginMarks())
		zenv, _ := os.ReadFile(filepath.Join(home, ".zshenv"))
		conf, _ := os.ReadFile(filepath.Join(paths.Root(), "tmux.local.conf"))
		scr, _ := localSh(ctx, `tmux show-environment -g SKY_CLAUDE_LOGIN; tmux display -p -t "=shell-in:" '#{pane_pid}'; tmux capture-pane -p -t "=shell-in:"`)
		t.Errorf("started through the wrapper: %+v\nmarks %v\nzshenv %q\nconf %q\n%s", in, marks, zenv, conf, scr)
	}
	if out := by["shell-out"]; !out.Claude || !out.OldLogin {
		t.Errorf("started around the wrapper: %+v", out)
	}
	time.Sleep(20 * time.Millisecond)
	os.WriteFile(localTokenFile(), []byte("sk-ant-oat01-two\n"), 0o600) // the account changes
	if in := sessions()["shell-in"]; !in.OldLogin {
		t.Errorf("after a switch: %+v", in)
	}

	// Moving the one started around the wrapper: its conversation is resumed through it, in
	// the same shell. (The stand-in Claude is sleep, so the resume itself just ends.)
	out := by["shell-out"]
	os.MkdirAll(filepath.Join(home, ".claude", "projects", "p"), 0o700)
	os.WriteFile(filepath.Join(home, ".claude", "projects", "p", sid+".jsonl"), []byte("{}\n"), 0o600)
	if err := e.restartClaude(ctx, LocalMachine, out.Name, sid, "", ""); err != nil {
		t.Fatal(err, must(localSh(ctx, `tmux display -p -t "=shell-out:" '#{pane_current_command}'; tmux capture-pane -p -t "=shell-out:" | grep .`)))
	}
	screen := must(localSh(ctx, `tmux capture-pane -p -t "=shell-out:"`))
	if !strings.Contains(strings.ReplaceAll(screen, "\n", ""), ". ~/.skybuild/claude-login.sh && claude --resume "+sid) { // the line wraps at 80 columns
		t.Errorf("typed into the shell:\n%s", screen)
	}
	if onOldLogin(localLoginAt(), mustAtoi(t, strings.TrimSpace(must(localSh(ctx, `tmux display -p -t "=shell-out:" '#{pane_pid}'`))))) {
		t.Error("the resumed Claude went around the wrapper")
	}
}

func must(s string, err error) string { return s }

func mustAtoi(t *testing.T, s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		t.Fatalf("%q: %v", s, err)
	}
	return n
}

// On a Mac without Claude Code, the first `claude` in a pane installs it (here a fake curl
// hands bash an installer that puts a fake Claude in ~/.local/bin, which isn't on PATH yet),
// then starts it with the pool's token.
func TestLocalLoginWrapperInstallsClaude(t *testing.T) {
	for _, sh := range []string{"zsh", "bash"} {
		path, err := exec.LookPath(sh)
		if err != nil {
			continue
		}
		root, home, bin := t.TempDir(), t.TempDir(), t.TempDir()
		t.Setenv("SKYBUILD_HOME", root)
		t.Setenv("HOME", home)
		installer := `mkdir -p "$HOME/.local/bin" && printf '#!/bin/sh\necho "installed token=${CLAUDE_CODE_OAUTH_TOKEN:-none} args=$*"\n' > "$HOME/.local/bin/claude" && chmod +x "$HOME/.local/bin/claude"`
		os.WriteFile(filepath.Join(bin, "curl"), []byte("#!/bin/sh\ncat <<'X'\n"+installer+"\nX\n"), 0o755)
		os.WriteFile(localLoginScript(), []byte(localLoginScriptText()), 0o600)
		os.MkdirAll(localLoginMarks(), 0o700)
		os.WriteFile(localTokenFile(), []byte("sk-ant-oat01-pool\n"), 0o600)
		run := func() string {
			t.Helper()
			cmd := exec.Command(path, "-c", localLoginLine+"\nclaude --resume abc")
			cmd.Env = []string{"HOME=" + home, "PATH=" + bin + ":/usr/bin:/bin", "SKY_CLAUDE_LOGIN=" + localLoginScript()}
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("%s: %v\n%s", sh, err, out)
			}
			return strings.TrimSpace(string(out))
		}
		if got := run(); got != "Installing Claude Code (Lungo does this once)...\ninstalled token=sk-ant-oat01-pool args=--resume abc" {
			t.Errorf("%s, first time: %q", sh, got)
		}
		if got := run(); got != "installed token=sk-ant-oat01-pool args=--resume abc" {
			t.Errorf("%s, once installed: %q", sh, got)
		}
	}
}

// Claude's first-run screens are skipped without touching the rest of ~/.claude.json.
func TestMarkClaudeOnboarded(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".claude.json")
	if err := markClaudeOnboarded(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); strings.TrimSpace(string(b)) != "{\n  \"hasCompletedOnboarding\": true\n}" {
		t.Errorf("new file: %s", b)
	}
	os.WriteFile(path, []byte(`{"numStartups": 12345678901234567890, "projects": {"/x": {"hasTrustDialogAccepted": true}}, "hasCompletedOnboarding": false}`), 0o600)
	if err := markClaudeOnboarded(); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	var got map[string]any
	if json.Unmarshal(b, &got) != nil || got["hasCompletedOnboarding"] != true || !strings.Contains(string(b), "12345678901234567890") || !strings.Contains(string(b), "hasTrustDialogAccepted") {
		t.Errorf("existing file: %s", b)
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", st.Mode())
	}
	before, _ := os.ReadFile(path)
	markClaudeOnboarded()
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Error("rewritten although already done")
	}
	os.WriteFile(path, []byte("{not json"), 0o600)
	markClaudeOnboarded()
	if b, _ := os.ReadFile(path); string(b) != "{not json" {
		t.Errorf("a file that isn't JSON was changed: %s", b)
	}
}
