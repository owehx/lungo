package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"skybuild/internal/claudeacct"
	"skybuild/internal/config"
	"skybuild/internal/paths"
)

// TestClaudeProxyLive sends a real Claude request through the proxy with a used-up account
// active (SKY_LIVE_PROXY="<used-up account id> <account with room>"): Claude must get its
// answer, the used-up one be marked so, and sessions move to the other. It runs in a home of
// its own (the accounts' tokens are read from the Keychain as always).
func TestClaudeProxyLive(t *testing.T) {
	ids := strings.Fields(os.Getenv("SKY_LIVE_PROXY"))
	if len(ids) != 2 {
		t.Skip(`set SKY_LIVE_PROXY="<used-up account> <account with room>"`)
	}
	real, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SKYBUILD_HOME", t.TempDir())
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	if err := config.Update(func(c *config.Config) error {
		for _, id := range ids {
			for _, a := range real.ClaudeAccounts {
				if a.ID == id {
					c.ClaudeAccounts = append(c.ClaudeAccounts, a)
				}
			}
		}
		c.Settings.ClaudeActive, c.Settings.ClaudeStrategy = ids[0], real.Settings.ClaudeStrategy
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go New().ServeClaudeProxy(ctx, "test")
	for i := 0; ; i++ {
		if v, ok := ClaudeProxyUp(ctx); ok && v == "test" {
			break
		}
		if i > 50 {
			t.Fatal("the proxy didn't come up")
		}
		time.Sleep(100 * time.Millisecond)
	}
	cfg, work := t.TempDir(), t.TempDir()
	cmd := exec.Command("claude", "-p", "Reply with exactly the word PONG and nothing else.", "--model", "haiku", "--strict-mcp-config", "--setting-sources", "")
	cmd.Dir = work
	var env []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "CLAUDE_CODE_OAUTH_TOKEN=") && !strings.HasPrefix(kv, "ANTHROPIC_") && !strings.HasPrefix(kv, "CLAUDE_CONFIG_DIR=") {
			env = append(env, kv)
		}
	}
	cmd.Env = append(env, "CLAUDE_CONFIG_DIR="+cfg, "CLAUDE_CODE_OAUTH_TOKEN="+claudeacct.Token(ids[0]), fmt.Sprintf("ANTHROPIC_BASE_URL=http://127.0.0.1:%d", ClaudeProxyPort), "DISABLE_AUTOUPDATER=1")
	cmd.Stdin = strings.NewReader("")
	started := time.Now()
	out, err := cmd.CombinedOutput()
	t.Logf("claude: %q in %s (%v)", strings.TrimSpace(string(out)), time.Since(started).Round(time.Millisecond), err)
	if os.Getenv("SKY_LIVE_PROXY_ALL") != "" { // both used up: Claude is told when the first frees up
		log, _ := os.ReadFile(filepath.Join(paths.Logs(), "claude-proxy.log"))
		t.Logf("proxy log:\n%s", log)
		if !strings.Contains(string(out), "limit") {
			t.Fatalf("no limit said")
		}
		return
	}
	if err != nil || !strings.Contains(string(out), "PONG") {
		t.Fatalf("no answer through the proxy")
	}
	c, _ := config.Load()
	if c.Settings.ClaudeActive != ids[1] {
		t.Errorf("sessions use %s, want %s", c.Settings.ClaudeActive, ids[1])
	}
	st := claudeacct.Load()
	if st[ids[0]].State != claudeacct.StateLimited || !st[ids[0]].ResetsAt.After(time.Now()) {
		b, _ := json.Marshal(st[ids[0]])
		t.Errorf("used-up account: %s", b)
	}
	if w := st[ids[1]].Windows["five_hour"]; w == nil {
		b, _ := json.Marshal(st[ids[1]])
		t.Errorf("no usage kept for the other: %s", b)
	}
	log, _ := os.ReadFile(filepath.Join(paths.Logs(), "claude-proxy.log"))
	t.Logf("proxy log:\n%s", log)
}
