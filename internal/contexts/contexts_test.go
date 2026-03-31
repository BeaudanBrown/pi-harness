package contexts

import (
	"strings"
	"testing"
	"time"

	"github.com/beaudanbrown/pi-harness/internal/models"
	"github.com/beaudanbrown/pi-harness/internal/paths"
	"github.com/beaudanbrown/pi-harness/internal/store"
)

func TestAddContextPromotesRequestedPrimary(t *testing.T) {
	s := store.New(testRoots(t))
	mgr := New(s, fixedNow())
	mustWriteManifest(t, s, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "alpha",
		Title:         "Alpha",
		TmuxSession:   paths.TmuxSessionName("alpha"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:00:00Z",
		Contexts: []models.WorkstreamContext{
			{
				ContextID:   "ctx-old",
				DisplayName: "Old",
				Path:        "/tmp/old",
				Kind:        models.ContextKindCheckout,
				Mode:        models.ContextModeIsolated,
				Role:        models.ContextRolePrimary,
			},
		},
		PrimaryContextID: "ctx-old",
	})

	record, err := mgr.AddContext("alpha", AddInput{
		ContextID:   "ctx-new",
		DisplayName: "New",
		Path:        "/tmp/new",
		Kind:        models.ContextKindWorktree,
		Mode:        models.ContextModeIsolated,
		Role:        models.ContextRolePrimary,
	})
	if err != nil {
		t.Fatalf("AddContext() error = %v", err)
	}

	if record.PrimaryContextID != "ctx-new" {
		t.Fatalf("PrimaryContextID = %q, want %q", record.PrimaryContextID, "ctx-new")
	}
	if record.UpdatedAt != "2026-03-31T02:00:00Z" {
		t.Fatalf("UpdatedAt = %q, want fixed timestamp", record.UpdatedAt)
	}
	if record.Contexts[0].Role != models.ContextRoleSecondary {
		t.Fatalf("old context role = %q, want secondary", record.Contexts[0].Role)
	}
	if record.Contexts[1].Role != models.ContextRolePrimary {
		t.Fatalf("new context role = %q, want primary", record.Contexts[1].Role)
	}
}

func TestAddContextRejectsDuplicateNormalizedPath(t *testing.T) {
	s := store.New(testRoots(t))
	mgr := New(s, fixedNow())
	mustWriteManifest(t, s, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "alpha",
		Title:         "Alpha",
		TmuxSession:   paths.TmuxSessionName("alpha"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:00:00Z",
		Contexts: []models.WorkstreamContext{
			{
				ContextID:   "ctx-old",
				DisplayName: "Old",
				Path:        "/tmp/project",
				Kind:        models.ContextKindCheckout,
				Mode:        models.ContextModeIsolated,
				Role:        models.ContextRoleSecondary,
			},
		},
	})

	if _, err := mgr.AddContext("alpha", AddInput{
		ContextID:   "ctx-new",
		DisplayName: "New",
		Path:        "/tmp/../tmp/project",
		Kind:        models.ContextKindDirectory,
		Mode:        models.ContextModeSharedReadonly,
		Role:        models.ContextRoleSecondary,
	}); err == nil || !strings.Contains(err.Error(), "duplicated") {
		t.Fatalf("AddContext() error = %v, want duplicate path error", err)
	}

	record, err := s.ReadManifest("alpha")
	if err != nil {
		t.Fatalf("ReadManifest() error = %v", err)
	}
	if len(record.Contexts) != 1 {
		t.Fatalf("len(Contexts) = %d, want 1", len(record.Contexts))
	}
}

func TestUpdateContextCanPromoteAndDemotePrimaryExplicitly(t *testing.T) {
	s := store.New(testRoots(t))
	mgr := New(s, fixedNow())
	mustWriteManifest(t, s, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "alpha",
		Title:         "Alpha",
		TmuxSession:   paths.TmuxSessionName("alpha"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:00:00Z",
		Contexts: []models.WorkstreamContext{
			{
				ContextID:   "ctx-main",
				DisplayName: "Main",
				Path:        "/tmp/main",
				Kind:        models.ContextKindCheckout,
				Mode:        models.ContextModeIsolated,
				Role:        models.ContextRolePrimary,
			},
			{
				ContextID:   "ctx-side",
				DisplayName: "Side",
				Path:        "/tmp/side",
				Kind:        models.ContextKindDirectory,
				Mode:        models.ContextModeSharedReadonly,
				Role:        models.ContextRoleSecondary,
			},
		},
		PrimaryContextID: "ctx-main",
	})

	primary := models.ContextRolePrimary
	record, err := mgr.UpdateContext("alpha", "ctx-side", UpdateInput{Role: &primary})
	if err != nil {
		t.Fatalf("UpdateContext(promote) error = %v", err)
	}
	if record.PrimaryContextID != "ctx-side" {
		t.Fatalf("PrimaryContextID after promote = %q, want ctx-side", record.PrimaryContextID)
	}

	secondary := models.ContextRoleSecondary
	record, err = mgr.UpdateContext("alpha", "ctx-side", UpdateInput{Role: &secondary})
	if err != nil {
		t.Fatalf("UpdateContext(demote) error = %v", err)
	}
	if record.PrimaryContextID != "" {
		t.Fatalf("PrimaryContextID after demote = %q, want empty", record.PrimaryContextID)
	}
}

func TestUpdateContextRejectsInvalidModeAndPreservesManifest(t *testing.T) {
	s := store.New(testRoots(t))
	mgr := New(s, fixedNow())
	mustWriteManifest(t, s, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "alpha",
		Title:         "Alpha",
		TmuxSession:   paths.TmuxSessionName("alpha"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:00:00Z",
		Contexts: []models.WorkstreamContext{
			{
				ContextID:   "ctx-main",
				DisplayName: "Main",
				Path:        "/tmp/main",
				Kind:        models.ContextKindCheckout,
				Mode:        models.ContextModeIsolated,
				Role:        models.ContextRoleSecondary,
			},
		},
	})

	mode := "broken"
	if _, err := mgr.UpdateContext("alpha", "ctx-main", UpdateInput{Mode: &mode}); err == nil {
		t.Fatal("UpdateContext() error = nil, want invalid mode error")
	}

	record, err := s.ReadManifest("alpha")
	if err != nil {
		t.Fatalf("ReadManifest() error = %v", err)
	}
	if record.Contexts[0].Mode != models.ContextModeIsolated {
		t.Fatalf("stored mode = %q, want original value", record.Contexts[0].Mode)
	}
}

func fixedNow() func() time.Time {
	return func() time.Time {
		return time.Date(2026, 3, 31, 2, 0, 0, 0, time.UTC)
	}
}

func mustWriteManifest(t *testing.T, s store.Store, record models.WorkstreamRecord) {
	t.Helper()
	if err := s.WriteManifest(record); err != nil {
		t.Fatalf("WriteManifest() error = %v", err)
	}
}

func testRoots(t *testing.T) paths.Roots {
	t.Helper()
	base := t.TempDir()
	return paths.Roots{
		StateRoot:   base + "/state/pi-harness",
		Workstreams: base + "/state/pi-harness/workstreams",
		Runtime:     base + "/state/pi-harness/runtime",
		ShareRoot:   base + "/share/pi-harness",
		Worktrees:   base + "/share/pi-harness/worktrees",
	}
}
