package contexts

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
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

func TestAttachGitWorktreeCreatesIsolatedAttachment(t *testing.T) {
	s := store.New(testRoots(t))
	mustWriteManifest(t, s, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "alpha",
		Title:         "Alpha",
		TmuxSession:   paths.TmuxSessionName("alpha"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:00:00Z",
		Contexts:      []models.WorkstreamContext{},
	})

	repoRoot := createGitRepo(t)
	attacher := NewAttacher(s.Roots, s, fixedNow())

	record, err := attacher.AttachGitWorktree(context.Background(), "alpha", AttachGitWorktreeInput{
		Path: repoRoot,
	})
	if err != nil {
		t.Fatalf("AttachGitWorktree() error = %v", err)
	}
	if len(record.Contexts) != 1 {
		t.Fatalf("len(Contexts) = %d, want 1", len(record.Contexts))
	}

	attached := record.Contexts[0]
	if attached.Path != s.Roots.WorktreePath("alpha", attached.ContextID) {
		t.Fatalf("attached path = %q, want worktree root path", attached.Path)
	}
	if attached.Path == repoRoot {
		t.Fatalf("attached path = source checkout %q, want isolated worktree path", attached.Path)
	}
	if attached.Kind != models.ContextKindWorktree {
		t.Fatalf("kind = %q, want worktree", attached.Kind)
	}
	if attached.Mode != models.ContextModeIsolated {
		t.Fatalf("mode = %q, want isolated", attached.Mode)
	}
	if attached.OwnerWorkstreamID != "alpha" {
		t.Fatalf("ownerWorkstreamId = %q, want alpha", attached.OwnerWorkstreamID)
	}
	if attached.Branch == "" {
		t.Fatal("branch = empty, want branch metadata")
	}
	if record.PrimaryContextID != attached.ContextID {
		t.Fatalf("PrimaryContextID = %q, want %q", record.PrimaryContextID, attached.ContextID)
	}

	if _, err := os.Stat(filepath.Join(attached.Path, ".git")); err != nil {
		t.Fatalf("worktree .git missing: %v", err)
	}
	if branch := gitOutput(t, attached.Path, "branch", "--show-current"); branch != attached.Branch {
		t.Fatalf("worktree branch = %q, want %q", branch, attached.Branch)
	}
}

func TestAttachGitWorktreeAddsDistinctWorktreesForSameRepo(t *testing.T) {
	s := store.New(testRoots(t))
	mustWriteManifest(t, s, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "alpha",
		Title:         "Alpha",
		TmuxSession:   paths.TmuxSessionName("alpha"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:00:00Z",
		Contexts:      []models.WorkstreamContext{},
	})

	repoRoot := createGitRepo(t)
	attacher := NewAttacher(s.Roots, s, fixedNow())

	first, err := attacher.AttachGitWorktree(context.Background(), "alpha", AttachGitWorktreeInput{Path: repoRoot})
	if err != nil {
		t.Fatalf("first AttachGitWorktree() error = %v", err)
	}
	second, err := attacher.AttachGitWorktree(context.Background(), "alpha", AttachGitWorktreeInput{Path: repoRoot})
	if err != nil {
		t.Fatalf("second AttachGitWorktree() error = %v", err)
	}

	if len(second.Contexts) != 2 {
		t.Fatalf("len(Contexts) = %d, want 2", len(second.Contexts))
	}
	if first.Contexts[0].Path == second.Contexts[1].Path {
		t.Fatalf("second path = %q, want a distinct worktree path", second.Contexts[1].Path)
	}
	if first.Contexts[0].Branch == second.Contexts[1].Branch {
		t.Fatalf("second branch = %q, want a distinct owned branch", second.Contexts[1].Branch)
	}
}

