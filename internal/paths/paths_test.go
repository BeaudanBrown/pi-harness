package paths

import "testing"

func TestDefaultRootsUsesXDGOverrides(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", "/tmp/state")
	t.Setenv("XDG_DATA_HOME", "/tmp/share")

	roots := DefaultRoots()

	if roots.Workstreams != "/tmp/state/pi-harness/workstreams" {
		t.Fatalf("Workstreams = %q, want %q", roots.Workstreams, "/tmp/state/pi-harness/workstreams")
	}
	if roots.Runtime != "/tmp/state/pi-harness/runtime" {
		t.Fatalf("Runtime = %q, want %q", roots.Runtime, "/tmp/state/pi-harness/runtime")
	}
	if roots.Worktrees != "/tmp/share/pi-harness/worktrees" {
		t.Fatalf("Worktrees = %q, want %q", roots.Worktrees, "/tmp/share/pi-harness/worktrees")
	}
}
