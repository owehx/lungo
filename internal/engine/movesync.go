package engine

import (
	"bufio"
	"bytes"
	"context"
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

	"skybuild/internal/events"
	"skybuild/internal/osx"
	"skybuild/internal/paths"
	"skybuild/internal/sshx"
)

// Moving with rsync: copied ahead while the session works, then a switch in seconds.
//
// A move between this computer and a machine goes by rsync, run here over a connection of its
// own (sshx.BulkOptions). The folder and its Claude conversations can be copied over while the
// session is still at work (PrecopyMove), as often as you like, each time sending only what
// changed. The move itself (MoveSession) then stops the session and sends the last changes,
// which takes seconds even for a folder of many gigabytes.
//
// The conversations wait in a staging folder on the other device (~/.cache/sky-move/<name>),
// and are rewritten for the folder's new place into a folder beside it (<name>.landed) each
// time, only what changed. They go into ~/.claude/projects, which is a rename, once the session
// has stopped: until then they are still being written where they are. The move sends the
// folder's files changed since the last copy by name (sentStamp), found here in a blink, so it
// doesn't wait on rsync comparing every file on both sides.
//
// Between two machines, or where a side has no rsync, a move still streams everything through
// this computer after the stop (send, in move.go).

// ErrNoPrecopy: this move can't be copied ahead; MoveSession sends everything after the stop.
var ErrNoPrecopy = errors.New("this move can't be copied ahead")

// rsyncSafe are paths rsync can pass to the other side's shell as they are.
var rsyncSafe = regexp.MustCompile(`^[A-Za-z0-9._/+@~-]+$`)

var rsyncOn sync.Map // machine name → whether it has rsync

// localRsync is this computer's rsync, or "" (Windows, or none installed).
func localRsync() string {
	if runtime.GOOS == "windows" {
		return ""
	}
	if p, err := exec.LookPath("rsync"); err == nil {
		return p
	}
	if _, err := os.Stat("/usr/bin/rsync"); err == nil {
		return "/usr/bin/rsync"
	}
	return ""
}

func (e *Engine) hasRsync(ctx context.Context, machine string) bool {
	if IsLocal(machine) {
		return localRsync() != ""
	}
	if v, ok := rsyncOn.Load(machine); ok {
		return v.(bool)
	}
	out, err := e.shOn(ctx, machine, `command -v rsync >/dev/null 2>&1 && echo yes; true`)
	if err != nil {
		return false
	}
	ok := strings.Contains(out, "yes")
	rsyncOn.Store(machine, ok)
	return ok
}

// remoteSide is the machine in a move between it and this computer ("" for any other move).
func remoteSide(p MovePlan) string {
	switch {
	case IsLocal(p.From) && !IsLocal(p.To):
		return p.To
	case IsLocal(p.To) && !IsLocal(p.From):
		return p.From
	}
	return ""
}

// quickMove says whether a move can go by rsync.
func (e *Engine) quickMove(ctx context.Context, p MovePlan) bool {
	m := remoteSide(p)
	if m == "" || !rsyncSafe.MatchString(p.FromDir) || !rsyncSafe.MatchString(p.ToDir) {
		return false
	}
	return e.hasRsync(ctx, LocalMachine) && e.hasRsync(ctx, m)
}

// moveStage is where a folder's conversations wait on the device they go to, under its home.
func moveStage(fromDir string) string { return ".cache/sky-move/" + claudeProjectName(fromDir) }

// rsyncStats is what one rsync run says about itself.
type rsyncStats struct {
	ToSend  int64  // bytes of the files it sends (or, run with -n, would send)
	Wire    int64  // bytes that went over the connection
	Files   int    // files it sent
	Warning string // some files couldn't be sent (they vanished, or couldn't be read)
}

var (
	reProgress = regexp.MustCompile(`^\s*([\d,]+)\s+\d+%`)
	reToSend   = regexp.MustCompile(`Total transferred file size: ([\d,]+)`)
	reFiles    = regexp.MustCompile(`Number of (?:regular )?files transferred: ([\d,]+)`)
	reWire     = regexp.MustCompile(`sent ([\d,]+) bytes\s+received ([\d,]+) bytes`)
)

func atoi64(s string) int64 {
	n, _ := strconv.ParseInt(strings.ReplaceAll(s, ",", ""), 10, 64)
	return n
}

