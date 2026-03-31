package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/beaudanbrown/pi-harness/internal/models"
)

func TestReadProjectMetadataMissingManifestFallsBackCleanly(t *testing.T) {
	repoPath := t.TempDir()

	imported, err := ReadProjectMetadata(repoPath)
	if err != nil {
		t.Fatalf("ReadProjectMetadata() error = %v", err)
	}
	if imported.Status != models.ProjectMetadataImportStatusMissing {
		t.Fatalf("Status = %q, want missing", imported.Status)
	}
	if imported.Metadata != nil {
		t.Fatalf("Metadata = %#v, want nil", imported.Metadata)
	}
	if imported.Error != "" {
		t.Fatalf("Error = %q, want empty", imported.Error)
	}
}

func TestReadProjectMetadataInvalidManifestFallsBackWithoutMetadata(t *testing.T) {
	repoPath := t.TempDir()
	metadataPath := filepath.Join(repoPath, ".pi", "project.yaml")
	if err := os.MkdirAll(filepath.Dir(metadataPath), 0o755); err != nil {
		t.Fatalf("MkdirAll(.pi) error = %v", err)
	}
	if err := os.WriteFile(metadataPath, []byte("id: alpha\nunknownField: true\n"), 0o644); err != nil {
		t.Fatalf("WriteFile(project.yaml) error = %v", err)
	}

	imported, err := ReadProjectMetadata(repoPath)
	if err != nil {
		t.Fatalf("ReadProjectMetadata() error = %v", err)
	}
	if imported.Status != models.ProjectMetadataImportStatusInvalid {
		t.Fatalf("Status = %q, want invalid", imported.Status)
	}
	if imported.Metadata != nil {
		t.Fatalf("Metadata = %#v, want nil", imported.Metadata)
	}
	if imported.Error == "" || !strings.Contains(imported.Error, "decode metadata file") {
		t.Fatalf("Error = %q, want decode context", imported.Error)
	}
}

func TestReadProjectMetadataMissingCompanionFilesWarnsButKeepsBaseMetadata(t *testing.T) {
	repoPath := t.TempDir()
	metadataPath := filepath.Join(repoPath, ".pi", "project.yaml")
	if err := os.MkdirAll(filepath.Dir(metadataPath), 0o755); err != nil {
		t.Fatalf("MkdirAll(.pi) error = %v", err)
	}
	if err := os.WriteFile(metadataPath, []byte(strings.Join([]string{
		"id: alpha",
		"name: Alpha Repo",
		"defaultBaseBranch: main",
		"toolingFile: tooling.md",
		"notesFile: notes.md",
		"",
	}, "\n")), 0o644); err != nil {
		t.Fatalf("WriteFile(project.yaml) error = %v", err)
	}

	imported, err := ReadProjectMetadata(repoPath)
	if err != nil {
		t.Fatalf("ReadProjectMetadata() error = %v", err)
	}
	if imported.Status != models.ProjectMetadataImportStatusLoadedWithWarnings {
		t.Fatalf("Status = %q, want loaded-with-warnings", imported.Status)
	}
	if imported.Metadata == nil {
		t.Fatal("Metadata = nil, want loaded base metadata")
	}
	if imported.Metadata.ID != "alpha" || imported.Metadata.Name != "Alpha Repo" {
		t.Fatalf("Metadata = %#v, want parsed id and name", imported.Metadata)
	}
	if imported.Metadata.ToolingFile != "" || imported.Metadata.NotesFile != "" {
		t.Fatalf("Metadata companion files = %#v, want empty unavailable paths", imported.Metadata)
	}
	if len(imported.Warnings) != 2 {
		t.Fatalf("len(Warnings) = %d, want 2", len(imported.Warnings))
	}
}

func TestReadProjectMetadataLoadsExistingCompanionFiles(t *testing.T) {
	repoPath := t.TempDir()
	metadataDir := filepath.Join(repoPath, ".pi")
	metadataPath := filepath.Join(metadataDir, "project.yaml")
	if err := os.MkdirAll(metadataDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(.pi) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(metadataDir, "tooling.md"), []byte("tooling\n"), 0o644); err != nil {
		t.Fatalf("WriteFile(tooling.md) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(metadataDir, "notes.md"), []byte("notes\n"), 0o644); err != nil {
		t.Fatalf("WriteFile(notes.md) error = %v", err)
	}
	if err := os.WriteFile(metadataPath, []byte(strings.Join([]string{
		"id: alpha",
		"name: Alpha Repo",
		"toolingFile: tooling.md",
		"notesFile: notes.md",
		"active: false",
		"",
	}, "\n")), 0o644); err != nil {
		t.Fatalf("WriteFile(project.yaml) error = %v", err)
	}

	imported, err := ReadProjectMetadata(repoPath)
	if err != nil {
		t.Fatalf("ReadProjectMetadata() error = %v", err)
	}
	if imported.Status != models.ProjectMetadataImportStatusLoaded {
		t.Fatalf("Status = %q, want loaded", imported.Status)
	}
	if imported.Metadata == nil {
		t.Fatal("Metadata = nil, want parsed metadata")
	}
	if imported.Metadata.ToolingFile != filepath.Join(metadataDir, "tooling.md") {
		t.Fatalf("ToolingFile = %q, want resolved companion path", imported.Metadata.ToolingFile)
	}
	if imported.Metadata.NotesFile != filepath.Join(metadataDir, "notes.md") {
		t.Fatalf("NotesFile = %q, want resolved companion path", imported.Metadata.NotesFile)
	}
	if imported.Metadata.Active {
		t.Fatal("Active = true, want parsed false value")
	}
	if len(imported.Warnings) != 0 {
		t.Fatalf("Warnings = %#v, want none", imported.Warnings)
	}
}
