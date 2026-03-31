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

func TestRootsDerivedPaths(t *testing.T) {
	roots := Roots{
		Workstreams: "/tmp/state/pi-harness/workstreams",
		Runtime:     "/tmp/state/pi-harness/runtime",
		Worktrees:   "/tmp/share/pi-harness/worktrees",
	}

	if got := roots.ManifestPath("focus-bugfix"); got != "/tmp/state/pi-harness/workstreams/focus-bugfix.json" {
		t.Fatalf("ManifestPath() = %q", got)
	}
	if got := roots.RuntimePath("focus-bugfix"); got != "/tmp/state/pi-harness/runtime/focus-bugfix.json" {
		t.Fatalf("RuntimePath() = %q", got)
	}
	if got := roots.WorktreePath("focus-bugfix", "ctx-main"); got != "/tmp/share/pi-harness/worktrees/focus-bugfix/ctx-main" {
		t.Fatalf("WorktreePath() = %q", got)
	}
}

func TestGenerateWorkstreamID(t *testing.T) {
	existing := map[string]struct{}{
		"fix-bug":   {},
		"fix-bug-2": {},
	}

	if got := GenerateWorkstreamID("Fix bug", existing); got != "fix-bug-3" {
		t.Fatalf("GenerateWorkstreamID() = %q, want %q", got, "fix-bug-3")
	}
	if got := GenerateWorkstreamID("   ", nil); got != "workstream" {
		t.Fatalf("GenerateWorkstreamID() = %q, want %q", got, "workstream")
	}
}

func TestTmuxSessionName(t *testing.T) {
	if got := TmuxSessionName("focus-bugfix"); got != "ph:focus-bugfix" {
		t.Fatalf("TmuxSessionName() = %q, want %q", got, "ph:focus-bugfix")
	}
}

func TestShareRegistryPathUsesOverride(t *testing.T) {
	t.Setenv("PI_HARNESS_SHARE_REGISTRY", "/tmp/custom-shares.json")

	if got := ShareRegistryPath(); got != "/tmp/custom-shares.json" {
		t.Fatalf("ShareRegistryPath() = %q, want %q", got, "/tmp/custom-shares.json")
	}
}
