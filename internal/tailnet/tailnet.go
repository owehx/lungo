// Package tailnet puts machines on the user's Tailscale network, so every machine keeps a
// stable private address and SSH works from anywhere without opening ports to the internet.
package tailnet

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"skybuild/internal/events"
	"skybuild/internal/osx"
	"skybuild/internal/sshx"
)

// Status is the part of `tailscale status --json` sky uses.
type Status struct {
	BackendState   string `json:"BackendState"`
	AuthURL        string `json:"AuthURL"`
	TUN            bool   `json:"TUN"` // false = userspace networking: the OS can't reach 100.x directly
	Self           *Node  `json:"Self"`
	Peer           map[string]*Node
	User           map[string]*UserProfile // by user ID (in decimal)
	CurrentTailnet *struct {
		Name           string `json:"Name"`
		MagicDNSSuffix string `json:"MagicDNSSuffix"`
	} `json:"CurrentTailnet"`
}

// Node is one device on the tailnet.
type Node struct {
	HostName     string   `json:"HostName"`
	DNSName      string   `json:"DNSName"`
	TailscaleIPs []string `json:"TailscaleIPs"`
	Online       bool     `json:"Online"`
	OS           string   `json:"OS"`
	UserID       int64    `json:"UserID"`
}

// UserProfile is a person on the tailnet.
type UserProfile struct {
	LoginName     string `json:"LoginName"`
	DisplayName   string `json:"DisplayName"`
	ProfilePicURL string `json:"ProfilePicURL"`
}

// IPv4 returns the node's 100.x address.
func (n *Node) IPv4() string {
	if n == nil {
		return ""
	}
	for _, ip := range n.TailscaleIPs {
		if !strings.Contains(ip, ":") {
			return ip
		}
	}
	return ""
}

// Name is the MagicDNS name without the trailing dot.
func (n *Node) Name() string {
	if n == nil {
		return ""
	}
	return strings.TrimSuffix(n.DNSName, ".")
}

// Local reads this computer's Tailscale state. It returns an error if Tailscale is missing.
func Local(ctx context.Context) (*Status, error) {
	if !osx.Has("tailscale") {
		return nil, errors.New("tailscale is not installed")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	out, err := osx.Run(ctx, "tailscale", "status", "--json")
	if out == "" && err != nil {
		return nil, err
	}
	var s Status
	if err := json.Unmarshal([]byte(out), &s); err != nil {
		return nil, fmt.Errorf("could not read tailscale status: %w", err)
	}
	return &s, nil
}

// Up reports whether this computer is connected to a tailnet.
func Up(ctx context.Context) bool {
	s, err := Local(ctx)
	return err == nil && s.BackendState == "Running"
}

// Remote reads a machine's Tailscale state over SSH.
func Remote(ctx context.Context, t sshx.Target) (*Status, error) {
	out, err := sshx.Run(ctx, t, "sudo tailscale status --json 2>/dev/null || true")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(out) == "" {
		return nil, errors.New("tailscale is not installed on " + t.Name)
	}
	var s Status
	if err := json.Unmarshal([]byte(out), &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// Join connects a machine to the tailnet and returns its Tailscale IP and DNS name.
// With an auth key it is unattended; without one it shows a login link for the user to approve.
func Join(ctx context.Context, t sshx.Target, hostname, authKey string, r events.Reporter) (string, string, error) {
	if _, err := sshx.Run(ctx, t, "command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sudo sh >/dev/null 2>&1"); err != nil {
		return "", "", fmt.Errorf("installing tailscale: %w", err)
	}
	if s, err := Remote(ctx, t); err == nil && s.BackendState == "Running" && s.Self != nil {
		return s.Self.IPv4(), s.Self.Name(), nil
	}
	host := sshx.Quote(hostname)
	if authKey != "" {
		events.Infof(r, "Joining the tailnet with your auth key")
		cmd := "umask 077 && cat > /tmp/.sky-ts-key && sudo tailscale up --auth-key=file:/tmp/.sky-ts-key --hostname=" + host + " --timeout=90s; rc=$?; rm -f /tmp/.sky-ts-key; exit $rc"
		if _, err := sshx.RunInput(ctx, t, cmd, strings.NewReader(authKey)); err != nil {
			return "", "", err
		}
	} else {
		// `tailscale up` blocks until someone approves the login, so leave it running on the
		// machine and read the login link from `tailscale status`.
		cmd := "sudo sh -c 'nohup tailscale up --hostname=" + strings.ReplaceAll(host, "'", `'\''`) + " >/tmp/sky-ts-up.log 2>&1 &'"
		if _, err := sshx.Run(ctx, t, cmd); err != nil {
			return "", "", err
		}
	}
	shown := ""
	deadline := time.Now().Add(15 * time.Minute)
	for time.Now().Before(deadline) {
		s, err := Remote(ctx, t)
		if err == nil {
			if s.BackendState == "Running" && s.Self != nil && s.Self.IPv4() != "" {
				return s.Self.IPv4(), s.Self.Name(), nil
			}
			url := s.AuthURL
			if url == "" {
				if log, _ := sshx.Run(ctx, t, "cat /tmp/sky-ts-up.log 2>/dev/null"); log != "" {
					url = findURL(log)
				}
			}
			if url != "" && url != shown {
				shown = url
				events.OpenURL(r, "Approve "+hostname+" on your tailnet", url)
			}
		}
		select {
		case <-ctx.Done():
			return "", "", ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
	return "", "", errors.New("timed out waiting for the Tailscale login to be approved; run `sky tailscale " + t.Name + "` to try again")
}

func findURL(s string) string {
	i := strings.Index(s, "https://login.tailscale.com/")
	if i < 0 {
		return ""
	}
	end := strings.IndexAny(s[i:], " \t\r\n")
	if end < 0 {
		return s[i:]
	}
	return s[i : i+end]
}

// Leave logs the machine out, which removes it from the tailnet (best effort, before delete).
func Leave(ctx context.Context, t sshx.Target) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	sshx.Run(ctx, t, "sudo tailscale logout >/dev/null 2>&1 || true")
}
