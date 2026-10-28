package tailnet

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"skybuild/internal/osx"
)

// Person is who is on the other end of a tailnet connection (or on this computer).
type Person struct {
	Login  string `json:"login,omitempty"`  // their Tailscale login, e.g. ada@example.com
	Name   string `json:"name"`             // how they are called: "Ada Lovelace"
	Device string `json:"device,omitempty"` // the computer they are on: "adas-macbook"
	Avatar string `json:"avatar,omitempty"`
}

// Tagged devices (a server added with a tag) belong to no one: their "user" is this.
const taggedLogin = "tagged-devices"

func person(u *UserProfile, device string) *Person {
	p := &Person{Device: device}
	if u != nil && u.LoginName != taggedLogin {
		p.Login, p.Name, p.Avatar = u.LoginName, u.DisplayName, u.ProfilePicURL
	}
	if p.Name == "" {
		p.Name = p.Login
	}
	if p.Name == "" {
		p.Name = device
	}
	return p
}

// shortName is a device's MagicDNS name without the tailnet: "demo" for demo.tail1234.ts.net.
func shortName(dns string) string {
	name, _, _ := strings.Cut(strings.TrimSuffix(dns, "."), ".")
	return name
}

// WhoIs says who is connecting from addr (ip:port). In userspace mode tailscaled hands
// incoming tailnet connections to local programs from 127.0.0.1, and still knows whose they
// are by the port.
func WhoIs(ctx context.Context, addr string) (*Person, error) {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	out, err := osx.Run(ctx, "tailscale", "whois", "--json", addr)
	if err != nil {
		return nil, err
	}
	var w struct {
		Node *struct {
			Name     string `json:"Name"`
			Hostinfo *struct {
				Hostname string `json:"Hostname"`
			} `json:"Hostinfo"`
		} `json:"Node"`
		UserProfile *UserProfile `json:"UserProfile"`
	}
	if err := json.Unmarshal([]byte(out), &w); err != nil {
		return nil, fmt.Errorf("could not read tailscale whois: %w", err)
	}
	if w.Node == nil {
		return nil, errors.New("tailscale doesn't know " + addr)
	}
	device := shortName(w.Node.Name)
	if device == "" && w.Node.Hostinfo != nil {
		device = w.Node.Hostinfo.Hostname
	}
	return person(w.UserProfile, device), nil
}

// Me is the person signed in to Tailscale on this computer, and this computer.
func (s *Status) Me() *Person {
	if s == nil || s.Self == nil {
		return &Person{Name: "Someone"}
	}
	device := shortName(s.Self.DNSName)
	if device == "" {
		device = s.Self.HostName
	}
	return person(s.User[strconv.FormatInt(s.Self.UserID, 10)], device)
}

var routeCache struct {
	sync.Mutex
	at        time.Time
	userspace bool
}

// userspace says whether Tailscale here runs in userspace mode (the OS has no route to
// 100.x). The answer is kept for half a minute: every forwarded connection asks.
func userspace(ctx context.Context) bool {
	routeCache.Lock()
	defer routeCache.Unlock()
	if time.Since(routeCache.at) < 30*time.Second {
		return routeCache.userspace
	}
	s, err := Local(ctx)
	routeCache.userspace = err == nil && !s.TUN
	routeCache.at = time.Now()
	return routeCache.userspace
}

// Dial connects to a port on a device on the tailnet: directly where the OS routes the
// tailnet, through `tailscale nc` where Tailscale runs in userspace mode.
func Dial(ctx context.Context, host string, port int) (net.Conn, error) {
	if !userspace(ctx) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	}
	return dialNC(ctx, host, port)
}