func TestAttachPathCreatesDirectDirectoryAttachment(t *testing.T) {
	s := store.New(testRoots(t))
	mustWriteManifest(t, s, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "alpha",
		Title:         "Alpha",
		TmuxSession:   paths.TmuxSessionName("alpha"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:00:00Z",
		Contexts:      []models.WorkstreamContext{},
	})

	dir := filepath.Join(t.TempDir(), "notes")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll(notes) error = %v", err)
	}

	attacher := NewAttacher(s.Roots, s, fixedNow())
	record, err := attacher.AttachPath(context.Background(), "alpha", AttachPathInput{
		Path: dir,
		Mode: models.ContextModeSharedReadonly,
	})
	if err != nil {
		t.Fatalf("AttachPath() error = %v", err)
	}

	attached := record.Contexts[0]
	if attached.Path != dir {
		t.Fatalf("attached path = %q, want %q", attached.Path, dir)
	}
	if attached.Kind != models.ContextKindDirectory {
		t.Fatalf("kind = %q, want directory", attached.Kind)
	}
	if attached.Mode != models.ContextModeSharedReadonly {
		t.Fatalf("mode = %q, want shared-readonly", attached.Mode)
	}
	if attached.OwnerWorkstreamID != "" {
		t.Fatalf("ownerWorkstreamId = %q, want empty", attached.OwnerWorkstreamID)
	}
	if attached.Branch != "" {
		t.Fatalf("branch = %q, want empty", attached.Branch)
	}
}

func TestAttachPathKeepsSharedGitCheckoutDirect(t *testing.T) {
	s := store.New(testRoots(t))
	mustWriteManifest(t, s, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "alpha",
		Title:         "Alpha",
		TmuxSession:   paths.TmuxSessionName("alpha"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:00:00Z",
		Contexts:      []models.WorkstreamContext{},
	})

	repoRoot := createGitRepo(t)
	attacher := NewAttacher(s.Roots, s, fixedNow())
	record, err := attacher.Attach(context.Background(), "alpha", AttachPathInput{
		Path: repoRoot,
		Mode: models.ContextModeSharedReadwrite,
	})
	if err != nil {
		t.Fatalf("Attach() error = %v", err)
	}

	attached := record.Contexts[0]
	if attached.Path != repoRoot {
		t.Fatalf("attached path = %q, want repo root %q", attached.Path, repoRoot)
	}
	if attached.Kind != models.ContextKindCheckout {
		t.Fatalf("kind = %q, want checkout", attached.Kind)
	}
	if attached.Mode != models.ContextModeSharedReadwrite {
		t.Fatalf("mode = %q, want shared-readwrite", attached.Mode)
	}
	if attached.OwnerWorkstreamID != "" {
		t.Fatalf("ownerWorkstreamId = %q, want empty", attached.OwnerWorkstreamID)
	}
	if attached.Branch != "" {
		t.Fatalf("branch = %q, want empty", attached.Branch)
	}
}

func TestAttachGitWorktreeRejectsSharedMode(t *testing.T) {
	s := store.New(testRoots(t))
	mustWriteManifest(t, s, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "alpha",
		Title:         "Alpha",
		TmuxSession:   paths.TmuxSessionName("alpha"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:00:00Z",
		Contexts:      []models.WorkstreamContext{},
	})

	repoRoot := createGitRepo(t)
	attacher := NewAttacher(s.Roots, s, fixedNow())
	if _, err := attacher.AttachGitWorktree(context.Background(), "alpha", AttachGitWorktreeInput{
		Path: repoRoot,
		Mode: models.ContextModeSharedReadwrite,
	}); err == nil {
		t.Fatal("AttachGitWorktree() error = nil, want shared-mode rejection")
	}

	record, err := s.ReadManifest("alpha")
	if err != nil {
		t.Fatalf("ReadManifest() error = %v", err)
	}
	if len(record.Contexts) != 0 {
		t.Fatalf("len(Contexts) = %d, want 0", len(record.Contexts))
	}
}