// rsyncTarget is how rsync reaches a machine.
func (e *Engine) rsyncTarget(machine string) (sshx.Target, error) {
	m, err := e.Machine(machine)
	if err != nil {
		return sshx.Target{}, err
	}
	if err := e.Ready(m); err != nil {
		return sshx.Target{}, err
	}
	return e.Target(m), nil
}

func remoteArg(t sshx.Target, p string) string { return t.Dest() + ":" + p }

// rsyncRun runs rsync here (in dir, or the home folder) with args after its usual options,
// over a connection of its own to t. progress, when given, hears the bytes of files sent so far.
func (e *Engine) rsyncRun(ctx context.Context, t sshx.Target, dir string, args []string, progress func(int64)) (rsyncStats, error) {
	var st rsyncStats
	bin := localRsync()
	if bin == "" {
		return st, errors.New("there is no rsync on this computer")
	}
	// rsync splits -e on spaces, and the two kinds of rsync quote differently: a small script
	// holds the ssh command instead, every word quoted for the shell.
	w, err := os.CreateTemp("", "sky-rsync-ssh-*")
	if err != nil {
		return st, err
	}
	defer os.Remove(w.Name())
	words := []string{sshx.Quote(osx.Which("ssh"))}
	for _, o := range t.BulkOptions() {
		words = append(words, sshx.Quote(o))
	}
	fmt.Fprintf(w, "#!/bin/sh\nexec %s \"$@\"\n", strings.Join(words, " "))
	w.Close()
	if err := os.Chmod(w.Name(), 0o700); err != nil {
		return st, err
	}

	full := []string{"-a", "--partial", "--stats", "-e", w.Name()}
	if progress != nil {
		full = append(full, "--progress")
	}
	c := exec.CommandContext(ctx, bin, append(full, args...)...)
	c.Dir = dir
	if c.Dir == "" {
		c.Dir = paths.Home()
	}
	c.Env = append(os.Environ(), "COPYFILE_DISABLE=1")
	c.WaitDelay = 3 * time.Second
	out, err := c.StdoutPipe()
	if err != nil {
		return st, err
	}
	var stderr bytes.Buffer
	c.Stderr = &stderr
	if err := c.Start(); err != nil {
		return st, err
	}
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	sc.Split(splitLines) // progress redraws a line with \r
	var done, cur int64
	last := time.Time{}
	for sc.Scan() {
		line := sc.Text()
		if m := reProgress.FindStringSubmatch(line); m != nil {
			cur = atoi64(m[1])
			if strings.Contains(line, "xfer#") || strings.Contains(line, "xfr#") { // the file is through
				done += cur
				cur = 0
			}
			if progress != nil && time.Since(last) > 300*time.Millisecond {
				last = time.Now()
				progress(done + cur)
			}
			continue
		}
		if m := reToSend.FindStringSubmatch(line); m != nil {
			st.ToSend = atoi64(m[1])
		} else if m := reFiles.FindStringSubmatch(line); m != nil {
			st.Files = int(atoi64(m[1]))
		} else if m := reWire.FindStringSubmatch(line); m != nil {
			st.Wire = atoi64(m[1]) + atoi64(m[2])
		}
	}
	err = c.Wait()
	if progress != nil {
		progress(done + cur)
	}
	if err != nil {
		var x *exec.ExitError
		// 23: some files couldn't be sent; 24: some vanished on the way (a folder in use). The
		// rest went; say so rather than fail.
		if errors.As(err, &x) && (x.ExitCode() == 23 || x.ExitCode() == 24) && ctx.Err() == nil {
			st.Warning = firstWords(stderr.String(), err)
			return st, nil
		}
		if ctx.Err() != nil {
			return st, ctx.Err()
		}
		return st, fmt.Errorf("rsync: %s", firstWords(stderr.String(), err))
	}
	return st, nil
}

