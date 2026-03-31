package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/beaudanbrown/pi-harness/internal/models"
	"github.com/beaudanbrown/pi-harness/internal/paths"
)

func TestWriteAndReadManifest(t *testing.T) {
	store := New(testRoots(t))
	record := models.WorkstreamRecord{
		SchemaVersion:    models.CurrentSchemaVersion,
		WorkstreamID:     "focus-bugfix",
		Title:            "Focus bugfix",
		TmuxSession:      paths.TmuxSessionName("focus-bugfix"),
		CreatedAt:        "2026-03-31T01:00:00Z",
		UpdatedAt:        "2026-03-31T01:05:00Z",
		PrimaryContextID: "ctx-main",
		Contexts: []models.WorkstreamContext{
			{
				ContextID:   "ctx-main",
				DisplayName: "Main checkout",
				Path:        "/tmp/project",
				Kind:        models.ContextKindWorktree,
				Mode:        models.ContextModeIsolated,
				Role:        models.ContextRolePrimary,
			},
		},
		Notes: "Tracked locally",
	}

	if err := store.WriteManifest(record); err != nil {
		t.Fatalf("WriteManifest() error = %v", err)
	}

	got, err := store.ReadManifest(record.WorkstreamID)
	if err != nil {
		t.Fatalf("ReadManifest() error = %v", err)
	}
	if got.Title != record.Title {
		t.Fatalf("ReadManifest().Title = %q, want %q", got.Title, record.Title)
	}

	data, err := os.ReadFile(store.Roots.ManifestPath(record.WorkstreamID))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if len(data) == 0 || data[len(data)-1] != '\n' {
		t.Fatal("manifest file should contain encoded JSON with trailing newline")
	}
}

func TestWriteAndReadRuntime(t *testing.T) {
	store := New(testRoots(t))
	status := models.RuntimeStatus{
		SchemaVersion:    models.CurrentSchemaVersion,
		WorkstreamID:     "focus-bugfix",
		TmuxSession:      paths.TmuxSessionName("focus-bugfix"),
		State:            models.RuntimeStateIdle,
		CWD:              "/tmp/project",
		LastSeenAt:       "2026-03-31T01:05:00Z",
		LastProcessingAt: "2026-03-31T01:03:00Z",
		ActiveModel:      "gpt-5.4",
	}

	if err := store.WriteRuntime(status); err != nil {
		t.Fatalf("WriteRuntime() error = %v", err)
	}

	got, err := store.ReadRuntime(status.WorkstreamID)
	if err != nil {
		t.Fatalf("ReadRuntime() error = %v", err)
	}
	if got.State != status.State {
		t.Fatalf("ReadRuntime().State = %q, want %q", got.State, status.State)
	}
}

func TestReadManifestRejectsUnknownFields(t *testing.T) {
	store := New(testRoots(t))
	path := store.Roots.ManifestPath("focus-bugfix")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(path, []byte("{\"schemaVersion\":1,\"workstreamId\":\"focus-bugfix\",\"title\":\"Focus bugfix\",\"tmuxSession\":\"ph:focus-bugfix\",\"createdAt\":\"2026-03-31T01:00:00Z\",\"updatedAt\":\"2026-03-31T01:05:00Z\",\"contexts\":[],\"notes\":\"\",\"extra\":true}\n"), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	if _, err := store.ReadManifest("focus-bugfix"); err == nil {
		t.Fatal("ReadManifest() error = nil, want unknown field error")
	}
}

func TestWriteManifestLeavesNoTempFiles(t *testing.T) {
	store := New(testRoots(t))
	record := models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "focus-bugfix",
		Title:         "Focus bugfix",
		TmuxSession:   paths.TmuxSessionName("focus-bugfix"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:05:00Z",
		Contexts:      []models.WorkstreamContext{},
	}

	if err := store.WriteManifest(record); err != nil {
		t.Fatalf("WriteManifest() error = %v", err)
	}

	entries, err := os.ReadDir(store.Roots.Workstreams)
	if err != nil {
		t.Fatalf("ReadDir() error = %v", err)
	}
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) == ".tmp" {
			t.Fatalf("unexpected temp file left behind: %s", entry.Name())
		}
	}
}

