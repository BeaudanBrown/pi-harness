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
		"Outside tmux: joining the shared default tmux session, then opening the workstream menu.",
		"After bootstrap, the operator lands in the shared `default` tmux session with the popup open there.",
		"Outside tmux: joining tmux and attaching <workstream-id> (ph:<workstream-id>).",
		"After bootstrap, the operator lands directly in the requested workstream session.",
		"### Attach And Menu Entry Table",
		"| `ph menu` | inside a tmux client | no tmux bootstrap; open the popup in the current client |",
		"| `ph menu` | outside tmux after the normal `ssh agent` entrypoint | join the shared `default` tmux session first, then open the popup there |",
		"| `ph menu` | outside tmux from any other shell in the VM | same as the default `ssh agent` path: join the shared `default` tmux session first, then open the popup there |",
		"| `ph attach <workstream-id>` | inside a tmux client | no shared-session bootstrap; switch the current client directly into `ph:<workstream-id>` |",
		"| `ph attach <workstream-id>` | outside tmux after the normal `ssh agent` entrypoint | join tmux and attach straight to `ph:<workstream-id>` instead of stopping in `default` first |",
		"| `ph attach <workstream-id>` | outside tmux from any other shell in the VM | same as the default `ssh agent` path: join tmux and attach straight to `ph:<workstream-id>` |",
		"`ph menu` outside tmux always uses the shared `default` tmux session as the",
		"`ph attach` outside tmux always lands directly in the requested workstream",
	}

	for _, snippet := range requiredSnippets {
		if !strings.Contains(doc, snippet) {
			t.Fatalf("workstream switcher spec missing %q", snippet)
		}
	}
}