// splitLines splits on \n and on \r, the way progress output redraws its line.
func splitLines(data []byte, atEOF bool) (int, []byte, error) {
	if i := bytes.IndexAny(data, "\r\n"); i >= 0 {
		return i + 1, data[:i], nil
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}

// rsyncReported runs rsync and says how far along it is, as "1.2 GB of 8.2 GB · 15%" lines
// (or "1.2 GB sent" when ahead says not to work out the total first).
func (e *Engine) rsyncReported(ctx context.Context, t sshx.Target, dir string, args []string, total bool, r events.Reporter) (rsyncStats, error) {
	var of int64
	if total {
		if dry, err := e.rsyncRun(ctx, t, dir, append([]string{"-n"}, args...), nil); err == nil {
			of = dry.ToSend
		}
	}
	return e.rsyncRun(ctx, t, dir, args, func(n int64) {
		if of > 0 {
			events.Logf(r, "%s of %s · %d%%", byteSize(n), byteSize(of), min(100, n*100/of))
		} else if n > 0 {
			events.Logf(r, "%s sent", byteSize(n))
		}
	})
}

func excludes(skip []string) []string {
	out := make([]string, 0, len(skip))
	for _, s := range skip {
		out = append(out, "--exclude="+s)
	}
	return out
}

// sendQuick is send by rsync. Ahead of a move (land false) it copies the folder and gets the
// conversations ready there; for the move itself (land true) it sends what changed since and
// puts the conversations in place. The folder and the conversations go side by side.
func (e *Engine) sendQuick(ctx context.Context, plan MovePlan, r events.Reporter, land bool) (MoveResult, error) {
	res := MoveResult{MovePlan: plan}
	from, to := plan.From, plan.To
	t, err := e.rsyncTarget(remoteSide(plan))
	if err != nil {
		return res, err
	}
	local := IsLocal(from) // sending from here (a push), or bringing here (a pull)
	dirs, count, err := e.conversationDirs(ctx, from, plan.FromDir)
	if err != nil {
		return res, err
	}
	res.Conversations = count
	along := ""
	if len(dirs) > 0 {
		along = " and " + plural(count, "Claude conversation")
	}
	if land {
		events.Stepf(r, "Sending what changed in %s%s", plan.Name, along)
	} else {
		events.Stepf(r, "Copying %s%s to %s", plan.Name, along, machineLabel(to))
	}
	if _, err := e.shOn(ctx, to, "mkdir -p "+sshx.Quote(plan.ToDir)+` "$HOME"/`+sshx.Quote(moveStage(plan.FromDir))); err != nil {
		return res, err
	}

	var wg sync.WaitGroup
	var convErr error
	if len(dirs) > 0 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			convErr = e.sendConversations(ctx, t, plan, dirs, local, land, r)
		}()
	}
	started := time.Now()
	st, err := e.sendFolder(ctx, t, plan, local, land, r)
	wg.Wait()
	if err != nil {
		return res, err
	}
	res.Bytes = st.Wire
	if st.Warning != "" {
		events.Warnf(r, "Some files didn't go: %s", st.Warning)
	}
	events.Infof(r, "Files: %d changed, %s over the wire in %s", st.Files, byteSize(st.Wire), time.Since(started).Round(100*time.Millisecond))
	if convErr != nil {
		return res, convErr
	}
	if !land {
		events.Donef(r, "%s is copied to %s; the move sends only what changes from here", plan.Name, machineLabel(to))
		return res, nil
	}
	e.shOn(ctx, from, `rm -f "$HOME"/`+sshx.Quote(sentStamp(to, plan.FromDir))+` "$HOME"/`+sshx.Quote(sentStamp(to, plan.FromDir)+".next"))
	res.Latest = e.latestConversation(ctx, to, plan.ToDir)
	events.Donef(r, "%s is on %s at %s", plan.Name, machineLabel(to), plan.ToDir)
	return res, nil
}

// sentStamp marks, on the device a folder goes from, when its last copy ahead to a device
// began (under its home): what changed after it is what the move has left to send.
func sentStamp(to, fromDir string) string {
	return ".cache/sky-move/sent-" + reUnsafeName.ReplaceAllString(to, "_") + claudeProjectName(fromDir)
}

var reUnsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// changedMax is how many changed files the move sends by name; past that, rsync looks the
// whole folder over instead.
const changedMax = 5000

