package engine

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"skybuild/internal/proc"
)

// Runs against a tmux server of the test's own; skipped where tmux isn't installed.
func TestLocalSessions(t *testing.T) {
	if LocalTmux() == "" {
		t.Skip("tmux is not installed")
	}
	t.Setenv("SKYBUILD_HOME", t.TempDir())
	t.Setenv("SKY_TMUX_SOCKET", fmt.Sprintf("skytest-%d", os.Getpid()))
	ctx := context.Background()
	t.Cleanup(func() { _, _ = localSh(ctx, "tmux kill-server 2>/dev/null; true") })
	e := New()

	if list, err := e.LocalSessions(ctx); err != nil || len(list) != 0 {
		t.Fatalf("no server yet: %v %v", list, err)
	}
	dir := t.TempDir()
	if _, err := localSh(ctx, "tmux new-session -d -s shell-ab12 -c "+dir+" && tmux new-session -d -s shell-cd34 -c "+dir+" && tmux new-session -d -s work -c "+dir); err != nil {
		t.Fatal(err)
	}
	list, err := e.LocalSessions(ctx)
	if err != nil || len(list) != 3 {
		t.Fatalf("sessions: %v %v", list, err)
	}
	for _, s := range list {
		if s.Machine != LocalMachine || s.Claude || s.State != "" {
			t.Errorf("a plain shell session: %+v", s)
		}
		if !strings.HasSuffix(s.Path, strings.TrimPrefix(dir, "/private")) && !strings.HasSuffix(dir, strings.TrimPrefix(s.Path, "/private")) {
			t.Errorf("folder: %q, want %q", s.Path, dir)
		}
	}
	// The status line is off and sky's settings are in force on this server.
	if out, _ := localSh(ctx, "tmux show -gv status; tmux show -gv mouse"); strings.Fields(out)[0] != "off" || strings.Fields(out)[1] != "on" {
		t.Errorf("settings: %q", out)
	}

	// Reaping leaves sessions that panes still point at, young ones, and named sessions.
	e.ReapShells(ctx, map[string][]string{LocalMachine: {"shell-ab12"}})
	if list, _ = e.LocalSessions(ctx); len(list) != 3 {
		t.Fatalf("young shells must stay: %v", names(list))
	}
	// Closing a shell pane ends its idle shell; a session that isn't a shell pane stays.
	if err := e.CloseShell(ctx, LocalMachine, "shell-cd34"); err != nil {
		t.Fatal(err)
	}
	if err := e.CloseShell(ctx, LocalMachine, "work"); err != nil {
		t.Fatal(err)
	}
	if list, _ = e.LocalSessions(ctx); strings.Join(names(list), ",") != "shell-ab12,work" && strings.Join(names(list), ",") != "work,shell-ab12" {
		t.Fatalf("after closing a shell: %v", names(list))
	}
	if err := e.KillSession(ctx, LocalMachine, "work"); err != nil {
		t.Fatal(err)
	}
	if list, _ = e.LocalSessions(ctx); len(list) != 1 || list[0].Name != "shell-ab12" {
		t.Fatalf("after kill: %v", names(list))
	}

	// The attach command creates a missing session in the folder asked for.
	args, err := e.LocalAttachArgs("shell-new1", AttachOptions{Dir: dir})
	if err != nil || args[0] != "/bin/sh" || !strings.Contains(args[2], "-L 'skytest-") {
		t.Fatalf("attach args: %v %v", args, err)
	}
	// Without a terminal the attach itself fails, but the session is made first.
	_, _ = localSh(ctx, strings.SplitN(args[2], "}; ", 2)[1]+" 2>/dev/null; true")
	deadline := time.Now().Add(3 * time.Second)
	for {
		list, _ = e.LocalSessions(ctx)
		if len(list) == 2 || time.Now().After(deadline) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if len(list) != 2 {
		t.Fatalf("attach should have created the session: %v", names(list))
	}

	// A named session that was seen after this tmux server started and is missing now was
	// ended on purpose: the attach command says so and makes nothing. One never seen, or
	// seen before the server started (it restarted since), is made.
	run := func(o AttachOptions) string {
		args, err := e.LocalAttachArgs("work", o)
		if err != nil {
			t.Fatal(err)
		}
		out, _ := localSh(ctx, strings.SplitN(args[2], "}; ", 2)[1]+" 2>/dev/null; true")
		return out
	}
	if out := run(AttachOptions{Dir: dir, Seen: time.Now().Unix() + 300}); !strings.Contains(out, "[gone]") {
		t.Errorf("ended on purpose: %q", out)
	}
	if list, _ = e.LocalSessions(ctx); len(list) != 2 {
		t.Fatalf("a session ended on purpose must not come back: %v", names(list))
	}
	if out := run(AttachOptions{Dir: dir, Seen: time.Now().Unix() - 3600}); strings.Contains(out, "[gone]") {
		t.Errorf("lost to a restart: %q", out)
	}
	if list, _ = e.LocalSessions(ctx); len(list) != 3 {
		t.Fatalf("a session lost to a restart comes back: %v", names(list))
	}

	// A session whose folder is gone comes back as a shell in the home folder with a line
	// saying so: Claude is not started there to continue whatever was last in that folder.
	args, err = e.LocalAttachArgs("claude-lost", AttachOptions{Dir: filepath.Join(dir, "no-such-folder"), Resume: "continue"})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = localSh(ctx, strings.SplitN(args[2], "}; ", 2)[1]+" 2>/dev/null; true")
	var screen string
	for deadline := time.Now().Add(4 * time.Second); time.Now().Before(deadline); time.Sleep(150 * time.Millisecond) {
		screen, _ = localSh(ctx, `tmux capture-pane -p -t '=claude-lost:'`)
		if strings.Contains(screen, "is not there any more") {
			break
		}
	}
	if !strings.Contains(screen, "no-such-folder is not there any more") || strings.Contains(screen, "claude --continue") {
		t.Errorf("a session whose folder is gone:\n%s", screen)
	}
}

func names(list []Session) []string {
	out := make([]string, len(list))
	for i, s := range list {
		out[i] = s.Name
	}
	return out
}

func TestClaudeUnder(t *testing.T) {
	p := procTable{proc.Known(
		map[int]string{
			10: "-zsh",
			11: "/Users/x/.local/share/claude/versions/2.1.92 --resume abc",
			20: "-zsh",
			21: "node /opt/thing/server.js",
			30: "/bin/zsh -l",
			31: "bash -c claude",
			32: "claude --continue",
		},
		map[int][]int{10: {11}, 20: {21}, 30: {31}, 31: {32}},
	)}
	for shell, want := range map[int]int{10: 11, 20: 0, 30: 32, 0: 0, 99: 0} {
		if got := p.claudeUnder(shell); got != want {
			t.Errorf("claudeUnder(%d) = %d, want %d", shell, got, want)
		}
	}
}

// Sessions as a machine reports them: Claude by name on Linux, by its version-named binary
// on macOS, with what the hook recorded and how it was started.
func TestParseSessionsClaude(t *testing.T) {
	out := strings.Join([]string{
		"shell-54ac\t1791080000\t1791080100\t1\t1\t/Users/t/code\t2.1.289\tmini\t✳ Pull from main",
		"claude-api\t1791080000\t1791080100\t0\t1\t/home/t/api\tclaude\tdemo\tdemo",
		"claude-old\t1791080000\t1791080100\t0\t1\t/home/t\tzsh\tdemo\tdemo",
		"shell-ab12\t1791080000\t1791080100\t0\t1\t/home/t\tzsh\tdemo\tdemo",
		"@@sky-git@@",
		"/home/t/api\tfeature/login",
		"@@sky-status@@",
		`{"session":"shell-54ac","state":"idle","at":1791080090,"message":"","sid":"0b9d7c1e-5a42-4c8e-9a51-2f6f0c7d1e11"}`,
		`{"session":"claude-old","state":"idle","at":1791080090,"message":"","sid":"1b9d7c1e-5a42-4c8e-9a51-2f6f0c7d1e11"}`,
		"@@sky-pane@@shell-54ac\t/Users/t/.local/share/claude/versions/2.1.289 --dangerously-skip-permissions",
		"❯ ",
		"@@sky-pane@@claude-api\tclaude",
		"  esc to interrupt",
	}, "\n")
	by := map[string]Session{}
	for _, s := range parseSessions("m", out) {
		by[s.Name] = s
	}
	if s := by["shell-54ac"]; !s.Claude || s.Command != "claude" || s.State != "idle" || s.Title != "Pull from main" || s.SID == "" || s.Flags != "--dangerously-skip-permissions" {
		t.Errorf("Claude on macOS (version-named process): %+v", s)
	}
	if s := by["claude-api"]; s.Branch != "feature/login" || by["claude-old"].Branch != "" {
		t.Errorf("branch of the session's folder: %+v", s)
	}
	if s := by["claude-api"]; !s.Claude || s.State != "working" || s.Flags != "" {
		t.Errorf("Claude on Linux: %+v", s)
	}
	if s := by["claude-old"]; !s.Claude || s.State != "" || s.Command != "zsh" {
		t.Errorf("a session Claude has left: %+v", s)
	}
	if s := by["shell-ab12"]; s.Claude || s.Command != "zsh" {
		t.Errorf("a plain shell: %+v", s)
	}
}

// A machine's login changed after a Claude started: that session is still on the old login.
func TestOldLogin(t *testing.T) {
	out := strings.Join([]string{
		"@@sky-login@@ 1791100000 1791099700",
		"claude-a\t1791090000\t1791099990\t0\t1\t/home/t\tclaude\tdemo\tWork",
		"claude-b\t1791090000\t1791099990\t0\t1\t/home/t\tclaude\tdemo\tMore",
		"shell-c\t1791090000\t1791099990\t0\t1\t/home/t\tzsh\tdemo\tdemo",
		"@@sky-status@@",
		`{"session":"claude-a","state":"idle","at":1791099900,"message":"","sid":"0b9d7c1e-5a42-4c8e-9a51-2f6f0c7d1e11"}`,
		`{"session":"claude-b","state":"waiting","at":1791099900,"message":"5-hour limit reached ∙ resets 5am","sid":"1b9d7c1e-5a42-4c8e-9a51-2f6f0c7d1e11"}`,
		"@@sky-pane@@claude-a\t  555   100 1-02:03:04 claude --dangerously-skip-permissions\t ",
		"❯ ",
		"@@sky-pane@@claude-b\t  556   200 04:00 claude\t ",
		"  You've hit your limit · resets 5am",
		"  ❯ 1. Stop and wait for limit to reset",
		"  Enter to confirm · Esc to cancel",
	}, "\n")
	// claude-b's hook says it is waiting on a limit; its record says idle, but the limit prompt
	// on screen still wins.
	out += "\n@@sky-pane@@claude-old\t  557   300 3-00:00:00 /home/t/.local/share/claude/versions/2.1.9\t2b9d7c1e-5a42-4c8e-9a51-2f6f0c7d1e11 idle\n❯ "
	out = strings.Replace(out, "@@sky-status@@", "claude-old\t1791090000\t1791099990\t0\t1\t/home/t\t2.1.9\tdemo\tdemo\n@@sky-status@@", 1)
	by := map[string]Session{}
	for _, s := range parseSessions("demo", out) {
		by[s.Name] = s
	}
	if o := by["claude-old"]; o.SID != "2b9d7c1e-5a42-4c8e-9a51-2f6f0c7d1e11" || o.State != "idle" || !o.OldLogin || ReloginCandidate(o) != "idle" {
		t.Errorf("a Claude the hooks never saw: %+v", o)
	}
	a, b := by["claude-a"], by["claude-b"]
	if !a.OldLogin || a.ClaudeSince.Unix() != 1791100000-(86400+2*3600+3*60+4) || a.LoginAt.Unix() != 1791099700 {
		t.Errorf("started a day before the switch: %+v", a)
	}
	if b.OldLogin || b.ClaudeSince.Unix() != 1791100000-240 {
		t.Errorf("started after the switch: %+v", b)
	}
	if by["shell-c"].OldLogin {
		t.Errorf("a shell has no login")
	}
	if got := ReloginCandidate(a); got != "idle" {
		t.Errorf("an idle session on the old login: %q", got)
	}
	b.OldLogin = true
	if got := ReloginCandidate(b); got != "limit" {
		t.Errorf("stuck on the old login's limit: %q (state %q, message %q)", got, b.State, b.Message)
	}
	for name, s := range map[string]Session{
		"working":         {Machine: "demo", Claude: true, OldLogin: true, State: "working", SID: a.SID},
		"asking":          {Machine: "demo", Claude: true, OldLogin: true, State: "waiting", Message: "Claude needs your permission to use Bash", SID: a.SID},
		"no conversation": {Machine: "demo", Claude: true, OldLogin: true, State: "idle"},
		"current login":   {Machine: "demo", Claude: true, State: "idle", SID: a.SID},
	} {
		if got := ReloginCandidate(s); got != "" {
			t.Errorf("%s: must be left alone, got %q", name, got)
		}
	}
	for in, want := range map[string]int64{"00:19": 19, "1:02:03": 3723, "3-00:00:01": 259201, "x": -1, "1:2:3:4": -1} {
		got, ok := parseEtime(in)
		if (want < 0 && ok) || (want >= 0 && (!ok || got != want)) {
			t.Errorf("parseEtime(%q) = %d %v", in, got, ok)
		}
	}
}

// The hooks' word is stale when a turn ended without them; Claude's record and the screen win.
func TestStateFromRecord(t *testing.T) {
	out := strings.Join([]string{
		"@@sky-login@@ 1791100000 1791099900",
		"stale\t1791090000\t1791099990\t0\t1\t/home/t\tclaude\tdemo\tWork",
		"nudge\t1791090000\t1791099990\t0\t1\t/home/t\tclaude\tdemo\tMore",
		"busy\t1791090000\t1791099990\t0\t1\t/home/t\tclaude\tdemo\tBusy",
		"asks\t1791090000\t1791099990\t0\t1\t/home/t\tclaude\tdemo\tAsks",
		"@@sky-status@@",
		`{"session":"stale","state":"working","at":1791099000,"message":"","sid":"0b9d7c1e-5a42-4c8e-9a51-2f6f0c7d1e11"}`,
		`{"session":"nudge","state":"waiting","at":1791099000,"message":"Claude is waiting for your input","sid":"1b9d7c1e-5a42-4c8e-9a51-2f6f0c7d1e11"}`,
		`{"session":"busy","state":"idle","at":1791099000,"message":"","sid":"2b9d7c1e-5a42-4c8e-9a51-2f6f0c7d1e11"}`,
		`{"session":"asks","state":"working","at":1791099000,"message":"","sid":"3b9d7c1e-5a42-4c8e-9a51-2f6f0c7d1e11"}`,
		"@@sky-pane@@stale\t 1 2 10:00 claude\t0b9d7c1e-5a42-4c8e-9a51-2f6f0c7d1e11 idle",
		"❯ ",
		"@@sky-pane@@nudge\t 3 4 10:00 claude\t ",
		"❯ ",
		"@@sky-pane@@busy\t 5 6 10:00 claude\t2b9d7c1e-5a42-4c8e-9a51-2f6f0c7d1e11 busy",
		"  esc to interrupt",
		"@@sky-pane@@asks\t 7 8 10:00 claude\t3b9d7c1e-5a42-4c8e-9a51-2f6f0c7d1e11 busy",
		" Do you want to proceed?",
		" ❯ 1. Yes",
		"   2. No",
	}, "\n")
	by := map[string]Session{}
	for _, s := range parseSessions("demo", out) {
		by[s.Name] = s
	}
	for name, want := range map[string]string{"stale": "idle", "nudge": "idle", "busy": "working", "asks": "waiting"} {
		if got := by[name].State; got != want {
			t.Errorf("%s: state %q, want %q (message %q)", name, got, want, by[name].Message)
		}
	}
	if ReloginCandidate(by["stale"]) != "idle" || ReloginCandidate(by["busy"]) != "" || ReloginCandidate(by["asks"]) != "" {
		t.Errorf("only the idle one moves")
	}
}

// The flags field after the title: whether the program wants the mouse, uses the whole screen,
// and whether tmux knows sky's key for leaving scrollback. A title with a tab in it survives.
func TestSessionInputFlags(t *testing.T) {
	out := strings.Join([]string{
		"claude-a\t1791080000\t1791080100\t0\t1\t/home/t\tclaude\tdemo\tFix login\tmak",
		"shell-b\t1791080000\t1791080100\t0\t1\t/home/t\tzsh\tdemo\tdemo\tk",
		"shell-c\t1791080000\t1791080100\t0\t1\t/home/t\tzsh\tdemo\ta\tb\t",
		"shell-d\t1791080000\t1791080100\t0\t1\t/home/t\tzsh\tdemo\tdemo",
	}, "\n")
	by := map[string]Session{}
	for _, s := range parseSessions("m", out) {
		by[s.Name] = s
	}
	if s := by["claude-a"]; !s.Mouse || !s.Alt || !s.ScrollKey || s.Title != "Fix login" {
		t.Errorf("all flags: %+v", s)
	}
	if s := by["shell-b"]; s.Mouse || s.Alt || !s.ScrollKey || s.Title != "" {
		t.Errorf("scroll key only: %+v", s)
	}
	if s := by["shell-c"]; s.Mouse || s.ScrollKey || s.Title != "a\tb" {
		t.Errorf("tab in the title: %+v", s)
	}
	if s := by["shell-d"]; s.Mouse || s.ScrollKey {
		t.Errorf("no flags field: %+v", s)
	}
}

// What a machine says about its files (mtime, size, type, path; GNU or BSD stat) becomes the
// list the app shows. A path with tabs or spaces survives; a line that isn't one is skipped.
func TestParseRemoteFiles(t *testing.T) {
	out := strings.Join([]string{
		"1791080000\t33076250\tRegular File\t/Users/t/Desktop/Creed promo.mp4",
		"1791080100\t4096\tdirectory\t/home/t/out",
		"1791080200\t12\tregular file\t/home/t/a\tb.txt",
		"garbage",
		"1791080000\t33076250\tRegular File\t/Users/t/Desktop/Creed promo.mp4",
	}, "\n")
	got := parseRemoteFiles(out)
	if len(got) != 3 {
		t.Fatalf("got %d files: %+v", len(got), got)
	}
	if f := got[0]; f.Name != "Creed promo.mp4" || f.Size != 33076250 || f.Dir || f.Mod.Unix() != 1791080000 {
		t.Errorf("file: %+v", f)
	}
	if !got[1].Dir || got[1].Name != "out" {
		t.Errorf("folder: %+v", got[1])
	}
	if got[2].Path != "/home/t/a\tb.txt" {
		t.Errorf("tab in a name: %+v", got[2])
	}
}

// The command lines the system hands over match what ps shows (macOS reads them directly).
func TestProcessTableReadsThisProcess(t *testing.T) {
	p := processTable(context.Background())
	me, parent := os.Getpid(), os.Getppid()
	found := false
	for _, k := range p.Kids[parent] {
		found = found || k == me
	}
	if !found {
		t.Fatalf("this process (%d) isn't listed under its parent (%d)", me, parent)
	}
	if a := p.args(me); !strings.Contains(a, filepath.Base(os.Args[0])) {
		t.Fatalf("args(%d) = %q, want this test binary", me, a)
	}
}

// The app's own tmux is found next to its program, through the link a moved app leaves, and
// only when it can run.
func TestBundledTmuxFor(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS app bundles only")
	}
	app := filepath.Join(t.TempDir(), "Lungo.app", "Contents")
	exe := filepath.Join(app, "MacOS", "Lungo")
	os.MkdirAll(filepath.Dir(exe), 0o755)
	os.WriteFile(exe, nil, 0o755)
	if got := bundledTmuxFor(exe); got != "" {
		t.Fatalf("no Helpers/tmux: %q", got)
	}
	tm := filepath.Join(app, "Helpers", "tmux")
	os.MkdirAll(filepath.Dir(tm), 0o755)
	os.WriteFile(tm, []byte("#!/bin/sh\n"), 0o644)
	if got := bundledTmuxFor(exe); got != "" {
		t.Fatalf("not executable: %q", got)
	}
	os.Chmod(tm, 0o755)
	if got, _ := filepath.EvalSymlinks(bundledTmuxFor(exe)); got != mustReal(t, tm) {
		t.Fatalf("got %q, want %q", got, tm)
	}
	link := filepath.Join(t.TempDir(), "Lungo")
	os.Symlink(exe, link)
	if got, _ := filepath.EvalSymlinks(bundledTmuxFor(link)); got != mustReal(t, tm) {
		t.Fatalf("through a link: %q", got)
	}
}

func mustReal(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// The bundled tmux runs from a copy: made once, left alone while it is the same, and swapped
// by a rename when the app brings another, so a server running the old one keeps its program.
func TestCopyProgram(t *testing.T) {
	src, dst := filepath.Join(t.TempDir(), "tmux"), filepath.Join(t.TempDir(), "bin", "tmux")
	os.WriteFile(src, []byte("one"), 0o755)
	if err := copyProgram(src, dst); err != nil {
		t.Fatal(err)
	}
	st1, err := os.Stat(dst)
	if err != nil || st1.Mode().Perm() != 0o755 {
		t.Fatalf("copy: %v %v", st1, err)
	}
	copyProgram(src, dst)
	if st2, _ := os.Stat(dst); !os.SameFile(st1, st2) {
		t.Error("an identical copy was replaced")
	}
	running, _ := os.Open(dst) // as a running server holds it
	defer running.Close()
	os.WriteFile(src, []byte("two"), 0o755)
	if err := copyProgram(src, dst); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "two" {
		t.Errorf("not updated: %q", b)
	}
	if b := make([]byte, 3); func() bool { n, _ := running.ReadAt(b, 0); return n != 3 || string(b) != "one" }() {
		t.Errorf("the running copy changed under it: %q", b)
	}
}
