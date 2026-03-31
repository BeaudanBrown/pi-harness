package cli

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWorkstreamSwitcherSpecIncludesRecoveryNamingSketch(t *testing.T) {
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
		"### Naming Sketch",
		"| Concern | Preferred path | Alternate to keep in mind | Why this shape fits |",
		"| inspection | `ph doctor` | `ph inspect` |",
		"| dead-session repair | `ph repair session <workstream>` | `ph revive <workstream>` |",
		"| stale runtime repair | `ph repair runtime <workstream>` | `ph refresh-runtime <workstream>` |",
		"| cleanup and reclamation | `ph cleanup worktrees` / `ph cleanup runtime` | `ph prune <workstream>` |",
		"| deeper state repair | `ph repair manifest <workstream>` | `ph rebind <workstream>` |",
		"This sketch is exploratory, not a locked CLI contract.",
		"keep `doctor`, `repair`, and `cleanup` as the main top-level verbs",
	}

	for _, snippet := range requiredSnippets {
		if !strings.Contains(doc, snippet) {
			t.Fatalf("workstream switcher spec missing recovery naming snippet %q", snippet)
		}
	}
}
