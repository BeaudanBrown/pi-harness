package tmux

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
)

// Client provides tmux session discovery primitives.
type Client struct{}

// New returns a tmux client.
func New() Client {
	return Client{}
}

// HasSession reports whether the named tmux session exists.
func (Client) HasSession(ctx context.Context, session string) (bool, error) {
	cmd := exec.CommandContext(ctx, "tmux", "has-session", "-t", session)
	if err := cmd.Run(); err == nil {
		return true, nil
	} else {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return false, nil
		}
		return false, fmt.Errorf("tmux has-session %q: %w", session, err)
	}
}
