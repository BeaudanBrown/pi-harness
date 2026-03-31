package models

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const CurrentSchemaVersion = 1

const (
	ContextKindWorktree  = "worktree"
	ContextKindCheckout  = "checkout"
	ContextKindDirectory = "directory"

	ContextModeIsolated        = "isolated"
	ContextModeSharedReadonly  = "shared-readonly"
	ContextModeSharedReadwrite = "shared-readwrite"

	ContextRolePrimary   = "primary"
	ContextRoleSecondary = "secondary"

	RuntimeStateProcessing = "processing"
	RuntimeStateIdle       = "idle"
	RuntimeStateDead       = "dead"
	RuntimeStateUnknown    = "unknown"
)

var workstreamIDPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

// WorkstreamContext is the durable attachment record for one workstream path.
type WorkstreamContext struct {
	ContextID         string `json:"contextId"`
	ProjectID         string `json:"projectId,omitempty"`
	DisplayName       string `json:"displayName"`
	Path              string `json:"path"`
	Kind              string `json:"kind"`
	Mode              string `json:"mode"`
	Role              string `json:"role"`
	Branch            string `json:"branch,omitempty"`
	OwnerWorkstreamID string `json:"ownerWorkstreamId,omitempty"`
}

// WorkstreamRecord is the durable manifest shape for a workstream.
type WorkstreamRecord struct {
	SchemaVersion    int                 `json:"schemaVersion"`
	WorkstreamID     string              `json:"workstreamId"`
	Title            string              `json:"title"`
	TmuxSession      string              `json:"tmuxSession"`
	CreatedAt        string              `json:"createdAt"`
	UpdatedAt        string              `json:"updatedAt"`
	PrimaryContextID string              `json:"primaryContextId,omitempty"`
	Contexts         []WorkstreamContext `json:"contexts"`
	Notes            string              `json:"notes"`
}

// RuntimeStatus is the live state contract merged with tmux discovery.
type RuntimeStatus struct {
	SchemaVersion    int    `json:"schemaVersion"`
	WorkstreamID     string `json:"workstreamId"`
	TmuxSession      string `json:"tmuxSession"`
	State            string `json:"state"`
	CWD              string `json:"cwd"`
	LastSeenAt       string `json:"lastSeenAt"`
	LastProcessingAt string `json:"lastProcessingAt,omitempty"`
	ActiveModel      string `json:"activeModel,omitempty"`
}

// SharedProject is one host-managed directory exposed into the guest VM.
type SharedProject struct {
	AgentPath  string `json:"agentPath"`
	SourcePath string `json:"sourcePath"`
	HostPath   string `json:"hostPath"`
	GuestPath  string `json:"guestPath"`
}

const (
	ProjectMetadataImportStatusLoaded             = "loaded"
	ProjectMetadataImportStatusLoadedWithWarnings = "loaded-with-warnings"
	ProjectMetadataImportStatusMissing            = "missing"
	ProjectMetadataImportStatusInvalid            = "invalid"
)

// ProjectMetadata is imported from a repo-local .pi/project.yaml manifest.
type ProjectMetadata struct {
	ID                string `json:"id,omitempty"`
	Name              string `json:"name,omitempty"`
	DefaultBaseBranch string `json:"defaultBaseBranch,omitempty"`
	RepoPath          string `json:"repoPath"`
	MetadataFile      string `json:"metadataFile"`
	ToolingFile       string `json:"toolingFile,omitempty"`
	NotesFile         string `json:"notesFile,omitempty"`
	Active            bool   `json:"active"`
}

// ProjectMetadataImport records whether repo-local metadata loaded cleanly,
// degraded with warnings, or fell back because the manifest was missing/invalid.
type ProjectMetadataImport struct {
	Status       string           `json:"status"`
	RepoPath     string           `json:"repoPath"`
	MetadataFile string           `json:"metadataFile"`
	Metadata     *ProjectMetadata `json:"metadata,omitempty"`
	Warnings     []string         `json:"warnings,omitempty"`
	Error        string           `json:"error,omitempty"`
}

// WorkstreamRow is the merged operator-facing workstream view.
type WorkstreamRow struct {
	WorkstreamID    string              `json:"workstreamId"`
	Title           string              `json:"title"`
	TmuxSession     string              `json:"tmuxSession"`
	CreatedAt       string              `json:"createdAt"`
	UpdatedAt       string              `json:"updatedAt"`
	Status          string              `json:"status"`
	PrimaryContext  *WorkstreamContext  `json:"primaryContext,omitempty"`
	Contexts        []WorkstreamContext `json:"contexts"`
	LastSeenAt      string              `json:"lastSeenAt,omitempty"`
	Runtime         *RuntimeStatus      `json:"runtime,omitempty"`
	RuntimeSource   string              `json:"runtimeSource"`
	RuntimeError    string              `json:"runtimeError,omitempty"`
	TmuxSessionLive bool                `json:"tmuxSessionLive"`
}

