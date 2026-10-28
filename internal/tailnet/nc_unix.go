//go:build !windows

package tailnet

import (
	"context"
	"net"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"

	"skybuild/internal/osx"
)

// dialNC runs `tailscale nc` with one end of a socket pair as its input and output; the other
// end is the connection (a real socket, so deadlines and half-closes work as on any other).
func dialNC(ctx context.Context, host string, port int) (net.Conn, error) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return nil, err
	}
	ours, theirs := os.NewFile(uintptr(fds[0]), "tailnet"), os.NewFile(uintptr(fds[1]), "tailscale-nc")
	cmd := exec.Command(osx.Which("tailscale"), "nc", host, strconv.Itoa(port))
	cmd.Stdin, cmd.Stdout = theirs, theirs
	if err := cmd.Start(); err != nil {
		ours.Close()
		theirs.Close()
		return nil, err
	}
	theirs.Close()
	c, err := net.FileConn(ours)
	ours.Close()
	if err != nil {
		cmd.Process.Kill()
		go cmd.Wait()
		return nil, err
	}
	nc := &ncConn{Conn: c, cmd: cmd, exited: make(chan struct{})}
	go func() {
		cmd.Wait()
		close(nc.exited)
	}()
	return nc, nil
}

type ncConn struct {
	net.Conn
	cmd    *exec.Cmd
	exited chan struct{}
}

// Close ends the connection; `tailscale nc` ends when its input does, or is made to.
func (c *ncConn) Close() error {
	err := c.Conn.Close()
	go func() {
		select {
		case <-c.exited:
		case <-time.After(2 * time.Second):
			c.cmd.Process.Kill()
		}
	}()
	return err
}
