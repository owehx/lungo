package main

import (
	"context"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"

	"github.com/gofrs/flock"

	"skybuild/internal/engine"
	"skybuild/internal/paths"
)

// The Claude proxy runs as its own process, the app's binary with --claude-proxy, kept up by
// launchd: Claude sessions live in tmux and outlive the app, and so must what they send
// through (see engine/claudeproxy.go). The installed app sets the service up when it starts,
// and restarts it on an update so it runs the same version.

const proxyLabel = "dev.skybuild.claude-proxy"

// proxyMain is the app started as the proxy.
func proxyMain() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := engine.New().ServeClaudeProxy(ctx, appVersion()); err != nil {
		os.Stderr.WriteString("claude proxy: " + err.Error() + "\n")
		os.Exit(1)
	}
}

// ensureClaudeProxy sets up the proxy's launchd service when this is the installed app (a
// development build leaves it alone), and restarts it when it runs another version.
func ensureClaudeProxy() {
	if runtime.GOOS != "darwin" || os.Getenv("SKY_HEADLESS") != "" || os.Getenv("SKY_NO_CLAUDE_PROXY") != "" {
		return
	}
	bundle, ok := appBundle()
	if !ok || filepath.Dir(bundle) != "/Applications" && filepath.Dir(bundle) != filepath.Join(paths.Home(), "Applications") {
		return
	}
	exe := filepath.Join(bundle, "Contents", "MacOS", filepath.Base(os.Args[0]))
	if _, err := os.Stat(exe); err != nil {
		if exe, err = os.Executable(); err != nil {
			return
		}
	}
	l := flock.New(filepath.Join(paths.State(), "claude-proxy.lock")) // one window sees to it
	if ok, _ := l.TryLock(); !ok {
		return
	}
	defer l.Unlock()
	plistPath := filepath.Join(paths.Home(), "Library", "LaunchAgents", proxyLabel+".plist")
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>` + proxyLabel + `</string>
	<key>ProgramArguments</key>
	<array>
		<string>` + xmlEscape(exe) + `</string>
		<string>--claude-proxy</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>2</integer>
	<key>StandardErrorPath</key>
	<string>` + xmlEscape(filepath.Join(paths.Logs(), "claude-proxy.err")) + `</string>
</dict>
</plist>
`
	_ = os.MkdirAll(filepath.Dir(plistPath), 0o755)
	_ = os.MkdirAll(paths.Logs(), 0o700)
	domain := "gui/" + strconv.Itoa(os.Getuid())
	changed, err := paths.WriteFile(plistPath, []byte(plist), 0o644)
	if err != nil {
		return
	}
	v, up := engine.ClaudeProxyUp(context.Background())
	switch {
	case changed || !up && exec.Command("launchctl", "print", domain+"/"+proxyLabel).Run() != nil:
		_ = exec.Command("launchctl", "bootout", domain+"/"+proxyLabel).Run()
		_ = exec.Command("launchctl", "bootstrap", domain, plistPath).Run()
	case !up || v != appVersion():
		_ = exec.Command("launchctl", "kickstart", "-k", domain+"/"+proxyLabel).Run()
	}
}