func (ctx WorkstreamContext) ModeLabel() string {
	switch ctx.Mode {
	case ContextModeSharedReadonly:
		return "shared read-only"
	case ContextModeSharedReadwrite:
		return "shared read-write"
	default:
		return "isolated"
	}
}

func (ctx WorkstreamContext) AttachmentLabel() string {
	kind := ctx.Kind
	if kind == "" {
		kind = "context"
	}
	return ctx.ModeLabel() + " " + kind
}

func ValidateWorkstreamID(id string) error {
	if !workstreamIDPattern.MatchString(id) {
		return fmt.Errorf("workstreamId %q must match %s", id, workstreamIDPattern.String())
	}
	return nil
}

func ValidateTmuxSession(workstreamID, session string) error {
	if workstreamID == "" {
		return errors.New("workstreamId is required")
	}
	want := "ph:" + workstreamID
	if session != want {
		return fmt.Errorf("tmuxSession %q must equal %q", session, want)
	}
	return nil
}

func (ctx WorkstreamContext) Validate() error {
	if strings.TrimSpace(ctx.ContextID) == "" {
		return errors.New("contextId is required")
	}
	if strings.TrimSpace(ctx.DisplayName) == "" {
		return fmt.Errorf("context %q displayName is required", ctx.ContextID)
	}
	if !filepath.IsAbs(ctx.Path) {
		return fmt.Errorf("context %q path %q must be absolute", ctx.ContextID, ctx.Path)
	}
	if !isAllowed(ctx.Kind, ContextKindWorktree, ContextKindCheckout, ContextKindDirectory) {
		return fmt.Errorf("context %q kind %q is invalid", ctx.ContextID, ctx.Kind)
	}
	if !isAllowed(ctx.Mode, ContextModeIsolated, ContextModeSharedReadonly, ContextModeSharedReadwrite) {
		return fmt.Errorf("context %q mode %q is invalid", ctx.ContextID, ctx.Mode)
	}
	if !isAllowed(ctx.Role, ContextRolePrimary, ContextRoleSecondary) {
		return fmt.Errorf("context %q role %q is invalid", ctx.ContextID, ctx.Role)
	}
	return nil
}

func (record WorkstreamRecord) Validate() error {
	if record.SchemaVersion != CurrentSchemaVersion {
		return fmt.Errorf("schemaVersion %d is unsupported", record.SchemaVersion)
	}
	if err := ValidateWorkstreamID(record.WorkstreamID); err != nil {
		return err
	}
	if strings.TrimSpace(record.Title) == "" {
		return errors.New("title is required")
	}
	if err := ValidateTmuxSession(record.WorkstreamID, record.TmuxSession); err != nil {
		return err
	}
	createdAt, err := parseTimestamp("createdAt", record.CreatedAt)
	if err != nil {
		return err
	}
	updatedAt, err := parseTimestamp("updatedAt", record.UpdatedAt)
	if err != nil {
		return err
	}
	if updatedAt.Before(createdAt) {
		return errors.New("updatedAt must be equal to or later than createdAt")
	}

	seenContextIDs := map[string]struct{}{}
	seenPaths := map[string]string{}
	primaryCount := 0
	for _, context := range record.Contexts {
		if err := context.Validate(); err != nil {
			return err
		}
		if _, exists := seenContextIDs[context.ContextID]; exists {
			return fmt.Errorf("contextId %q is duplicated", context.ContextID)
		}
		seenContextIDs[context.ContextID] = struct{}{}
		normalizedPath := filepath.Clean(context.Path)
		if existingContextID, exists := seenPaths[normalizedPath]; exists {
			return fmt.Errorf("context path %q is duplicated by %q and %q", normalizedPath, existingContextID, context.ContextID)
		}
		seenPaths[normalizedPath] = context.ContextID
		if context.Role == ContextRolePrimary {
			primaryCount++
			if record.PrimaryContextID != context.ContextID {
				return fmt.Errorf("primary context %q must match primaryContextId %q", context.ContextID, record.PrimaryContextID)
			}
		}
	}

	if record.PrimaryContextID == "" {
		if primaryCount > 0 {
			return errors.New("primaryContextId is required when a primary context exists")
		}
		return nil
	}

	if _, exists := seenContextIDs[record.PrimaryContextID]; !exists {
		return fmt.Errorf("primaryContextId %q does not match any context", record.PrimaryContextID)
	}
	if primaryCount != 1 {
		return fmt.Errorf("exactly one primary context is required when primaryContextId is set, got %d", primaryCount)
	}
	return nil
}

