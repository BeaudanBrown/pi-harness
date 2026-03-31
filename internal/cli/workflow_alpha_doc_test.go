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
		"## Scenario Matrix",
		"| Zero-context workstream | `ph new workflow-alpha` | Creates the workstream, switches into `ph:<workstream-id>`, and keeps the attachment summary at `no paths` until a context is added. |",
		"| Outside-tmux menu entry | `ph menu` from a shell outside tmux | Prints `Outside tmux: joining the shared default tmux session, then opening the workstream menu.` and opens the popup in the shared `default` tmux session. |",
		"| Git-backed attachment | `ph add-context <workstream-id> /home/beau/host/projects/pi-harness` | Attaches the repo through isolated-by-default git-backed behavior and reports the new context id plus target path. |",
		"| Plain-directory attachment | `ph add-context <workstream-id> /tmp/workflow-alpha-notes` | Attaches the directory directly without requiring git metadata or worktree provisioning. |",
		"| Reattach inside tmux | `ph attach <workstream-id>` after switching away | Returns the operator to the requested `ph:<workstream-id>` session by exact workstream id. |",
		"| Reattach from outside tmux | `ph attach <workstream-id>` from a shell outside tmux | Prints `Outside tmux: joining tmux and attaching <workstream-id> (ph:<workstream-id>).` and lands directly in the requested workstream session. |",
		"ph new workflow-alpha",
		"ph attach <workstream-id>",
		"ph add-context <workstream-id> /home/beau/host/projects/pi-harness",
		"ph menu",
		"created <workstream-id> (ph:<workstream-id>)",
		"bootstrapped <workstream-id> (ph:<workstream-id>)",
		"attached <context-id> to <workstream-id> at <path> (...)",
		"tmux popup selector opens",
		"workflow-alpha       waiting     Workflow Alpha       no paths",
		"workflow-alpha-peer  processing  Workflow Alpha Peer  2 paths",
		"ID                  STATUS      TITLE                ATTACHMENTS",
		"Outside tmux: joining the shared default tmux session, then opening the workstream menu.",
		"Outside tmux: joining tmux and attaching <workstream-id> (ph:<workstream-id>).",
	}

	for _, snippet := range requiredSnippets {
		if !strings.Contains(doc, snippet) {
			t.Fatalf("transcript missing %q", snippet)
		}
	}
}
