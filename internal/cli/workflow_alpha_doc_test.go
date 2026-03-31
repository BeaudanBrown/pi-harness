package cli

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWorkflowAlphaTranscriptCoversRequiredCommandSequence(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller(0) = !ok")
	}

	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(filename), "..", ".."))
	path := filepath.Join(repoRoot, "docs", "workflow-alpha-command-transcript.md")

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", path, err)
	}
	doc := string(data)

	requiredSnippets := []string{
		"# Workflow Alpha Command Transcript Skeleton",
		"ssh agent",
		"ph new workflow-alpha",
		"ph attach <workstream-id>",
		"ph add-context <workstream-id> /home/beau/host/projects/pi-harness",
		"ph menu",
		"created <workstream-id> (ph:<workstream-id>)",
		"bootstrapped <workstream-id> (ph:<workstream-id>)",
		"attached <context-id> to <workstream-id> at <path> (...)",
		"tmux popup selector opens",
	}

	for _, snippet := range requiredSnippets {
		if !strings.Contains(doc, snippet) {
			t.Fatalf("transcript missing %q", snippet)
		}
	}
}