// sendFolder sends the folder. Copying ahead it looks the whole folder over and marks when it
// began; the move after it sends just the files changed since (found here in a blink, where
// rsync would compare every file on both sides).
func (e *Engine) sendFolder(ctx context.Context, t sshx.Target, plan MovePlan, local, land bool, r events.Reporter) (rsyncStats, error) {
	from, to := plan.From, plan.To
	stamp := `"$HOME"/` + sshx.Quote(sentStamp(to, plan.FromDir))
	src, dst := plan.FromDir+"/", plan.ToDir+"/"
	if local {
		dst = remoteArg(t, dst)
	} else {
		src = remoteArg(t, src)
	}
	args := excludes(plan.Skip)
	if !land {
		if _, err := e.shOn(ctx, from, `mkdir -p "$HOME/.cache/sky-move" && touch `+stamp+`.next`); err != nil {
			return rsyncStats{}, err
		}
	} else if local {
		if files, ok := e.changedSince(ctx, plan, stamp); ok {
			if len(files) == 0 {
				return rsyncStats{}, nil
			}
			list, err := os.CreateTemp("", "sky-files-*")
			if err != nil {
				return rsyncStats{}, err
			}
			defer os.Remove(list.Name())
			list.WriteString(strings.Join(files, "\n") + "\n")
			list.Close()
			args = append(args, "--files-from="+list.Name())
		}
	}
	st, err := e.rsyncReported(ctx, t, "", append(args, src, dst), !land, r)
	if err == nil && !land {
		_, err = e.shOn(ctx, from, `mv -f `+stamp+`.next `+stamp)
	}
	return st, err
}

// changedSince lists the files in a folder here changed since its last copy ahead (by their
// ctime, which moving or restoring a file also sets), relative to it. Not ok: there was no copy
// ahead, or too much changed to name; rsync looks the folder over.
func (e *Engine) changedSince(ctx context.Context, plan MovePlan, stamp string) ([]string, bool) {
	prune := make([]string, 0, len(plan.Skip))
	for _, s := range plan.Skip {
		prune = append(prune, "-name "+sshx.Quote(s))
	}
	script := `st=` + stamp + `; [ -f "$st" ] || { echo none; exit 0; }
cd ` + sshx.Quote(plan.FromDir) + ` && find . \( ` + strings.Join(prune, " -o ") + ` \) -prune -o ! -type d -cnewer "$st" -print | head -` + strconv.Itoa(changedMax+1)
	out, err := e.shOn(ctx, plan.From, script)
	if err != nil {
		return nil, false
	}
	var files []string
	for _, l := range strings.Split(out, "\n") {
		if l == "none" {
			return nil, false
		}
		if l = strings.TrimPrefix(l, "./"); l != "" {
			files = append(files, l)
		}
	}
	return files, len(files) <= changedMax
}

// sendConversations sends the folder's conversations to the staging folder there and lands
// them, paths rewritten, in a folder beside it; the move then puts them in place. Each time
// only the files that changed are sent and rewritten, so all that is left at the move is the
// newest lines of the conversations still being written, and a rename.
func (e *Engine) sendConversations(ctx context.Context, t sshx.Target, plan MovePlan, dirs []string, local, land bool, r events.Reporter) error {
	stage := moveStage(plan.FromDir)
	var args []string
	dir := ""
	if local {
		dir = filepath.Join(paths.Home(), ".claude", "projects")
		for _, d := range dirs {
			args = append(args, "./"+d) // they start with "-": not to be read as options
		}
		args = append(args, remoteArg(t, stage+"/"))
	} else {
		for _, d := range dirs {
			args = append(args, "--include=/"+d+"/", "--include=/"+d+"/**")
		}
		args = append(args, "--exclude=/*", remoteArg(t, ".claude/projects/"), filepath.Join(paths.Home(), stage)+"/")
	}
	if _, err := e.rsyncReported(ctx, t, dir, args, false, events.Func(func(events.Event) {})); err != nil {
		return err
	}
	if _, err := e.shOn(ctx, plan.To, landAhead(stage, plan.FromDir, plan.ToDir, land)); err != nil {
		return fmt.Errorf("putting the conversations in place on %s: %w", machineLabel(plan.To), err)
	}
	return nil
}

