package paths

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
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

// ManifestPath returns the durable workstream manifest path for one workstream.
func (roots Roots) ManifestPath(workstreamID string) string {
	return filepath.Join(roots.Workstreams, workstreamID+".json")
}

// RuntimePath returns the runtime status path for one workstream.
func (roots Roots) RuntimePath(workstreamID string) string {
	return filepath.Join(roots.Runtime, workstreamID+".json")
}

// WorktreePath returns the isolated worktree root for one workstream context.
func (roots Roots) WorktreePath(workstreamID, contextID string) string {
	return filepath.Join(roots.Worktrees, workstreamID, contextID)
}

// TmuxSessionName derives the harness-owned tmux session name.
func TmuxSessionName(workstreamID string) string {
	return "ph:" + workstreamID
}

// GenerateWorkstreamID creates a stable slug and disambiguates against existing ids.
func GenerateWorkstreamID(title string, existingIDs map[string]struct{}) string {
	base := slugify(title)
	if base == "" {
		base = "workstream"
	}
	if _, exists := existingIDs[base]; !exists {
		return base
	}
	for suffix := 2; ; suffix++ {
		candidate := base + "-" + strconv.Itoa(suffix)
		if _, exists := existingIDs[candidate]; !exists {
			return candidate
		}
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

func slugify(title string) string {
	var b strings.Builder
	lastHyphen := true
	for _, r := range strings.ToLower(title) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
			lastHyphen = false
		case !lastHyphen:
			b.WriteByte('-')
			lastHyphen = true
		}
	}
	return strings.Trim(b.String(), "-")
}
