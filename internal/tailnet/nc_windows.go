package tailnet

import (
	"context"
	"errors"
	"net"
)

// Tailscale on Windows always gives the OS a route to the tailnet.
func dialNC(context.Context, string, int) (net.Conn, error) {
	return nil, errors.New("tailscale in userspace mode isn't supported on Windows")
}