func TestShareAttachmentCandidatesUseGuestPathsOnly(t *testing.T) {
	s := store.New(testRoots(t))
	base := t.TempDir()
	repoPath := filepath.Join(base, "pi-harness")
	writeRepoMetadata(t, repoPath, "id: pi-harness\nname: Pi Harness\n")
	registryPath := filepath.Join(base, "shares.json")
	if err := os.WriteFile(registryPath, []byte(`[
  {
    "agentPath": "projects/pi-harness",
    "sourcePath": "/srv/repos/pi-harness",
    "hostPath": "/home/beau/agent/projects/pi-harness",
    "guestPath": "`+repoPath+`"
  }
]`), 0o644); err != nil {
		t.Fatalf("WriteFile(shares) error = %v", err)
	}

	attacher := NewAttacher(s.Roots, s, fixedNow())
	attacher.ShareRegistryPath = registryPath

	candidates, err := attacher.ShareAttachmentCandidates()
	if err != nil {
		t.Fatalf("ShareAttachmentCandidates() error = %v", err)
	}
	if len(candidates) != 1 {
		t.Fatalf("len(candidates) = %d, want 1", len(candidates))
	}
	if candidates[0].DisplayName != "Pi Harness" {
		t.Fatalf("DisplayName = %q, want metadata-backed label", candidates[0].DisplayName)
	}
	if candidates[0].Path != repoPath {
		t.Fatalf("Path = %q, want guest path", candidates[0].Path)
	}
	if candidates[0].Path == candidates[0].Share.SourcePath || candidates[0].Path == candidates[0].Share.HostPath {
		t.Fatalf("Path = %q, want guest path only", candidates[0].Path)
	}
	if candidates[0].MetadataImport == nil {
		t.Fatal("MetadataImport = nil, want surfaced metadata import")
	}
	if candidates[0].MetadataImport.Status != models.ProjectMetadataImportStatusLoaded {
		t.Fatalf("MetadataImport.Status = %q, want loaded", candidates[0].MetadataImport.Status)
	}
}

func TestShareAttachmentCandidatesSurfaceRegistryErrors(t *testing.T) {
	s := store.New(testRoots(t))
	registryPath := filepath.Join(t.TempDir(), "shares.json")
	if err := os.WriteFile(registryPath, []byte(`[
  {
    "agentPath": "/projects/bad",
    "sourcePath": "/srv/repos/bad",
    "hostPath": "/home/beau/agent/projects/bad",
    "guestPath": "/home/beau/host/projects/bad"
  }
]`), 0o644); err != nil {
		t.Fatalf("WriteFile(shares) error = %v", err)
	}

	attacher := NewAttacher(s.Roots, s, fixedNow())
	attacher.ShareRegistryPath = registryPath

	_, err := attacher.ShareAttachmentCandidates()
	if err == nil {
		t.Fatal("ShareAttachmentCandidates() error = nil, want registry parse error")
	}
	if !strings.Contains(err.Error(), "read share registry") {
		t.Fatalf("ShareAttachmentCandidates() error = %q, want share registry context", err)
	}
}

