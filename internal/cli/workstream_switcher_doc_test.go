package cli

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWorkstreamSwitcherSpecIncludesAttachmentSummaryExamples(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller(0) = !ok")
	}

	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(filename), "..", ".."))
	path := filepath.Join(repoRoot, "docs", "workstream-switcher-v1.md")

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", path, err)
	}
	doc := string(data)

	requiredSnippets := []string{
		"Attachment summary rules for both `ph list` and `ph menu`:",
		"alpha   waiting     Inbox triage           no paths",
		"beta    processing  Metadata import        Pi harness repo",
		"gamma   unknown     Session switcher docs  2 paths",
		"ph menu",
		"ph list",
		"intentionally not naming any one of them as",
		"That 12-hour cutoff is a v1 operator tradeoff:",
		"without turning healthy sessions into `unknown` too quickly",
		"current `idle` or `processing` signal",
	}

	for _, snippet := range requiredSnippets {
		if !strings.Contains(doc, snippet) {
			t.Fatalf("workstream switcher spec missing %q", snippet)
		}
	}
}
