package engine

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"skybuild/internal/events"
	"skybuild/internal/osx"
	"skybuild/internal/paths"
	"skybuild/internal/sshx"
)

// Sending a folder to another device, as it is.
//
// Everything in it goes, git history and work not committed yet included, and so do the
// Claude Code conversations that ran in it, so `claude --resume` picks them up there. Any
// two devices: this computer and the machines, or one machine to another (the stream goes
// through this computer). Where home folders differ, the folder lands at the same place
// under the other home, and the conversations are told where it is now.
//
// What is left out is what each device builds for itself: dependency folders and caches
// (node_modules and Python environments hold programs built for one system).

// MoveSkip are the folder names left out of a send.
var MoveSkip = []string{"node_modules", ".venv", "venv", "__pycache__", ".next", ".turbo", ".parcel-cache", ".pytest_cache", ".mypy_cache", ".ruff_cache", "DerivedData", ".DS_Store"}

// MovePlan is what a send would do, for the page to show before it starts.
type MovePlan struct {
	From          string   `json:"from"`
	To            string   `json:"to"`
	FromDir       string   `json:"fromDir"` // absolute, on the device it comes from
	ToDir         string   `json:"toDir"`   // absolute, on the device it goes to
	Name          string   `json:"name"`
	Exists        bool     `json:"exists"`        // something is at ToDir already
	Conversations int      `json:"conversations"` // Claude conversations that go with it
	Git           bool     `json:"git"`
	Skip          []string `json:"skip"`
}

// MoveResult is what a send did.
type MoveResult struct {
	MovePlan
	Bytes  int64  `json:"bytes"`
	Latest string `json:"latest"` // the most recent conversation, to resume there
}

// claudeProjectName is the folder Claude Code keeps a working folder's conversations in:
// its path with everything but letters and digits made "-".
func claudeProjectName(dir string) string {
	return nonAlnum.ReplaceAllString(dir, "-")
}

var nonAlnum = regexp.MustCompile(`[^A-Za-z0-9]`)

// cmdOn is a command that runs script on a device, with its input and output for the caller
// to connect: a stream of files, so on a connection of its own (sshx.BulkOptions).
func (e *Engine) cmdOn(ctx context.Context, machine, script string) (*exec.Cmd, error) {
	if IsLocal(machine) {
		c := exec.CommandContext(ctx, "/bin/sh", "-c", script)
		c.Dir = paths.Home()
		c.Env = append(os.Environ(), "COPYFILE_DISABLE=1")
		c.WaitDelay = 3 * time.Second
		return c, nil
	}
	m, err := e.Machine(machine)
	if err != nil {
		return nil, err
	}
	if err := e.Ready(m); err != nil {
		return nil, err
	}
	t := e.Target(m)
	args := append(t.BulkOptions(), t.Dest(), "--", sshx.RemotePath+"export COPYFILE_DISABLE=1; "+script)
	c := exec.CommandContext(ctx, osx.Which("ssh"), args...)
	c.WaitDelay = 3 * time.Second
	return c, nil
}

// homeAndPath resolves dir on a device ("~/x" or absolute) to an absolute path, with the
// device's home folder.
func (e *Engine) homeAndPath(ctx context.Context, machine, dir string) (home, abs string, err error) {
	script := `printf '%s\n' "$HOME"; d=` + sshx.Quote(dir) + `; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/${d#\~/}";; esac; if [ -d "$d" ]; then (cd "$d" && pwd -P); else echo; fi`
	out, err := e.shOn(ctx, machine, script)
	if err != nil {
		return "", "", err
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) < 1 || lines[0] == "" {
		return "", "", fmt.Errorf("%s didn't say where its home folder is", machineLabel(machine))
	}
	home = lines[0]
	if len(lines) > 1 {
		abs = strings.TrimSpace(lines[1])
	}
	return home, abs, nil
}

func machineLabel(m string) string {
	if IsLocal(m) {
		return "this computer"
	}
	return m
}

// conversationDirs lists, on a device, the folders of Claude conversations that ran in dir or
// under it (by the working folder each conversation recorded, not by name alone: names are
// lossy). Counted with them: how many conversations there are.
func (e *Engine) conversationDirs(ctx context.Context, machine, abs string) ([]string, int, error) {
	script := `cd "$HOME/.claude/projects" 2>/dev/null || exit 0
a=` + sshx.Quote(abs) + `
for d in ` + sshx.Quote(claudeProjectName(abs)) + `*; do
  [ -d "$d" ] || continue
  f=$(ls -t ./"$d"/*.jsonl 2>/dev/null | head -1)
  [ -n "$f" ] || continue
  c=$(grep -m1 -o '"cwd":"[^"]*"' "$f" 2>/dev/null | head -1 | sed 's/^"cwd":"//; s/"$//')
  case "$c" in "$a"|"$a"/*) printf '%s\t%s\n' "$d" "$(ls ./"$d"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')";; esac
done`
	out, err := e.shOn(ctx, machine, script)
	if err != nil {
		return nil, 0, err
	}
	var dirs []string
	n := 0
	for _, line := range strings.Split(out, "\n") {
		name, count, ok := strings.Cut(strings.TrimSpace(line), "\t")
		if !ok || name == "" || strings.ContainsAny(name, "/\x00") {
			continue
		}
		dirs = append(dirs, name)
		c, _ := strconv.Atoi(count)
		n += c
	}
	return dirs, n, nil
}

