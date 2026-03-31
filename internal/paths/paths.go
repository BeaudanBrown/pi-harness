package paths

import (
	"os"
	"path/filepath"
)

const appName = "pi-harness"

// Roots describes the XDG-managed directories used by the harness.
type Roots struct {
	StateRoot   string
	Workstreams string
	Runtime     string
	ShareRoot   string
	Worktrees   string
}

// DefaultRoots resolves the default state and share directories for the harness.
func DefaultRoots() Roots {
	stateHome := envOrDefault("XDG_STATE_HOME", filepath.Join(userHomeDir(), ".local", "state"))
	dataHome := envOrDefault("XDG_DATA_HOME", filepath.Join(userHomeDir(), ".local", "share"))

	stateRoot := filepath.Join(stateHome, appName)
	return Roots{
		StateRoot:   stateRoot,
		Workstreams: filepath.Join(stateRoot, "workstreams"),
		Runtime:     filepath.Join(stateRoot, "runtime"),
		ShareRoot:   filepath.Join(dataHome, appName),
		Worktrees:   filepath.Join(dataHome, appName, "worktrees"),
	}
}

func envOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func userHomeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return home
}
