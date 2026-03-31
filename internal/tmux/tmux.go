package tmux

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
)

type commandRunner interface {
	Run(context.Context, string, ...string) error
}

type execRunner struct{}

func (execRunner) Run(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	return cmd.Run()
}

// Controller provides tmux session discovery and attach primitives.
type Controller struct {
	runner commandRunner
}

// New returns a tmux controller.
func New() Controller {
	return Controller{runner: execRunner{}}
}

// HasSession reports whether the named tmux session exists.
func (c Controller) HasSession(ctx context.Context, session string) (bool, error) {
	err := c.runner.Run(ctx, "tmux", "has-session", "-t", session)
	if err == nil {
		return true, nil
	}

	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return false, nil
	}
	return false, fmt.Errorf("tmux has-session %q: %w", session, err)
}

// EnsureSession creates a detached session when it does not exist already.
func (c Controller) EnsureSession(ctx context.Context, session, cwd string) (bool, error) {
	exists, err := c.HasSession(ctx, session)
	if err != nil {
		return false, err
	}
	if exists {
		return false, nil
	}

	if err := c.runner.Run(ctx, "tmux", "new-session", "-d", "-s", session, "-c", cwd); err != nil {
		return false, fmt.Errorf("tmux new-session %q: %w", session, err)
	}
	return true, nil
}

// AttachOrSwitch moves the current operator terminal into the target session.
func (c Controller) AttachOrSwitch(ctx context.Context, session string) error {
	args := []string{"attach-session", "-t", session}
	if os.Getenv("TMUX") != "" {
		args = []string{"switch-client", "-t", session}
	}

	if err := c.runner.Run(ctx, "tmux", args...); err != nil {
		return fmt.Errorf("tmux %s %q: %w", args[0], session, err)
	}
	return nil
}