// PlanMove says what sending dir from one device to another would do.
func (e *Engine) PlanMove(ctx context.Context, from, to, dir string) (MovePlan, error) {
	if from == to {
		return MovePlan{}, errors.New("it is already there")
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var (
		fromHome, fromAbs, toHome string
		errFrom, errTo            error
		wg                        sync.WaitGroup
	)
	wg.Add(2)
	go func() { defer wg.Done(); fromHome, fromAbs, errFrom = e.homeAndPath(ctx, from, dir) }()
	go func() { defer wg.Done(); toHome, _, errTo = e.homeAndPath(ctx, to, "~") }()
	wg.Wait()
	if errFrom != nil {
		return MovePlan{}, errFrom
	}
	if errTo != nil {
		return MovePlan{}, errTo
	}
	if fromAbs == "" {
		return MovePlan{}, fmt.Errorf("there is no folder %s on %s", dir, machineLabel(from))
	}
	if fromAbs == fromHome || fromAbs == "/" {
		return MovePlan{}, errors.New("that is a whole home folder; send a project folder inside it")
	}
	toAbs := fromAbs
	if rest, ok := strings.CutPrefix(fromAbs, fromHome+"/"); ok {
		toAbs = toHome + "/" + rest
	}
	p := MovePlan{From: from, To: to, FromDir: fromAbs, ToDir: toAbs, Name: path.Base(fromAbs), Skip: MoveSkip}
	out, err := e.shOn(ctx, to, `[ -e `+sshx.Quote(toAbs)+` ] && echo exists; true`)
	if err != nil {
		return MovePlan{}, err
	}
	p.Exists = strings.Contains(out, "exists")
	out, _ = e.shOn(ctx, from, `[ -e `+sshx.Quote(fromAbs+"/.git")+` ] && echo git; true`)
	p.Git = strings.Contains(out, "git")
	_, p.Conversations, _ = e.conversationDirs(ctx, from, fromAbs)
	return p, nil
}

// pipe runs a script on one device whose output is the input of a script on another, and
// counts what passes.
func (e *Engine) pipe(ctx context.Context, from, fromScript, to, toScript string, progress func(int64)) (int64, error) {
	src, err := e.cmdOn(ctx, from, fromScript)
	if err != nil {
		return 0, err
	}
	dst, err := e.cmdOn(ctx, to, toScript)
	if err != nil {
		return 0, err
	}
	out, err := src.StdoutPipe()
	if err != nil {
		return 0, err
	}
	in, err := dst.StdinPipe()
	if err != nil {
		return 0, err
	}
	var srcErr, dstErr strings.Builder
	src.Stderr, dst.Stderr = &srcErr, &dstErr
	if err := dst.Start(); err != nil {
		return 0, err
	}
	if err := src.Start(); err != nil {
		in.Close()
		_ = dst.Wait()
		return 0, err
	}
	var n int64
	copyErr := make(chan error, 1)
	go func() {
		buf := make([]byte, 256*1024)
		last := time.Time{}
		for {
			k, rerr := out.Read(buf)
			if k > 0 {
				if _, werr := in.Write(buf[:k]); werr != nil {
					copyErr <- werr
					return
				}
				n += int64(k)
				if progress != nil && time.Since(last) > 300*time.Millisecond {
					last = time.Now()
					progress(n)
				}
			}
			if rerr == io.EOF {
				copyErr <- nil
				return
			}
			if rerr != nil {
				copyErr <- rerr
				return
			}
		}
	}()
	cerr := <-copyErr
	in.Close()
	serr := src.Wait()
	derr := dst.Wait()
	if progress != nil {
		progress(n)
	}
	switch {
	case serr != nil:
		return n, fmt.Errorf("reading it on %s: %s", machineLabel(from), firstWords(srcErr.String(), serr))
	case derr != nil:
		return n, fmt.Errorf("writing it on %s: %s", machineLabel(to), firstWords(dstErr.String(), derr))
	case cerr != nil:
		return n, cerr
	}
	return n, nil
}

func firstWords(stderr string, err error) string {
	s := strings.TrimSpace(cleanSSHNoise(stderr))
	if s == "" {
		return err.Error()
	}
	if i := strings.LastIndex(s, "\n"); i >= 0 && len(s) > 300 {
		s = s[i+1:]
	}
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

// tarOut is shell that writes names (under the current folder) as a tar stream, the same way
// on macOS and Linux: no Mac metadata, so the other side gets plain files. (Spelled out for
// each system: a machine's login shell may be zsh, which doesn't split a variable into words.)
func tarOut(names []string, skip []string) string {
	var b strings.Builder
	for _, s := range skip {
		b.WriteString(" --exclude=" + sshx.Quote(s))
	}
	for _, n := range names {
		b.WriteString(" " + sshx.Quote(n))
	}
	args := b.String()
	return `if [ "$(uname)" = Darwin ]; then tar --no-mac-metadata --no-xattrs -cf -` + args + `; else tar -cf -` + args + `; fi`
}

// tarIn is shell that unpacks a tar stream into the current folder, quietly about headers
// from the other kind of tar.
const tarIn = `if tar --version 2>/dev/null | grep -q GNU; then tar --warning=no-unknown-keyword -xf -; else tar -xf -; fi`

// MoveFolder sends dir from one device to another as it is (see the top of this file).
func (e *Engine) MoveFolder(ctx context.Context, from, to, dir string, r events.Reporter) (MoveResult, error) {
	events.Stepf(r, "Looking at %s on %s", dir, machineLabel(from))
	plan, err := e.PlanMove(ctx, from, to, dir)
	if err != nil {
		return MoveResult{}, err
	}
	if e.quickMove(ctx, plan) {
		return e.sendQuick(ctx, plan, r, true)
	}
	return e.send(ctx, plan, r)
}

// MoveSession moves a session to another device: once both devices have answered, the
// session stops where it is (so nothing more is written there, and its conversation is
// complete), then its folder and conversations go over as MoveFolder sends them. The
// conversation is picked up there by its ID. If the send fails, the folder and conversations
// are still where they were, so the session can be picked up again there.
//
// Between this computer and a machine, after PrecopyMove, only what changed since goes after
// the stop: seconds, however big the folder (movesync.go).
func (e *Engine) MoveSession(ctx context.Context, from, session, to, dir string, r events.Reporter) (MoveResult, error) {
	events.Stepf(r, "Getting %s ready", machineLabel(to))
	plan, err := e.PlanMove(ctx, from, to, dir)
	if err != nil {
		return MoveResult{}, err
	}
	quick := e.quickMove(ctx, plan)
	if session != "" {
		events.Stepf(r, "Stopping it on %s", machineLabel(from))
		if err := e.KillSession(ctx, from, session); err != nil {
			return MoveResult{}, err
		}
	}
	if quick {
		return e.sendQuick(ctx, plan, r, true)
	}
	return e.send(ctx, plan, r)
}

// send does what plan says: the folder, then the Claude conversations that ran in it.
func (e *Engine) send(ctx context.Context, plan MovePlan, r events.Reporter) (MoveResult, error) {
	from, to := plan.From, plan.To
	var err error
	res := MoveResult{MovePlan: plan}
	parentFrom, parentTo := path.Dir(plan.FromDir), path.Dir(plan.ToDir)

	events.Stepf(r, "Sending %s to %s", plan.Name, machineLabel(to))
	started := time.Now()
	res.Bytes, err = e.pipe(ctx,
		from, "cd "+sshx.Quote(parentFrom)+" && "+tarOut([]string{plan.Name}, plan.Skip),
		to, "mkdir -p "+sshx.Quote(parentTo)+" && cd "+sshx.Quote(parentTo)+" && "+tarIn,
		func(n int64) { events.Logf(r, "%s sent", byteSize(n)) })
	if err != nil {
		return res, err
	}
	events.Infof(r, "Files: %s in %s", byteSize(res.Bytes), time.Since(started).Round(time.Second))

	dirs, count, err := e.conversationDirs(ctx, from, plan.FromDir)
	if err != nil {
		return res, err
	}
	if len(dirs) > 0 {
		events.Stepf(r, "Bringing %s along", plural(count, "Claude conversation"))
		if err := e.moveConversations(ctx, from, to, dirs, plan.FromDir, plan.ToDir); err != nil {
			return res, err
		}
	}
	res.Conversations = count
	// The conversation to pick up there: the newest one that ran in the folder itself.
	res.Latest = e.latestConversation(ctx, to, plan.ToDir)
	events.Donef(r, "%s is on %s at %s", plan.Name, machineLabel(to), plan.ToDir)
	return res, nil
}

// moveConversations copies Claude's conversation folders for a working folder to another
// device, under the names that device's Claude looks for, and points the paths inside them
// at the folder's new place.
func (e *Engine) moveConversations(ctx context.Context, from, to string, dirs []string, fromAbs, toAbs string) error {
	sort.Strings(dirs)
	stage := ".sky-incoming-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	land := landScript(`s=`+sshx.Quote(stage)+`; mkdir -p "$s"; (cd "$s" && `+tarIn+`)`, fromAbs, toAbs)
	names := make([]string, len(dirs))
	for i, d := range dirs {
		names[i] = "./" + d // they start with "-": not to be read as tar's options
	}
	_, err := e.pipe(ctx,
		from, `cd "$HOME/.claude/projects" && `+tarOut(names, nil),
		to, land, nil)
	return err
}

func byteSize(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%d KB", n>>10)
	}
	return fmt.Sprintf("%d B", n)
}
