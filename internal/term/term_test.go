//go:build !windows

package term

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestRoundTrip(t *testing.T) {
	m, err := NewManager()
	if err != nil {
		t.Fatal(err)
	}
	defer m.CloseAll()
	info, err := m.Start(Spec{Args: []string{"/bin/sh", "-c", "echo ready; read x; echo got:$x"}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, info.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	var out strings.Builder
	sent, exited := false, false
	for !exited {
		typ, data, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v (out so far %q)", err, out.String())
		}
		if typ == websocket.MessageText {
			if strings.Contains(string(data), `"exit"`) {
				exited = true
			}
			continue
		}
		out.Write(data)
		if !sent && strings.Contains(out.String(), "ready") {
			c.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":100,"rows":30}`))
			c.Write(ctx, websocket.MessageBinary, []byte("hello\r"))
			sent = true
		}
	}
	if !strings.Contains(out.String(), "got:hello") {
		t.Fatalf("output %q", out.String())
	}
	// Reconnect after exit replays output and exit notice.
	c2, _, err := websocket.Dial(ctx, info.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, data, err := c2.Read(ctx)
	if err != nil || !strings.Contains(string(data), "got:hello") {
		t.Fatalf("replay %q %v", data, err)
	}
	// Bad token is refused.
	if _, _, err := websocket.Dial(ctx, strings.Replace(info.URL, "token=", "token=x", 1), nil); err == nil {
		t.Fatal("expected bad token to fail")
	}
}

func TestProbe(t *testing.T) {
	m, err := NewManager()
	if err != nil {
		t.Fatal(err)
	}
	defer m.CloseAll()
	dir := t.TempDir()
	info, err := m.Start(Spec{Args: []string{"/bin/sh", "-c", "sleep 30"}, Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	var p Probe
	for i := 0; i < 20; i++ { // the shell needs a moment to start its child
		time.Sleep(100 * time.Millisecond)
		if p, err = m.Probe(info.ID); err == nil && p.Cwd != "" && p.Command != "" {
			break
		}
	}
	// macOS reports /private/var/… for a temp dir under /var.
	if !strings.HasSuffix(p.Cwd, strings.TrimPrefix(dir, "/private")) {
		t.Errorf("cwd = %q, want %q", p.Cwd, dir)
	}
	if p.Command != "sleep" && p.Command != "sh" {
		t.Errorf("command = %q", p.Command)
	}
	if p.Claude {
		t.Error("claude detected in a plain shell")
	}
	if _, err := m.Probe("nope"); err == nil {
		t.Error("expected an error for an unknown terminal")
	}
}

func TestIsClaude(t *testing.T) {
	for args, want := range map[string]bool{
		"claude":                           true,
		"claude --continue":                true,
		"/Users/x/.local/bin/claude -p hi": true,
		"/Users/x/.local/share/claude/versions/2.1.289 --resume abc": true,
		"-zsh":                        false,
		"vim claude.md":               false,
		"node /opt/claude-tools/x.js": false,
	} {
		if got := isClaude(args); got != want {
			t.Errorf("isClaude(%q) = %v", args, got)
		}
	}
}

func TestReplayLeavesOutQueries(t *testing.T) {
	m, err := NewManager()
	if err != nil {
		t.Fatal(err)
	}
	defer m.CloseAll()
	// What tmux does on attach: the alternate screen, then questions about the terminal.
	info, err := m.Start(Spec{Args: []string{"/bin/sh", "-c", `printf '\033[?1049hhello\033[c\033[>c\033[>q\033]11;?\033\\\033[6n\033[1mbold\033[0m\033[?2026$p done'; sleep 5`}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	read := func() string {
		c, _, err := websocket.Dial(ctx, info.URL, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer c.CloseNow()
		var out strings.Builder
		for !strings.Contains(out.String(), "done") {
			typ, data, err := c.Read(ctx)
			if err != nil {
				t.Fatalf("read: %v (out so far %q)", err, out.String())
			}
			if typ == websocket.MessageBinary {
				out.Write(data)
			}
		}
		return out.String()
	}
	read() // the first tab: it was asked, and answered
	if got, want := read(), "\x1b[?1049hhello\x1b[1mbold\x1b[0m done"; got != want {
		t.Fatalf("replayed %q, want %q", got, want)
	}
}