// landPerl rewrites the conversations waiting in a staging folder into a folder beside it
// (".landed"), named for the folder's new place and with the paths inside pointing there: only
// what changed since it last ran, by size and time (".sky-sig" remembers). With place, it then
// moves all of them into ~/.claude/projects, which is a rename, and clears both folders away.
const landPerl = `use strict; use warnings; use File::Find; use File::Path qw(make_path remove_tree); use File::Copy qw(copy move);
my ($stage, $proj, $oldn, $newn, $old, $new, $place) = @ARGV;
my $shadow = "$stage.landed"; my $sigf = "$shadow/.sky-sig"; my %sig;
if (open(my $fh, "<", $sigf)) { while (<$fh>) { chomp; my ($p, $s) = split /\t/, $_, 2; $sig{$p} = $s if defined $s; } close $fh; }
make_path($shadow);
my $dirOf = sub { my $p = shift; $p =~ s{/[^/]*$}{}; $p };
find({ no_chdir => 1, wanted => sub {
  my $f = $File::Find::name; return if -l $f || ! -f _;
  my ($top, $rest) = split m{/}, substr($f, length($stage) + 1), 2;
  return unless defined $rest && substr($top, 0, length($oldn)) eq $oldn;
  my $to = $newn . substr($top, length($oldn)) . "/" . $rest;
  my @st = stat($f); my $s = "$st[7] $st[9]"; my $t = "$shadow/$to";
  return if defined $sig{$to} && $sig{$to} eq $s && -e $t;
  make_path($dirOf->($t));
  if ($old ne $new && $f =~ /\.jsonl$/) {
    open(my $in, "<:raw", $f) or die "$f: $!"; my $c = do { local $/; <$in> }; close $in;
    $c =~ s/\Q$old\E/$new/g;
    open(my $out, ">:raw", "$t.sky-tmp") or die "$t: $!"; print $out $c; close $out or die "$t: $!";
  } else { copy($f, "$t.sky-tmp") or die "$f: $!"; }
  rename("$t.sky-tmp", $t) or die "$t: $!";
  chmod($st[2] & 07777, $t); utime($st[8], $st[9], $t);
  $sig{$to} = $s;
}}, $stage) if -d $stage;
open(my $fh, ">", "$sigf.tmp") or die "$sigf: $!"; print $fh "$_\t$sig{$_}\n" for sort keys %sig; close $fh or die; rename("$sigf.tmp", $sigf) or die;
exit 0 unless $place;
for my $to (sort keys %sig) {
  my $t = "$shadow/$to"; next unless -e $t;
  my $d = "$proj/$to"; make_path($dirOf->($d));
  rename($t, $d) or move($t, $d) or die "$d: $!";
}
remove_tree($shadow, $stage);`

// landAhead is the script that runs landPerl on the device the conversations go to.
func landAhead(stage, fromAbs, toAbs string, place bool) string {
	p := "0"
	if place {
		p = "1"
	}
	return `mkdir -p "$HOME/.claude/projects" && perl -e ` + sshx.Quote(landPerl) + ` "$HOME"/` + sshx.Quote(stage) + ` "$HOME/.claude/projects" ` +
		sshx.Quote(claudeProjectName(fromAbs)) + " " + sshx.Quote(claudeProjectName(toAbs)) + " " + sshx.Quote(fromAbs) + " " + sshx.Quote(toAbs) + " " + p
}

// PrecopyMove copies a folder and its conversations to another device ahead of moving its
// session, which keeps running meanwhile; the move then sends only what changed. Call it as
// often as you like. ErrNoPrecopy: this move can't be copied ahead.
func (e *Engine) PrecopyMove(ctx context.Context, from, to, dir string, r events.Reporter) (MoveResult, error) {
	plan, err := e.PlanMove(ctx, from, to, dir)
	if err != nil {
		return MoveResult{}, err
	}
	if !e.quickMove(ctx, plan) {
		return MoveResult{MovePlan: plan}, ErrNoPrecopy
	}
	return e.sendQuick(ctx, plan, r, false)
}

// DropPrecopy forgets a copy made ahead of a move that won't happen: the conversations waiting
// on the other device, and the mark of when it was made. (The folder copy stays: it is a copy
// of a folder, like any other.)
func (e *Engine) DropPrecopy(ctx context.Context, from, to, dir string) error {
	_, abs, err := e.homeAndPath(ctx, from, dir)
	if err != nil || abs == "" {
		return err
	}
	st := `"$HOME"/` + sshx.Quote(sentStamp(to, abs))
	e.shOn(ctx, from, `rm -f `+st+` `+st+`.next`)
	s := `"$HOME"/` + sshx.Quote(moveStage(abs))
	_, err = e.shOn(ctx, to, `rm -rf `+s+` `+s+`.landed`)
	return err
}