func (status RuntimeStatus) Validate() error {
	if status.SchemaVersion != CurrentSchemaVersion {
		return fmt.Errorf("schemaVersion %d is unsupported", status.SchemaVersion)
	}
	if err := ValidateWorkstreamID(status.WorkstreamID); err != nil {
		return err
	}
	if err := ValidateTmuxSession(status.WorkstreamID, status.TmuxSession); err != nil {
		return err
	}
	if !isAllowed(status.State, RuntimeStateProcessing, RuntimeStateIdle) {
		return fmt.Errorf("state %q is invalid", status.State)
	}
	if !filepath.IsAbs(status.CWD) {
		return fmt.Errorf("cwd %q must be absolute", status.CWD)
	}
	lastSeenAt, err := parseTimestamp("lastSeenAt", status.LastSeenAt)
	if err != nil {
		return err
	}
	if status.LastProcessingAt == "" {
		return nil
	}
	lastProcessingAt, err := parseTimestamp("lastProcessingAt", status.LastProcessingAt)
	if err != nil {
		return err
	}
	if lastProcessingAt.After(lastSeenAt) {
		return errors.New("lastProcessingAt must be equal to or earlier than lastSeenAt")
	}
	return nil
}

func (project SharedProject) Normalize() SharedProject {
	project.AgentPath = normalizeAgentPath(project.AgentPath)
	project.SourcePath = normalizeAbsolutePath(project.SourcePath)
	project.HostPath = normalizeAbsolutePath(project.HostPath)
	project.GuestPath = normalizeAbsolutePath(project.GuestPath)
	return project
}

func (project SharedProject) Validate() error {
	if strings.TrimSpace(project.AgentPath) == "" {
		return errors.New("agentPath is required")
	}
	if filepath.IsAbs(project.AgentPath) {
		return fmt.Errorf("agentPath %q must be relative", project.AgentPath)
	}
	if normalized := strings.Trim(strings.TrimSpace(filepath.Clean(project.AgentPath)), "/."); normalized == "" {
		return fmt.Errorf("agentPath %q must not resolve to empty", project.AgentPath)
	}
	if !filepath.IsAbs(project.SourcePath) {
		return fmt.Errorf("sourcePath %q must be absolute", project.SourcePath)
	}
	if !filepath.IsAbs(project.HostPath) {
		return fmt.Errorf("hostPath %q must be absolute", project.HostPath)
	}
	if !filepath.IsAbs(project.GuestPath) {
		return fmt.Errorf("guestPath %q must be absolute", project.GuestPath)
	}
	return nil
}

func (project ProjectMetadata) Validate() error {
	if project.ID != "" {
		if !workstreamIDPattern.MatchString(project.ID) {
			return fmt.Errorf("id %q must match %s", project.ID, workstreamIDPattern.String())
		}
	}
	if !filepath.IsAbs(project.RepoPath) {
		return fmt.Errorf("repoPath %q must be absolute", project.RepoPath)
	}
	if !filepath.IsAbs(project.MetadataFile) {
		return fmt.Errorf("metadataFile %q must be absolute", project.MetadataFile)
	}
	if project.ToolingFile != "" && !filepath.IsAbs(project.ToolingFile) {
		return fmt.Errorf("toolingFile %q must be absolute", project.ToolingFile)
	}
	if project.NotesFile != "" && !filepath.IsAbs(project.NotesFile) {
		return fmt.Errorf("notesFile %q must be absolute", project.NotesFile)
	}
	return nil
}

func (imported ProjectMetadataImport) Validate() error {
	if !filepath.IsAbs(imported.RepoPath) {
		return fmt.Errorf("repoPath %q must be absolute", imported.RepoPath)
	}
	if !filepath.IsAbs(imported.MetadataFile) {
		return fmt.Errorf("metadataFile %q must be absolute", imported.MetadataFile)
	}
	if !isAllowed(
		imported.Status,
		ProjectMetadataImportStatusLoaded,
		ProjectMetadataImportStatusLoadedWithWarnings,
		ProjectMetadataImportStatusMissing,
		ProjectMetadataImportStatusInvalid,
	) {
		return fmt.Errorf("status %q is invalid", imported.Status)
	}
	if imported.Metadata != nil {
		if err := imported.Metadata.Validate(); err != nil {
			return err
		}
	}
	return nil
}

func parseTimestamp(field, value string) (time.Time, error) {
	if strings.TrimSpace(value) == "" {
		return time.Time{}, fmt.Errorf("%s is required", field)
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("%s %q must be RFC3339: %w", field, value, err)
	}
	return parsed, nil
}

func normalizeAbsolutePath(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	return filepath.Clean(trimmed)
}

func normalizeAgentPath(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	cleaned := filepath.Clean(trimmed)
	if filepath.IsAbs(cleaned) {
		return cleaned
	}
	return strings.TrimPrefix(cleaned, "./")
}

func isAllowed(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}
