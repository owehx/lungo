// Package sshx runs commands on machines through the system ssh client, manages sky's key
// and keeps ~/.ssh/config pointing at every machine so `ssh <name>` just works.
package sshx

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/term"

	"skybuild/internal/model"
	"skybuild/internal/osx"
	"skybuild/internal/paths"
)

// RemotePath is prepended to PATH for every remote command so tools installed per user
// (claude, bun) and by Homebrew (gh on a Mac) are found in non-interactive shells.
const RemotePath = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; `

// EnsureKey creates sky's ed25519 key the first time and returns its path and public key.
func EnsureKey() (string, string, error) {
	priv := paths.DefaultKey()
	if b, err := os.ReadFile(priv + ".pub"); err == nil {
		return priv, strings.TrimSpace(string(b)), nil
	}
	if err := paths.Ensure(); err != nil {
		return "", "", err
	}
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	host, _ := os.Hostname()
	block, err := ssh.MarshalPrivateKey(key, "skybuild@"+host)
	if err != nil {
		return "", "", err
	}
	if err := os.WriteFile(priv, pem.EncodeToMemory(block), 0o600); err != nil {
		return "", "", err
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		return "", "", err
	}
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sshPub))) + " skybuild@" + host
	if err := os.WriteFile(priv+".pub", []byte(line+"\n"), 0o644); err != nil {
		return "", "", err
	}
	return priv, line, nil
}

// NoKey as a machine's KeyPath means "use your normal ssh keys", not sky's.
const NoKey = "-"

// Target is how to reach one machine.
type Target struct {
	Name    string // machine name, used for the known_hosts file
	Alias   string // existing ~/.ssh/config alias; when set the fields below are ignored
	User    string
	Host    string
	Port    int
	KeyPath string
	Proxy   string // ProxyCommand, e.g. "tailscale nc %h %p" for a userspace tailnet
}

// For builds a Target for a machine at the given address.
func For(m *model.Machine, address string) Target {
	t := Target{Name: m.Name, Alias: m.SSHAlias, User: m.User, Host: address, Port: m.SSHPort(), KeyPath: m.KeyPath}
	switch t.KeyPath {
	case "":
		t.KeyPath = paths.DefaultKey()
	case NoKey:
		t.KeyPath = "" // let ssh use the agent and ~/.ssh/id_* keys
	}
	t.KeyPath = paths.Expand(t.KeyPath)
	return t
}

func (t Target) knownHosts() string { return filepath.Join(paths.KnownHosts(), t.Name) }

// Dest is the user@host (or alias) argument.
func (t Target) Dest() string {
	if t.Alias != "" {
		return t.Alias
	}
	return t.User + "@" + t.Host
}

// Options are the -o flags shared by ssh and rsync. They reuse one connection per machine.
func (t Target) Options(batch bool) []string { return t.options(batch, true) }

// TunnelOptions are Options without connection sharing: a port forward needs its own
// connection, or it lands in the shared one and outlives the process that asked for it.
func (t Target) TunnelOptions() []string {
	return append(t.options(true, false), "-o", "ControlMaster=no", "-o", "ControlPath=none")
}

// TerminalOptions are for interactive terminals: their own connection each, so many open
// panes never run into the server's limit on sessions per connection.
func (t Target) TerminalOptions() []string {
	return append(t.options(false, false), "-o", "ControlMaster=no", "-o", "ControlPath=none")
}

// BulkOptions are for sending files: their own connection. Through the shared one a stream
// of files crawls next to the panes' traffic (measured 1.2–1.6 MB/s shared, ~10 MB/s alone).
func (t Target) BulkOptions() []string {
	return append(t.options(true, false), "-o", "ControlMaster=no", "-o", "ControlPath=none")
}

// BulkSSHCommand is ssh with BulkOptions as one shell string, for rsync -e.
func (t Target) BulkSSHCommand() string {
	parts := []string{"ssh"}
	for _, o := range t.BulkOptions() {
		parts = append(parts, shellQuote(o))
	}
	return strings.Join(parts, " ")
}

func (t Target) options(batch, mux bool) []string {
	var o []string
	if t.Alias == "" {
		o = append(o, "-p", strconv.Itoa(t.Port))
		if t.KeyPath != "" {
			o = append(o, "-i", t.KeyPath, "-o", "IdentitiesOnly=yes")
		}
		if t.Proxy != "" {
			o = append(o, "-o", "ProxyCommand="+t.Proxy)
		}
		o = append(o, "-o", "UserKnownHostsFile="+t.knownHosts(),
			"-o", "StrictHostKeyChecking=accept-new")
	}
	o = append(o, "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4")
	if batch {
		o = append(o, "-o", "BatchMode=yes")
	}
	if mux && runtime.GOOS != "windows" { // Windows OpenSSH has no connection sharing
		o = append(o, "-o", "ControlMaster=auto", "-o", "ControlPath="+filepath.Join(paths.ControlDir(), "%C"), "-o", "ControlPersist=120")
	}
	return o
}

// SSHCommand is the ssh invocation as one shell string, for rsync -e and for display.
func (t Target) SSHCommand() string {
	parts := []string{"ssh"}
	for _, o := range t.Options(true) {
		parts = append(parts, shellQuote(o))
	}
	return strings.Join(parts, " ")
}

// Run executes cmd on the machine and returns stdout.
func Run(ctx context.Context, t Target, cmd string) (string, error) {
	return RunInput(ctx, t, cmd, nil)
}

// RunInput is Run with stdin.
func RunInput(ctx context.Context, t Target, cmd string, stdin io.Reader) (string, error) {
	args := append(t.Options(true), t.Dest(), "--", RemotePath+cmd)
	r, err := osx.Exec(ctx, osx.Cmd{Name: "ssh", Args: args, Stdin: stdin})
	if err != nil {
		return r.Stdout, fmt.Errorf("on %s: %w", t.Name, cleanErr(err))
	}
	return r.Stdout, nil
}

// RunTo executes cmd on the machine and copies its stdout to w as it arrives: for output that
// is large or not text (a file's contents).
func RunTo(ctx context.Context, t Target, cmd string, w io.Writer) error {
	args := append(t.Options(true), t.Dest(), "--", RemotePath+cmd)
	c := exec.CommandContext(ctx, osx.Which("ssh"), args...)
	c.WaitDelay = 3 * time.Second // ssh's ProxyCommand can outlive it and hold the pipes
	var errb strings.Builder
	c.Stdout, c.Stderr = w, &errb
	if err := c.Run(); err != nil {
		if msg := strings.TrimSpace(errb.String()); msg != "" {
			return fmt.Errorf("on %s: %s", t.Name, msg)
		}
		return fmt.Errorf("on %s: %w", t.Name, cleanErr(err))
	}
	return nil
}

// Stream runs cmd and hands each output line to fn as it arrives.
func Stream(ctx context.Context, t Target, cmd string, fn func(string)) error {
	return StreamInput(ctx, t, cmd, nil, fn)
}

// StreamInput is Stream with stdin.
func StreamInput(ctx context.Context, t Target, cmd string, stdin io.Reader, fn func(string)) error {
	args := append(t.Options(true), t.Dest(), "--", RemotePath+cmd)
	c := exec.CommandContext(ctx, osx.Which("ssh"), args...)
	c.WaitDelay = 3 * time.Second // ssh's ProxyCommand can outlive it and hold the pipes
	pr, pw := io.Pipe()
	c.Stdout, c.Stderr, c.Stdin = pw, pw, stdin
	if err := c.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			fn(sc.Text())
		}
		close(done)
	}()
	err := c.Wait()
	pw.Close()
	<-done
	return err
}

// Interactive runs ssh attached to this terminal and returns when the session ends.
// cmd may be empty for a login shell.
func Interactive(t Target, cmd string) error {
	args := t.Options(false)
	if term.IsTerminal(int(os.Stdin.Fd())) {
		args = append(args, "-t")
	}
	args = append(args, t.Dest())
	if cmd != "" {
		args = append(args, "--", cmd)
	}
	c := exec.Command(osx.Which("ssh"), args...)
	c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
	return c.Run()
}

// Reachable reports whether a trivial command succeeds within a few seconds.
func Reachable(ctx context.Context, t Target) bool {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	_, err := Run(ctx, t, "true")
	return err == nil
}

// WaitReady polls until ssh works or ctx ends. tick is called between attempts.
func WaitReady(ctx context.Context, t Target, tick func(attempt int, err error)) error {
	for i := 1; ; i++ {
		c, cancel := context.WithTimeout(ctx, 15*time.Second)
		_, err := Run(c, t, "true")
		cancel()
		if err == nil {
			return nil
		}
		if tick != nil {
			tick(i, err)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%s never accepted ssh: %w", t.Name, err)
		case <-time.After(5 * time.Second):
		}
	}
}

// ForgetHost drops the saved host key, for a machine that was rebuilt or deleted.
func ForgetHost(name string) {
	os.Remove(filepath.Join(paths.KnownHosts(), name))
	CloseMaster(name)
}

// CloseMaster ends shared connections, which hold on to an old address after an IP change.
// Each master is asked to exit before its socket is removed, so none linger.
func CloseMaster(string) {
	entries, _ := os.ReadDir(paths.ControlDir())
	for _, e := range entries {
		sock := filepath.Join(paths.ControlDir(), e.Name())
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = exec.CommandContext(ctx, osx.Which("ssh"), "-o", "ControlPath="+sock, "-O", "exit", "skybuild").Run()
		cancel()
		os.Remove(sock)
	}
}

func cleanErr(err error) error {
	s := err.Error()
	for _, noise := range []string{"Warning: Permanently added", "** WARNING: connection is not using a post-quantum"} {
		var keep []string
		for _, line := range strings.Split(s, "\n") {
			if !strings.Contains(line, noise) {
				keep = append(keep, line)
			}
		}
		s = strings.Join(keep, "\n")
	}
	return errors.New(strings.TrimSpace(s))
}

func shellQuote(s string) string {
	if s != "" && !strings.ContainsAny(s, " \t\"'$`\\!*?[]{}()<>|&;#~") {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// Quote quotes a string for a POSIX shell on the remote side.