func TestShareAttachmentCandidatesSurfaceMetadataFallbackStatuses(t *testing.T) {
	s := store.New(testRoots(t))
	base := t.TempDir()

	warningsPath := filepath.Join(base, "warnings")
	writeRepoMetadata(t, warningsPath, "id: warnings\nname: Warning Repo\nnotesFile: missing.md\n")

	missingPath := filepath.Join(base, "missing")
	if err := os.MkdirAll(missingPath, 0o755); err != nil {
		t.Fatalf("MkdirAll(missing) error = %v", err)
	}

	invalidPath := filepath.Join(base, "invalid")
	writeRepoMetadata(t, invalidPath, "id: invalid\nunknownField: true\n")

	registryPath := filepath.Join(base, "shares.json")
	if err := os.WriteFile(registryPath, []byte(`[
  {
    "agentPath": "projects/warnings",
    "sourcePath": "/srv/repos/warnings",
    "hostPath": "/home/beau/agent/projects/warnings",
    "guestPath": "`+warningsPath+`"
  },
  {
    "agentPath": "projects/missing",
    "sourcePath": "/srv/repos/missing",
    "hostPath": "/home/beau/agent/projects/missing",
    "guestPath": "`+missingPath+`"
  },
  {
    "agentPath": "projects/invalid",
    "sourcePath": "/srv/repos/invalid",
    "hostPath": "/home/beau/agent/projects/invalid",
    "guestPath": "`+invalidPath+`"
  }
]`), 0o644); err != nil {
		t.Fatalf("WriteFile(shares) error = %v", err)
	}

	attacher := NewAttacher(s.Roots, s, fixedNow())
	attacher.ShareRegistryPath = registryPath

	candidates, err := attacher.ShareAttachmentCandidates()
	if err != nil {
		t.Fatalf("ShareAttachmentCandidates() error = %v", err)
	}

	gotStatuses := map[string]string{}
	gotLabels := map[string]string{}
	for _, candidate := range candidates {
		if candidate.MetadataImport == nil {
			t.Fatalf("candidate %q metadata import = nil, want surfaced fallback status", candidate.Path)
		}
		gotStatuses[candidate.Share.AgentPath] = candidate.MetadataImport.Status
		gotLabels[candidate.Share.AgentPath] = candidate.DisplayName
	}

	if gotStatuses["projects/warnings"] != models.ProjectMetadataImportStatusLoadedWithWarnings {
		t.Fatalf("warnings status = %q, want loaded-with-warnings", gotStatuses["projects/warnings"])
	}
	if gotLabels["projects/warnings"] != "Warning Repo" {
		t.Fatalf("warnings label = %q, want metadata-backed label", gotLabels["projects/warnings"])
	}
	if gotStatuses["projects/missing"] != models.ProjectMetadataImportStatusMissing {
		t.Fatalf("missing status = %q, want missing", gotStatuses["projects/missing"])
	}
	if gotLabels["projects/missing"] != "projects/missing" {
		t.Fatalf("missing label = %q, want share label fallback", gotLabels["projects/missing"])
	}
	if gotStatuses["projects/invalid"] != models.ProjectMetadataImportStatusInvalid {
		t.Fatalf("invalid status = %q, want invalid", gotStatuses["projects/invalid"])
	}
	if gotLabels["projects/invalid"] != "projects/invalid" {
		t.Fatalf("invalid label = %q, want share label fallback", gotLabels["projects/invalid"])
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

func createGitRepo(t *testing.T) string {
	t.Helper()
	repoRoot := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(repoRoot, 0o755); err != nil {
		t.Fatalf("MkdirAll(repoRoot) error = %v", err)
	}
	gitRun(t, repoRoot, "init", "-b", "main")
	gitRun(t, repoRoot, "config", "user.name", "Test User")
	gitRun(t, repoRoot, "config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(repoRoot, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("WriteFile(README.md) error = %v", err)
	}
	gitRun(t, repoRoot, "add", "README.md")
	gitRun(t, repoRoot, "commit", "-m", "initial")
	return repoRoot
}

func gitRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s error = %v, output=%s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
}

func gitOutput(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %s error = %v", strings.Join(args, " "), err)
	}
	return strings.TrimSpace(string(output))
}

func writeRepoMetadata(t *testing.T, repoPath, manifest string) {
	t.Helper()
	metadataPath := filepath.Join(repoPath, ".pi", "project.yaml")
	if err := os.MkdirAll(filepath.Dir(metadataPath), 0o755); err != nil {
		t.Fatalf("MkdirAll(.pi) error = %v", err)
	}
	if err := os.WriteFile(metadataPath, []byte(manifest), 0o644); err != nil {
		t.Fatalf("WriteFile(project.yaml) error = %v", err)
	}
}
