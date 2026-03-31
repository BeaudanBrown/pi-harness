package runtime

import (
	"testing"

	"github.com/beaudanbrown/pi-harness/internal/paths"
)

func TestExtensionEnv(t *testing.T) {
	roots := paths.Roots{
		Runtime: "/tmp/state/pi-harness/runtime",
	}

	got, err := ExtensionEnv(roots, "focus-bugfix", "ph:focus-bugfix")
	if err != nil {
		t.Fatalf("ExtensionEnv() error = %v", err)
	}

	want := []string{
		"PI_HARNESS_WORKSTREAM_ID=focus-bugfix",
		"PI_HARNESS_RUNTIME_DIR=/tmp/state/pi-harness/runtime",
		"PI_HARNESS_TMUX_SESSION=ph:focus-bugfix",
	}
	if len(got) != len(want) {
		t.Fatalf("ExtensionEnv() len = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("ExtensionEnv()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestExtensionEnvRejectsInvalidMetadata(t *testing.T) {
	roots := paths.Roots{
		Runtime: "/tmp/state/pi-harness/runtime",
	}

	if _, err := ExtensionEnv(roots, "Bad ID", "ph:Bad ID"); err == nil {
		t.Fatal("ExtensionEnv() error = nil, want invalid workstream id error")
	}
	if _, err := ExtensionEnv(roots, "focus-bugfix", "focus-bugfix"); err == nil {
		t.Fatal("ExtensionEnv() error = nil, want invalid tmux session error")
	}
}
