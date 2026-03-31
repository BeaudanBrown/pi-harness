package cli

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPiHubDataModelIncludesDerivedRuntimeScenarioTable(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller(0) = !ok")
	}

	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(filename), "..", ".."))
	path := filepath.Join(repoRoot, "docs", "pi-hub-data-model.md")

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", path, err)
	}
	doc := string(data)

	requiredSnippets := []string{
		"### Derived Runtime Examples",
		"| Scenario | tmux session live? | Runtime file | Freshness | Derived status | Why |",
		"| Manifest exists but tmux session is gone | no | valid or missing | any | `dead` | missing tmux session wins even if an old runtime file still exists |",
		"| tmux session exists but no runtime file exists yet | yes | missing | n/a | `unknown` | the harness cannot trust a live processing-vs-idle state without a runtime record |",
		"| tmux session exists but the runtime file cannot be opened or read | yes | unreadable | n/a | `unknown` | the runtime artifact exists but is not trustworthy input |",
		"| tmux session exists but the runtime file fails schema validation | yes | schema-incompatible | n/a | `unknown` | v1 trusts only runtime files that decode and validate cleanly |",
		"| tmux session exists and the newest trusted runtime file is older than 12 hours | yes | valid | older than 12h | `unknown` | the stale-file cutoff overrides stale `idle` or `processing` signals |",
	}

	for _, snippet := range requiredSnippets {
		if !strings.Contains(doc, snippet) {
			t.Fatalf("pi hub data model missing runtime scenario snippet %q", snippet)
		}
	}
}
