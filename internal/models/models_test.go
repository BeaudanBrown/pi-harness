package models

import "testing"

func TestWorkstreamRecordValidate(t *testing.T) {
	record := WorkstreamRecord{
		SchemaVersion:    CurrentSchemaVersion,
		WorkstreamID:     "focus-bugfix",
		Title:            "Focus bugfix",
		TmuxSession:      "ph:focus-bugfix",
		CreatedAt:        "2026-03-31T01:00:00Z",
		UpdatedAt:        "2026-03-31T01:05:00Z",
		PrimaryContextID: "ctx-main",
		Contexts: []WorkstreamContext{
			{
				ContextID:   "ctx-main",
				DisplayName: "Main checkout",
				Path:        "/tmp/project",
				Kind:        ContextKindWorktree,
				Mode:        ContextModeIsolated,
				Role:        ContextRolePrimary,
			},
		},
	}

	if err := record.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestWorkstreamRecordValidateRejectsPrimaryMismatch(t *testing.T) {
	record := WorkstreamRecord{
		SchemaVersion:    CurrentSchemaVersion,
		WorkstreamID:     "focus-bugfix",
		Title:            "Focus bugfix",
		TmuxSession:      "ph:focus-bugfix",
		CreatedAt:        "2026-03-31T01:00:00Z",
		UpdatedAt:        "2026-03-31T01:05:00Z",
		PrimaryContextID: "missing",
		Contexts: []WorkstreamContext{
			{
				ContextID:   "ctx-main",
				DisplayName: "Main checkout",
				Path:        "/tmp/project",
				Kind:        ContextKindWorktree,
				Mode:        ContextModeIsolated,
				Role:        ContextRolePrimary,
			},
		},
	}

	if err := record.Validate(); err == nil {
		t.Fatal("Validate() error = nil, want mismatch error")
	}
}

func TestWorkstreamRecordValidateRejectsDuplicateNormalizedPaths(t *testing.T) {
	record := WorkstreamRecord{
		SchemaVersion: CurrentSchemaVersion,
		WorkstreamID:  "focus-bugfix",
		Title:         "Focus bugfix",
		TmuxSession:   "ph:focus-bugfix",
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:05:00Z",
		Contexts: []WorkstreamContext{
			{
				ContextID:   "ctx-main",
				DisplayName: "Main checkout",
				Path:        "/tmp/project",
				Kind:        ContextKindWorktree,
				Mode:        ContextModeIsolated,
				Role:        ContextRoleSecondary,
			},
			{
				ContextID:   "ctx-shadow",
				DisplayName: "Shadow checkout",
				Path:        "/tmp/../tmp/project",
				Kind:        ContextKindCheckout,
				Mode:        ContextModeSharedReadonly,
				Role:        ContextRoleSecondary,
			},
		},
	}

	if err := record.Validate(); err == nil {
		t.Fatal("Validate() error = nil, want duplicate path error")
	}
}

func TestRuntimeStatusValidate(t *testing.T) {
	status := RuntimeStatus{
		SchemaVersion:    CurrentSchemaVersion,
		WorkstreamID:     "focus-bugfix",
		TmuxSession:      "ph:focus-bugfix",
		State:            RuntimeStateProcessing,
		CWD:              "/tmp/project",
		LastSeenAt:       "2026-03-31T01:05:00Z",
		LastProcessingAt: "2026-03-31T01:04:00Z",
		ActiveModel:      "gpt-5.4",
	}

	if err := status.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestRuntimeStatusValidateRejectsDerivedState(t *testing.T) {
	status := RuntimeStatus{
		SchemaVersion: CurrentSchemaVersion,
		WorkstreamID:  "focus-bugfix",
		TmuxSession:   "ph:focus-bugfix",
		State:         "dead",
		CWD:           "/tmp/project",
		LastSeenAt:    "2026-03-31T01:05:00Z",
	}

	if err := status.Validate(); err == nil {
		t.Fatal("Validate() error = nil, want invalid state error")
	}
}

func TestValidateTmuxSession(t *testing.T) {
	if err := ValidateTmuxSession("focus-bugfix", "ph:focus-bugfix"); err != nil {
		t.Fatalf("ValidateTmuxSession() error = %v", err)
	}
	if err := ValidateTmuxSession("focus-bugfix", "focus-bugfix"); err == nil {
		t.Fatal("ValidateTmuxSession() error = nil, want mismatch error")
	}
}

func TestWorkstreamContextAttachmentLabel(t *testing.T) {
	context := WorkstreamContext{
		Kind: ContextKindDirectory,
		Mode: ContextModeSharedReadwrite,
	}

	if got := context.ModeLabel(); got != "shared read-write" {
		t.Fatalf("ModeLabel() = %q, want shared read-write", got)
	}
	if got := context.AttachmentLabel(); got != "shared read-write directory" {
		t.Fatalf("AttachmentLabel() = %q, want shared read-write directory", got)
	}
}

func TestWorkstreamContextValidateAllowsEmptyDisplayName(t *testing.T) {
	context := WorkstreamContext{
		ContextID: "ctx-main",
		Path:      "/tmp/project",
		Kind:      ContextKindCheckout,
		Mode:      ContextModeIsolated,
		Role:      ContextRolePrimary,
	}

	if err := context.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestSharedProjectNormalizeAndValidate(t *testing.T) {
	project := SharedProject{
		AgentPath:  " ./projects/pi-harness/ ",
		SourcePath: " /srv/repos/../repos/pi-harness ",
		HostPath:   " /home/beau/agent/projects/../projects/pi-harness ",
		GuestPath:  " /home/beau/host/projects/../projects/pi-harness ",
	}.Normalize()

	if project.AgentPath != "projects/pi-harness" {
		t.Fatalf("Normalize().AgentPath = %q, want projects/pi-harness", project.AgentPath)
	}
	if project.SourcePath != "/srv/repos/pi-harness" {
		t.Fatalf("Normalize().SourcePath = %q, want cleaned absolute path", project.SourcePath)
	}
	if project.HostPath != "/home/beau/agent/projects/pi-harness" {
		t.Fatalf("Normalize().HostPath = %q, want cleaned absolute path", project.HostPath)
	}
	if project.GuestPath != "/home/beau/host/projects/pi-harness" {
		t.Fatalf("Normalize().GuestPath = %q, want cleaned absolute path", project.GuestPath)
	}
	if err := project.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestSharedProjectValidateRejectsAbsoluteAgentPath(t *testing.T) {
	project := SharedProject{
		AgentPath:  "/projects/pi-harness",
		SourcePath: "/srv/repos/pi-harness",
		HostPath:   "/home/beau/agent/projects/pi-harness",
		GuestPath:  "/home/beau/host/projects/pi-harness",
	}

	if err := project.Validate(); err == nil {
		t.Fatal("Validate() error = nil, want relative agentPath error")
	}
}

func TestProjectMetadataImportValidate(t *testing.T) {
	imported := ProjectMetadataImport{
		Status:       ProjectMetadataImportStatusLoadedWithWarnings,
		RepoPath:     "/home/beau/host/projects/pi-harness",
		MetadataFile: "/home/beau/host/projects/pi-harness/.pi/project.yaml",
		Metadata: &ProjectMetadata{
			RepoPath:     "/home/beau/host/projects/pi-harness",
			MetadataFile: "/home/beau/host/projects/pi-harness/.pi/project.yaml",
			ToolingFile:  "/home/beau/host/projects/pi-harness/.pi/tooling.md",
			Active:       true,
		},
		Warnings: []string{"toolingFile \"tooling.md\" is referenced but missing"},
	}

	if err := imported.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestProjectMetadataValidateRejectsInvalidID(t *testing.T) {
	project := ProjectMetadata{
		ID:           "Pi Harness",
		RepoPath:     "/home/beau/host/projects/pi-harness",
		MetadataFile: "/home/beau/host/projects/pi-harness/.pi/project.yaml",
		Active:       true,
	}

	if err := project.Validate(); err == nil {
		t.Fatal("Validate() error = nil, want invalid id error")
	}
}
