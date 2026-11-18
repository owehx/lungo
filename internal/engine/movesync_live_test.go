package engine

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"skybuild/internal/events"
	"skybuild/internal/paths"
)

// TestMoveQuickLive moves a throwaway folder and a made-up conversation between this computer
// and a real machine, both ways, by rsync: copied ahead, then the move, the mirror back, the
// running-agents check. It runs only with SKY_LIVE_MOVE=<machine>, and cleans up after itself
// on both sides (~/.sky-movetest and its conversation folders).
func TestMoveQuickLive(t *testing.T) {
	machine := os.Getenv("SKY_LIVE_MOVE")
	if machine == "" {
		t.Skip("set SKY_LIVE_MOVE=<machine> to run")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	e := New()
	rec := &events.Recorder{}
	sh := func(m, s string) string {
		t.Helper()
		out, err := e.shOn(ctx, m, s)
		if err != nil {
			t.Fatalf("%s: %s: %v", m, s, err)
		}
		return strings.TrimSpace(out)
	}

	home := paths.Home()
	dir := filepath.Join(home, ".sky-movetest", "proj")
	remoteHome := sh(machine, `printf %s "$HOME"`)
	rdir := remoteHome + "/.sky-movetest/proj"
	cleanup := func() {
		os.RemoveAll(filepath.Join(home, ".sky-movetest"))
		os.RemoveAll(filepath.Join(home, ".claude", "projects", claudeProjectName(dir)))
		os.RemoveAll(filepath.Join(home, moveStage(dir)))
		os.RemoveAll(filepath.Join(home, moveStage(rdir)))
		e.shOn(context.Background(), machine, `rm -rf "$HOME/.sky-movetest" "$HOME/.claude/projects/`+claudeProjectName(rdir)+`" "$HOME/`+moveStage(dir)+`" "$HOME/`+moveStage(rdir)+`"`)
	}
	cleanup()
	t.Cleanup(cleanup)

	// The folder: files, a dependency folder that stays behind, a git repo.
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(dir, "sub"), 0o755))
	must(os.MkdirAll(filepath.Join(dir, "node_modules", "x"), 0o755))
	must(os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o644))
	must(os.WriteFile(filepath.Join(dir, "sub", "b.bin"), make([]byte, 3<<20), 0o644))
	must(os.WriteFile(filepath.Join(dir, "node_modules", "x", "i.js"), []byte("x"), 0o644))
	if out, err := exec.Command("git", "-C", dir, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %s", out)
	}
	// A conversation that ran in it.
	sid := "0d7e3c2a-1111-4222-8333-944455556666"
	conv := filepath.Join(home, ".claude", "projects", claudeProjectName(dir))
	must(os.MkdirAll(filepath.Join(conv, sid, "subagents"), 0o755))
	line := `{"cwd":"` + dir + `","message":"edit ` + dir + `/a.txt"}` + "\n"
	must(os.WriteFile(filepath.Join(conv, sid+".jsonl"), []byte(line), 0o600))

	// Copied ahead: the folder is there, the conversation waits in the stage.
	res, err := e.PrecopyMove(ctx, LocalMachine, machine, dir, rec)
	if err != nil {
		t.Fatalf("precopy: %v\n%v", err, rec.Events)
	}
	if res.ToDir != rdir {
		t.Fatalf("to %q, want %q", res.ToDir, rdir)
	}
	if got := sh(machine, `cat `+rdir+`/a.txt; [ -e `+rdir+`/node_modules ] && echo has-node-modules; [ -d `+rdir+`/.git ] && echo git; wc -c < `+rdir+`/sub/b.bin`); got != "one\ngit\n3145728" {
		t.Fatalf("after precopy there: %q", got)
	}
	if got := sh(machine, `ls "$HOME/`+moveStage(dir)+`"; ls "$HOME/.claude/projects/`+claudeProjectName(rdir)+`" 2>/dev/null | wc -l`); got != claudeProjectName(dir)+"\n0" {
		t.Fatalf("stage after precopy: %q", got)
	}
	var progress bool
	for _, ev := range rec.Events {
		if ev.Level == events.Log && strings.Contains(ev.Message, " of ") && strings.HasSuffix(ev.Message, "%") {
			progress = true
		}
	}
	if !progress {
		t.Errorf("no progress lines: %v", rec.Events)
	}

	// The conversations are rewritten ahead, beside the stage, and not yet in place.
	if got := sh(machine, `grep -c `+rdir+` "$HOME/`+moveStage(dir)+`.landed/`+claudeProjectName(rdir)+`/`+sid+`.jsonl"`); got != "1" {
		t.Fatalf("landed ahead: %q", got)
	}

	// Work goes on here and is copied again; then more, which the move sends by name.
	appendConv := func(msg string) {
		f, _ := os.OpenFile(filepath.Join(conv, sid+".jsonl"), os.O_APPEND|os.O_WRONLY, 0)
		f.WriteString(`{"cwd":"` + dir + `","message":"` + msg + `"}` + "\n")
		f.Close()
	}
	appendConv("again")
	if _, err := e.PrecopyMove(ctx, LocalMachine, machine, dir, rec); err != nil {
		t.Fatalf("precopy again: %v", err)
	}
	must(os.WriteFile(filepath.Join(dir, "a.txt"), []byte("two\n"), 0o644))
	must(os.MkdirAll(filepath.Join(dir, "new", "deep"), 0o755))
	must(os.WriteFile(filepath.Join(dir, "new", "deep", "n.txt"), []byte("n\n"), 0o644))
	must(os.WriteFile(filepath.Join(dir, "node_modules", "x", "late.js"), []byte("x"), 0o644))
	appendConv("later")
	plan, _ := e.PlanMove(ctx, LocalMachine, machine, dir)
	if files, ok := e.changedSince(ctx, plan, `"$HOME"/`+sentStamp(machine, dir)); !ok || len(files) != 2 {
		t.Fatalf("changed since the copy: %v %v", files, ok)
	}
	started := time.Now()
	res, err = e.MoveSession(ctx, LocalMachine, "", machine, dir, rec)
	if err != nil {
		t.Fatalf("move: %v", err)
	}
	t.Logf("move after precopy took %s, %d bytes over the wire", time.Since(started).Round(time.Millisecond), res.Bytes)
	if res.Bytes > 1<<20 {
		t.Errorf("the move sent %d bytes: should be only what changed", res.Bytes)
	}
	if res.Latest != sid {
		t.Errorf("latest %q, want %q", res.Latest, sid)
	}
	landed := sh(machine, `cat "$HOME/.claude/projects/`+claudeProjectName(rdir)+`/`+sid+`.jsonl"; cat `+rdir+`/a.txt `+rdir+`/new/deep/n.txt; [ -e `+rdir+`/node_modules/x/late.js ] && echo deps-went; [ -e "$HOME/`+moveStage(dir)+`" ] && echo stage-left; [ -e "$HOME/`+moveStage(dir)+`.landed" ] && echo landed-left; true`)
	if strings.Contains(landed, `"`+dir) || !strings.Contains(landed, rdir+`/a.txt`) || !strings.Contains(landed, "again") || !strings.Contains(landed, "later") || !strings.HasSuffix(landed, "two\nn") {
		t.Fatalf("landed there: %q", landed)
	}
	if _, err := os.Stat(filepath.Join(home, sentStamp(machine, dir))); err == nil {
		t.Errorf("the copy-ahead mark is left after the move")
	}

	// The mirror: what changes there comes here; what is newer here stays.
	time.Sleep(1100 * time.Millisecond)
	must(os.WriteFile(filepath.Join(dir, "mine.txt"), []byte("here\n"), 0o644))
	sh(machine, `echo three > `+rdir+`/a.txt; echo new > `+rdir+`/c.txt; echo theirs > `+rdir+`/mine.txt; touch -d '2001-01-01' `+rdir+`/mine.txt`)
	n, err := e.MirrorPull(ctx, machine, rdir, dir)
	if err != nil {
		t.Fatalf("mirror: %v", err)
	}
	a, _ := os.ReadFile(filepath.Join(dir, "a.txt"))
	c, _ := os.ReadFile(filepath.Join(dir, "c.txt"))
	m, _ := os.ReadFile(filepath.Join(dir, "mine.txt"))
	if string(a) != "three\n" || string(c) != "new\n" || string(m) != "here\n" || n < 2 {
		t.Fatalf("mirror: a=%q c=%q mine=%q files=%d", a, c, m, n)
	}

	// Followed: nothing changed, nothing pulled; a change there comes here.
	mir := Mirror{Machine: machine, Remote: rdir, Local: dir}
	if _, err := e.FollowMirror(ctx, mir); err != nil { // no stamp yet: a pull, which sets it
		t.Fatalf("follow: %v", err)
	}
	if ch, err := e.MirrorChanged(ctx, mir); err != nil || ch {
		t.Fatalf("changed right after a pull: %v %v", ch, err)
	}
	sh(machine, `sleep 1; echo five > `+rdir+`/sub/d.txt; mkdir -p `+rdir+`/node_modules/y; echo z > `+rdir+`/node_modules/y/z.js`)
	if n, err := e.FollowMirror(ctx, mir); err != nil || n != 1 {
		t.Fatalf("follow after a change: %d %v", n, err)
	}
	if d, _ := os.ReadFile(filepath.Join(dir, "sub", "d.txt")); string(d) != "five\n" {
		t.Fatalf("followed: %q", d)
	}
	sh(machine, `rm -f "$HOME/.cache/sky-move/mirror`+claudeProjectName(rdir)+`.stamp"`)

	// Agents at work there: a record not marked finished, written lately.
	sh(machine, `d="$HOME/.claude/projects/`+claudeProjectName(rdir)+`/`+sid+`/subagents"; mkdir -p "$d"; echo '{"description":"Mapping faults"}' > "$d/agent-a1.meta.json"; echo '{}' > "$d/agent-a1.jsonl"; echo '{"description":"Done one","finished":true}' > "$d/agent-a2.meta.json"; echo '{}' > "$d/agent-a2.jsonl"`)
	names, err := e.RunningAgents(ctx, machine, sid)
	if err != nil || len(names) != 1 || names[0] != "Mapping faults" {
		t.Fatalf("running agents: %v %v", names, err)
	}

	// And back: from the machine to here (a pull, the conversations by filter).
	sh(machine, `echo four > `+rdir+`/a.txt`)
	res, err = e.MoveSession(ctx, machine, "", LocalMachine, rdir, rec)
	if err != nil {
		t.Fatalf("move back: %v", err)
	}
	a, _ = os.ReadFile(filepath.Join(dir, "a.txt"))
	back, _ := os.ReadFile(filepath.Join(conv, sid+".jsonl"))
	if string(a) != "four\n" || strings.Contains(string(back), rdir) || !strings.Contains(string(back), dir+"/a.txt") || res.Latest != sid {
		t.Fatalf("back here: a=%q conv=%q latest=%q", a, back, res.Latest)
	}
	if _, err := os.Stat(filepath.Join(home, moveStage(rdir))); err == nil {
		t.Errorf("stage left here")
	}
}