// RunningAgents names the agents a Claude conversation started that are still at work on a
// device: Claude marks an agent's record finished when it ends. A record left unfinished by a
// Claude that was stopped counts only while its agent wrote something in the last half hour
// (an agent can wait on one command for minutes).
func (e *Engine) RunningAgents(ctx context.Context, machine, sid string) ([]string, error) {
	if !sessionID.MatchString(sid) {
		return nil, fmt.Errorf("not a conversation: %q", sid)
	}
	script := `for f in "$HOME"/.claude/projects/*/` + sid + `/subagents/*.meta.json; do
  [ -f "$f" ] || continue
  grep -q '"finished":true' "$f" && continue
  j="${f%.meta.json}.jsonl"
  [ -n "$(find "$j" -mmin -30 2>/dev/null)" ] || continue
  d=$(sed -n 's/.*"description":"\([^"]*\)".*/\1/p' "$f"); printf '%s\n' "${d:-agent}"
done; true`
	out, err := e.shOn(ctx, machine, script)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, l := range strings.Split(out, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			names = append(names, l)
		}
	}
	return names, nil
}

// MirrorPull brings what changed in a folder on a machine to this computer's copy of it, so a
// session that moved there can be followed here: the files it writes show up in this
// computer's folder. Newer files only (what changed here since stays), nothing deleted, and not
// git's own folder: each side keeps its own history, and the session's move back brings that.
// It says how many files came.
func (e *Engine) MirrorPull(ctx context.Context, machine, remoteDir, localDir string) (int, error) {
	if !rsyncSafe.MatchString(remoteDir) || !rsyncSafe.MatchString(localDir) {
		return 0, fmt.Errorf("rsync can't take %s as it is", remoteDir)
	}
	if !e.hasRsync(ctx, LocalMachine) || !e.hasRsync(ctx, machine) {
		return 0, errors.New("no rsync on one side")
	}
	t, err := e.rsyncTarget(machine)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		return 0, err
	}
	args := append([]string{"--update", "--exclude=.git"}, excludes(MoveSkip)...)
	args = append(args, remoteArg(t, remoteDir+"/"), localDir+"/")
	st, err := e.rsyncRun(ctx, t, "", args, nil)
	return st.Files, err
}

// latestConversation is the newest conversation that ran in dir on a device, or "".
func (e *Engine) latestConversation(ctx context.Context, machine, dir string) string {
	out, _ := e.shOn(ctx, machine, `f=$(ls -t "$HOME/.claude/projects/`+claudeProjectName(dir)+`"/*.jsonl 2>/dev/null | head -1); [ -n "$f" ] && basename "$f" .jsonl; true`)
	if id := strings.TrimSpace(out); sessionID.MatchString(id) {
		return id
	}
	return ""
}

// landScript puts conversation folders waiting in a staging folder ($s, set by prep) in place
// under ~/.claude/projects, named for the folder's new place and with the paths inside pointing
// there, then removes the staging folder.
func landScript(prep, fromAbs, toAbs string) string {
	oldName, newName := claudeProjectName(fromAbs), claudeProjectName(toAbs)
	return `set -e; cd "$HOME/.claude/projects" 2>/dev/null || { mkdir -p "$HOME/.claude/projects"; cd "$HOME/.claude/projects"; }
` + prep + `
for d in "$s"/*; do
  [ -d "$d" ] || continue
  b=$(basename "$d"); n=./` + sshx.Quote(newName) + `"${b#` + oldName + `}"
  mkdir -p "$n"; cp -Rp "$d"/. "$n"/
  if [ ` + sshx.Quote(fromAbs) + ` != ` + sshx.Quote(toAbs) + ` ]; then
    # The paths go to perl through the environment, set on find (not with env: on some Macs
    # "env" in PATH is uv's ~/.local/bin/env, a script to source that runs nothing).
    OLD=` + sshx.Quote(fromAbs) + ` NEW=` + sshx.Quote(toAbs) + ` find "$n" -name '*.jsonl' -type f -exec perl -pi -e 's/\Q$ENV{OLD}\E/$ENV{NEW}/g' {} +
  fi
done
rm -rf "$s"`
}
