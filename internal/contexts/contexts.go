package contexts

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/beaudanbrown/pi-harness/internal/models"
	"github.com/beaudanbrown/pi-harness/internal/store"
)

// Manager applies typed context mutations against durable workstream manifests.
type Manager struct {
	Store store.Store
	Now   func() time.Time
}

type AddInput struct {
	ContextID         string
	ProjectID         string
	DisplayName       string
	Path              string
	Kind              string
	Mode              string
	Role              string
	Branch            string
	OwnerWorkstreamID string
}

type UpdateInput struct {
	ProjectID         *string
	DisplayName       *string
	Path              *string
	Kind              *string
	Mode              *string
	Role              *string
	Branch            *string
	OwnerWorkstreamID *string
}

func New(s store.Store, now func() time.Time) Manager {
	if now == nil {
		now = time.Now
	}
	return Manager{
		Store: s,
		Now:   now,
	}
}

func (m Manager) AddContext(workstreamID string, input AddInput) (models.WorkstreamRecord, error) {
	if err := validateRequestedRole(input.Role); err != nil {
		return models.WorkstreamRecord{}, err
	}

	return m.Store.UpdateManifest(workstreamID, func(record *models.WorkstreamRecord) error {
		context := models.WorkstreamContext{
			ContextID:         strings.TrimSpace(input.ContextID),
			ProjectID:         strings.TrimSpace(input.ProjectID),
			DisplayName:       strings.TrimSpace(input.DisplayName),
			Path:              normalizePath(input.Path),
			Kind:              strings.TrimSpace(input.Kind),
			Mode:              strings.TrimSpace(input.Mode),
			Role:              input.Role,
			Branch:            strings.TrimSpace(input.Branch),
			OwnerWorkstreamID: strings.TrimSpace(input.OwnerWorkstreamID),
		}
		if err := context.Validate(); err != nil {
			return err
		}

		record.Contexts = append(record.Contexts, context)
		if err := applyRole(record, context.ContextID, input.Role); err != nil {
			return err
		}
		record.UpdatedAt = m.Now().UTC().Format(time.RFC3339)
		return nil
	})
}

func (m Manager) UpdateContext(workstreamID, contextID string, input UpdateInput) (models.WorkstreamRecord, error) {
	return m.Store.UpdateManifest(workstreamID, func(record *models.WorkstreamRecord) error {
		index := -1
		for i := range record.Contexts {
			if record.Contexts[i].ContextID == contextID {
				index = i
				break
			}
		}
		if index < 0 {
			return fmt.Errorf("context %q not found", contextID)
		}

		context := record.Contexts[index]
		if input.ProjectID != nil {
			context.ProjectID = strings.TrimSpace(*input.ProjectID)
		}
		if input.DisplayName != nil {
			context.DisplayName = strings.TrimSpace(*input.DisplayName)
		}
		if input.Path != nil {
			context.Path = normalizePath(*input.Path)
		}
		if input.Kind != nil {
			context.Kind = strings.TrimSpace(*input.Kind)
		}
		if input.Mode != nil {
			context.Mode = strings.TrimSpace(*input.Mode)
		}
		if input.Branch != nil {
			context.Branch = strings.TrimSpace(*input.Branch)
		}
		if input.OwnerWorkstreamID != nil {
			context.OwnerWorkstreamID = strings.TrimSpace(*input.OwnerWorkstreamID)
		}
		if input.Role != nil {
			role := strings.TrimSpace(*input.Role)
			if err := validateRequestedRole(role); err != nil {
				return err
			}
			context.Role = role
		}
		if err := context.Validate(); err != nil {
			return err
		}

		record.Contexts[index] = context
		if input.Role != nil {
			if err := applyRole(record, contextID, context.Role); err != nil {
				return err
			}
		}
		record.UpdatedAt = m.Now().UTC().Format(time.RFC3339)
		return nil
	})
}

func applyRole(record *models.WorkstreamRecord, contextID, role string) error {
	switch role {
	case models.ContextRolePrimary:
		for i := range record.Contexts {
			record.Contexts[i].Role = models.ContextRoleSecondary
			if record.Contexts[i].ContextID == contextID {
				record.Contexts[i].Role = models.ContextRolePrimary
			}
		}
		record.PrimaryContextID = contextID
		return nil
	case models.ContextRoleSecondary:
		for i := range record.Contexts {
			if record.Contexts[i].ContextID == contextID {
				record.Contexts[i].Role = models.ContextRoleSecondary
				break
			}
		}
		if record.PrimaryContextID == contextID {
			record.PrimaryContextID = ""
		}
		return nil
	default:
		return fmt.Errorf("role %q is invalid", role)
	}
}

func validateRequestedRole(role string) error {
	switch role {
	case models.ContextRolePrimary, models.ContextRoleSecondary:
		return nil
	case "":
		return errors.New("role is required")
	default:
		return fmt.Errorf("role %q is invalid", role)
	}
}

func normalizePath(path string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return ""
	}
	return filepath.Clean(trimmed)
}
