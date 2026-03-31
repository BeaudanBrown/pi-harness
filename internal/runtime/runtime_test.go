package runtime

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/beaudanbrown/pi-harness/internal/models"
	"github.com/beaudanbrown/pi-harness/internal/paths"
	"github.com/beaudanbrown/pi-harness/internal/store"
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

func TestGetDerivesUnknownWhenTmuxExistsWithoutRuntime(t *testing.T) {
	roots := testRoots(t)
	s := store.New(roots)
	mustWriteManifest(t, s, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "focus-bugfix",
		Title:         "Focus bugfix",
		TmuxSession:   "ph:focus-bugfix",
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:05:00Z",
		Contexts:      []models.WorkstreamContext{},
	})

	service := New(roots, fakeSessions{live: map[string]bool{"ph:focus-bugfix": true}})
	row, err := service.Get(context.Background(), "focus-bugfix")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}

	if row.Status != models.RuntimeStateUnknown {
		t.Fatalf("row.Status = %q, want unknown", row.Status)
	}
	if row.RuntimeSource != RuntimeSourceMissing {
		t.Fatalf("row.RuntimeSource = %q, want missing", row.RuntimeSource)
	}
}

func TestGetDerivesDeadWhenTmuxSessionMissing(t *testing.T) {
	roots := testRoots(t)
	s := store.New(roots)
	mustWriteManifest(t, s, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "focus-bugfix",
		Title:         "Focus bugfix",
		TmuxSession:   "ph:focus-bugfix",
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:05:00Z",
		Contexts:      []models.WorkstreamContext{},
	})
	mustWriteRuntime(t, s, models.RuntimeStatus{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "focus-bugfix",
		TmuxSession:   "ph:focus-bugfix",
		State:         models.RuntimeStateProcessing,
		CWD:           "/tmp/project",
		LastSeenAt:    "2026-03-31T01:06:00Z",
	})

	service := New(roots, fakeSessions{})
	row, err := service.Get(context.Background(), "focus-bugfix")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}

	if row.Status != models.RuntimeStateDead {
		t.Fatalf("row.Status = %q, want dead", row.Status)
	}
	if row.Runtime == nil || row.Runtime.State != models.RuntimeStateProcessing {
		t.Fatalf("row.Runtime = %#v, want preserved runtime record", row.Runtime)
	}
}

func TestGetMarksInvalidRuntimeAsUnknown(t *testing.T) {
	roots := testRoots(t)
	s := store.New(roots)
	mustWriteManifest(t, s, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "focus-bugfix",
		Title:         "Focus bugfix",
		TmuxSession:   "ph:focus-bugfix",
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:05:00Z",
		Contexts:      []models.WorkstreamContext{},
	})

	runtimePath := roots.RuntimePath("focus-bugfix")
	if err := writeInvalidRuntime(runtimePath); err != nil {
		t.Fatalf("writeInvalidRuntime() error = %v", err)
	}

	service := New(roots, fakeSessions{live: map[string]bool{"ph:focus-bugfix": true}})
	row, err := service.Get(context.Background(), "focus-bugfix")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}

	if row.Status != models.RuntimeStateUnknown {
		t.Fatalf("row.Status = %q, want unknown", row.Status)
	}
	if row.RuntimeSource != RuntimeSourceInvalid {
		t.Fatalf("row.RuntimeSource = %q, want invalid", row.RuntimeSource)
	}
	if row.RuntimeError == "" {
		t.Fatal("row.RuntimeError = empty, want decode/validate detail")
	}
}

func TestGetPropagatesTmuxErrors(t *testing.T) {
	roots := testRoots(t)
	s := store.New(roots)
	mustWriteManifest(t, s, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "focus-bugfix",
		Title:         "Focus bugfix",
		TmuxSession:   "ph:focus-bugfix",
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:05:00Z",
		Contexts:      []models.WorkstreamContext{},
	})

	service := New(roots, fakeSessions{err: errors.New("tmux unavailable")})
	if _, err := service.Get(context.Background(), "focus-bugfix"); err == nil {
		t.Fatal("Get() error = nil, want tmux error")
	}
}

type fakeSessions struct {
	live map[string]bool
	err  error
}

func (f fakeSessions) HasSession(_ context.Context, session string) (bool, error) {
	if f.err != nil {
		return false, f.err
	}
	return f.live[session], nil
}

func testRoots(t *testing.T) paths.Roots {
	t.Helper()
	base := t.TempDir()
	return paths.Roots{
		StateRoot:   filepath.Join(base, "state", "pi-harness"),
		Workstreams: filepath.Join(base, "state", "pi-harness", "workstreams"),
		Runtime:     filepath.Join(base, "state", "pi-harness", "runtime"),
		ShareRoot:   filepath.Join(base, "share", "pi-harness"),
		Worktrees:   filepath.Join(base, "share", "pi-harness", "worktrees"),
	}
}

func mustWriteManifest(t *testing.T, s store.Store, record models.WorkstreamRecord) {
	t.Helper()
	if err := s.WriteManifest(record); err != nil {
		t.Fatalf("WriteManifest() error = %v", err)
	}
}

func mustWriteRuntime(t *testing.T, s store.Store, status models.RuntimeStatus) {
	t.Helper()
	if err := s.WriteRuntime(status); err != nil {
		t.Fatalf("WriteRuntime() error = %v", err)
	}
}

func writeInvalidRuntime(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte("{\"schemaVersion\":1,\"workstreamId\":\"focus-bugfix\",\"tmuxSession\":\"ph:focus-bugfix\",\"state\":\"dead\",\"cwd\":\"/tmp/project\",\"lastSeenAt\":\"2026-03-31T01:06:00Z\"}\n"), 0o644)
}