func TestListWorkstreamIDs(t *testing.T) {
	store := New(testRoots(t))
	if err := store.WriteManifest(models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "alpha",
		Title:         "Alpha",
		TmuxSession:   paths.TmuxSessionName("alpha"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:00:00Z",
		Contexts:      []models.WorkstreamContext{},
	}); err != nil {
		t.Fatalf("WriteManifest(alpha) error = %v", err)
	}
	if err := store.WriteManifest(models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "beta",
		Title:         "Beta",
		TmuxSession:   paths.TmuxSessionName("beta"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:00:00Z",
		Contexts:      []models.WorkstreamContext{},
	}); err != nil {
		t.Fatalf("WriteManifest(beta) error = %v", err)
	}

	ids, err := store.ListWorkstreamIDs()
	if err != nil {
		t.Fatalf("ListWorkstreamIDs() error = %v", err)
	}
	if len(ids) != 2 {
		t.Fatalf("ListWorkstreamIDs() len = %d, want 2", len(ids))
	}
	if ids[0] != "alpha" || ids[1] != "beta" {
		t.Fatalf("ListWorkstreamIDs() = %v, want [alpha beta]", ids)
	}
}

func TestUpdateManifestWritesMutatedRecord(t *testing.T) {
	store := New(testRoots(t))
	record := models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "focus-bugfix",
		Title:         "Focus bugfix",
		TmuxSession:   paths.TmuxSessionName("focus-bugfix"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:05:00Z",
		Contexts:      []models.WorkstreamContext{},
	}
	if err := store.WriteManifest(record); err != nil {
		t.Fatalf("WriteManifest() error = %v", err)
	}

	updated, err := store.UpdateManifest(record.WorkstreamID, func(record *models.WorkstreamRecord) error {
		record.Title = "Focus bugfix v2"
		record.UpdatedAt = "2026-03-31T01:06:00Z"
		return nil
	})
	if err != nil {
		t.Fatalf("UpdateManifest() error = %v", err)
	}
	if updated.Title != "Focus bugfix v2" {
		t.Fatalf("UpdateManifest().Title = %q, want %q", updated.Title, "Focus bugfix v2")
	}

	reread, err := store.ReadManifest(record.WorkstreamID)
	if err != nil {
		t.Fatalf("ReadManifest() error = %v", err)
	}
	if reread.Title != "Focus bugfix v2" {
		t.Fatalf("ReadManifest().Title = %q, want %q", reread.Title, "Focus bugfix v2")
	}
}

func TestUpdateManifestLeavesStoredRecordOnFailure(t *testing.T) {
	store := New(testRoots(t))
	record := models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "focus-bugfix",
		Title:         "Focus bugfix",
		TmuxSession:   paths.TmuxSessionName("focus-bugfix"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:05:00Z",
		Contexts:      []models.WorkstreamContext{},
	}
	if err := store.WriteManifest(record); err != nil {
		t.Fatalf("WriteManifest() error = %v", err)
	}

	wantErr := errors.New("stop")
	if _, err := store.UpdateManifest(record.WorkstreamID, func(record *models.WorkstreamRecord) error {
		record.Title = ""
		return wantErr
	}); !errors.Is(err, wantErr) {
		t.Fatalf("UpdateManifest() error = %v, want %v", err, wantErr)
	}

	reread, err := store.ReadManifest(record.WorkstreamID)
	if err != nil {
		t.Fatalf("ReadManifest() error = %v", err)
	}
	if reread.Title != "Focus bugfix" {
		t.Fatalf("ReadManifest().Title = %q, want original title", reread.Title)
	}
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
