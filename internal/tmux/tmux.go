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
	if os.Getenv("TMUX") == "" {
		if err := c.runner.Run(ctx, "tmux", "attach-session", "-t", session); err != nil {
			return fmt.Errorf("tmux attach-session %q: %w", session, err)
		}
		return nil
	}

	if err := c.runner.Run(ctx, "tmux", "switch-client", "-t", session); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			if fallbackErr := c.runner.Run(ctx, "tmux", "attach-session", "-t", session); fallbackErr == nil {
				return nil
			}
		}
		return fmt.Errorf("tmux switch-client %q: %w", session, err)
	}
	return nil
}

// DisplayPopup opens a blocking tmux popup and runs the provided shell command.
func (c Controller) DisplayPopup(ctx context.Context, command string) error {
	if err := c.runner.Run(ctx, "tmux", "display-popup", "-E", command); err != nil {
		return fmt.Errorf("tmux display-popup: %w", err)
	}
	return nil
}

// JoinSessionWithPopup attaches the operator to the target session and opens a
// popup there as one tmux flow. This is the outside-tmux bootstrap path for
// commands that need a live client before running popup UI.
func (c Controller) JoinSessionWithPopup(ctx context.Context, session, cwd, command string) error {
	if err := c.runner.Run(ctx, "tmux", "new-session", "-A", "-s", session, "-c", cwd, ";", "display-popup", "-E", command); err != nil {
		return fmt.Errorf("tmux join session %q with popup: %w", session, err)
	}
	return nil
}
