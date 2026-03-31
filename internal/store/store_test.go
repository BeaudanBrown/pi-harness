package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
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

func TestReadShareRegistryNormalizesAndSortsProjects(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shares.json")
	if err := os.WriteFile(path, []byte(`[
  {
    "agentPath": " projects/zeta ",
    "sourcePath": " /srv/repos/../repos/zeta ",
    "hostPath": " /home/beau/agent/projects/../projects/zeta ",
    "guestPath": " /home/beau/host/projects/../projects/zeta "
  },
  {
    "agentPath": "projects/alpha",
    "sourcePath": "/srv/repos/alpha",
    "hostPath": "/home/beau/agent/projects/alpha",
    "guestPath": "/home/beau/host/projects/alpha"
  }
]`), 0o644); err != nil {
		t.Fatalf("WriteFile(shares) error = %v", err)
	}

	projects, err := ReadShareRegistry(path)
	if err != nil {
		t.Fatalf("ReadShareRegistry() error = %v", err)
	}
	if len(projects) != 2 {
		t.Fatalf("len(projects) = %d, want 2", len(projects))
	}
	if projects[0].AgentPath != "projects/alpha" || projects[0].GuestPath != "/home/beau/host/projects/alpha" {
		t.Fatalf("projects[0] = %#v, want sorted normalized alpha entry", projects[0])
	}
	if projects[1].AgentPath != "projects/zeta" || projects[1].SourcePath != "/srv/repos/zeta" {
		t.Fatalf("projects[1] = %#v, want normalized zeta entry", projects[1])
	}
}

func TestReadShareRegistryReportsEntryValidationFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shares.json")
	if err := os.WriteFile(path, []byte(`[
  {
    "agentPath": "/projects/bad",
    "sourcePath": "/srv/repos/bad",
    "hostPath": "/home/beau/agent/projects/bad",
    "guestPath": "/home/beau/host/projects/bad"
  }
]`), 0o644); err != nil {
		t.Fatalf("WriteFile(shares) error = %v", err)
	}

	_, err := ReadShareRegistry(path)
	if err == nil {
		t.Fatal("ReadShareRegistry() error = nil, want validation error")
	}
	if got := err.Error(); got == "" || !containsAll(got, []string{"read share registry", "entry 0", "agentPath", "relative"}) {
		t.Fatalf("ReadShareRegistry() error = %q, want clear validation details", got)
	}
}

func TestReadShareRegistryReportsDecodeFailureClearly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shares.json")
	if err := os.WriteFile(path, []byte(`{"agentPath":"projects/alpha"}`), 0o644); err != nil {
		t.Fatalf("WriteFile(shares) error = %v", err)
	}

	_, err := ReadShareRegistry(path)
	if err == nil {
		t.Fatal("ReadShareRegistry() error = nil, want decode error")
	}
	if got := err.Error(); got == "" || !containsAll(got, []string{"read share registry", "decode", path}) {
		t.Fatalf("ReadShareRegistry() error = %q, want clear decode details", got)
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

func containsAll(value string, expected []string) bool {
	for _, fragment := range expected {
		if !strings.Contains(value, fragment) {
			return false
		}
	}
	return true
}
