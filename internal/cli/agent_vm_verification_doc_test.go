package cli

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestAgentVMVerificationPrerequisitesDocCoversRequiredSetup(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller(0) = !ok")
	}

	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(filename), "..", ".."))
	path := filepath.Join(repoRoot, "docs", "agent-vm-verification-prerequisites.md")

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", path, err)
	}
	doc := string(data)

	requiredSnippets := []string{
		"# Agent VM Verification Prerequisites",
		"sudo agent-share add ~/documents/projects/pi-harness projects/pi-harness",
		"/home/beau/host/.pi-hub/shares.json",
		"/home/beau/host/projects/pi-harness",
		"/home/beau/projects/pi-harness",
		"~/.local/share/pi-harness/worktrees/<workstream-id>/<context-id>/",
		"~/.local/state/pi-harness/workstreams/",
		"~/.local/state/pi-harness/runtime/",
		"the normal interactive path should attach to the shared `default` tmux",
		"one tmux session per workstream",
		"`ph menu` or `ph attach <workstream-id>` from a shell outside tmux",
		"`ph` or `pi-harness` in `PATH`",
		"`tmux`",
		"`fzf`",
		"`git`",
		"`nix`",
		"`fzf` is a required runtime dependency for the popup selector.",
		"`./bin/pi-harness`",
		"command -v ph",
		"command -v tmux",
		"command -v fzf",
		"test -f /home/beau/host/.pi-hub/shares.json",
		"nix run .#verify",
	}

	for _, snippet := range requiredSnippets {
		if !strings.Contains(doc, snippet) {
			t.Fatalf("agent VM verification prerequisites doc missing %q", snippet)
		}
	}
}
