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
