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
	primaryCount := 0
	for _, context := range record.Contexts {
		if err := context.Validate(); err != nil {
			return err
		}
		if _, exists := seenContextIDs[context.ContextID]; exists {
			return fmt.Errorf("contextId %q is duplicated", context.ContextID)
		}
		seenContextIDs[context.ContextID] = struct{}{}
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

func isAllowed(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}