func Quote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// Resolved is what `ssh -G <alias>` says an alias means.
type Resolved struct {
	Host    string
	User    string
	Port    int
	Keys    []string // identity files that exist
	Proxied bool     // reached through a jump host or proxy command: only the alias can express that
}

// Resolve expands an alias from the user's ssh config.
func Resolve(ctx context.Context, alias string) (Resolved, error) {
	var r Resolved
	out, err := osx.Run(ctx, "ssh", "-G", alias)
	if err != nil {
		return r, err
	}
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok {
			continue
		}
		switch k {
		case "hostname":
			r.Host = v
		case "user":
			r.User = v
		case "port":
			r.Port, _ = strconv.Atoi(v)
		case "identityfile":
			p := paths.Expand(v)
			if _, err := os.Stat(p); err == nil {
				r.Keys = append(r.Keys, p)
			}
		case "proxyjump", "proxycommand":
			if v != "" && v != "none" {
				r.Proxied = true
			}
		}
	}
	if r.Host == "" {
		return r, fmt.Errorf("ssh doesn't know a host called %q", alias)
	}
	return r, nil
}

// ConfigHosts lists the concrete Host aliases in the user's own ssh config (not sky's).
func ConfigHosts() []string {
	b, err := os.ReadFile(paths.UserSSHConfig())
	if err != nil {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(strings.TrimSpace(line))
		if len(f) < 2 || !strings.EqualFold(f[0], "Host") {
			continue
		}
		for _, h := range f[1:] {
			if strings.ContainsAny(h, "*?!") || seen[h] {
				continue
			}
			seen[h] = true
			out = append(out, h)
		}
	}
	return out
}
