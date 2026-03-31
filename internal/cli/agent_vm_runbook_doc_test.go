package cli

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestAgentVMVerificationRunbookCoversManualWorktreeCleanupBoundary(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller(0) = !ok")
	}

	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(filename), "..", ".."))
	path := filepath.Join(repoRoot, "docs", "agent-vm-verification-runbook.md")

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", path, err)
	}
	doc := string(data)

	requiredSnippets := []string{
		"### 8. Confirm the harness-owned isolated worktree path exists",
		"this harness-owned path is the only cleanup candidate if the isolated context is retired later",
		"in v1, removing the context does not remove the worktree automatically",
		"do not treat `/home/beau/host/projects/pi-harness` as disposable cleanup state for detach",
		"prefer `git worktree remove` from the source checkout over `rm -rf`",
	}

	for _, snippet := range requiredSnippets {
		if !strings.Contains(doc, snippet) {
			t.Fatalf("agent VM verification runbook missing %q", snippet)
		}
	}
}
