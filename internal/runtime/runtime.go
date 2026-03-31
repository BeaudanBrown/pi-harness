package runtime

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/beaudanbrown/pi-harness/internal/models"
	"github.com/beaudanbrown/pi-harness/internal/paths"
	"github.com/beaudanbrown/pi-harness/internal/store"
	"github.com/beaudanbrown/pi-harness/internal/tmux"
)

const (
	EnvWorkstreamID = "PI_HARNESS_WORKSTREAM_ID"
	EnvRuntimeDir   = "PI_HARNESS_RUNTIME_DIR"
	EnvTmuxSession  = "PI_HARNESS_TMUX_SESSION"

	RuntimeSourceOK      = "ok"
	RuntimeSourceMissing = "missing"
	RuntimeSourceInvalid = "invalid"
)

// SessionInspector checks tmux session liveness.
type SessionInspector interface {
	HasSession(ctx context.Context, session string) (bool, error)
}

// Service merges durable manifests with runtime state and tmux inspection.
type Service struct {
	Roots    paths.Roots
	Store    store.Store
	Sessions SessionInspector
}

// New returns a runtime service.
func New(roots paths.Roots, sessions SessionInspector) Service {
	if sessions == nil {
		sessions = tmux.New()
	}
	return Service{
		Roots:    roots,
		Store:    store.New(roots),
		Sessions: sessions,
	}
}

// List returns merged rows for all known workstreams.
func (s Service) List(ctx context.Context) ([]models.WorkstreamRow, error) {
	ids, err := s.Store.ListWorkstreamIDs()
	if err != nil {
		return nil, err
	}

	rows := make([]models.WorkstreamRow, 0, len(ids))
	for _, workstreamID := range ids {
		row, err := s.Get(ctx, workstreamID)
		if err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// Get returns the merged row for one exact workstream id.
func (s Service) Get(ctx context.Context, workstreamID string) (models.WorkstreamRow, error) {
	record, err := s.Store.ReadManifest(workstreamID)
	if err != nil {
		return models.WorkstreamRow{}, err
	}

	sessionLive, err := s.Sessions.HasSession(ctx, record.TmuxSession)
	if err != nil {
		return models.WorkstreamRow{}, err
	}

	row := models.WorkstreamRow{
		WorkstreamID:    record.WorkstreamID,
		Title:           record.Title,
		TmuxSession:     record.TmuxSession,
		CreatedAt:       record.CreatedAt,
		UpdatedAt:       record.UpdatedAt,
		Contexts:        append([]models.WorkstreamContext(nil), record.Contexts...),
		RuntimeSource:   RuntimeSourceOK,
		TmuxSessionLive: sessionLive,
	}
	if record.PrimaryContextID != "" {
		for i := range record.Contexts {
			if record.Contexts[i].ContextID == record.PrimaryContextID {
				contextCopy := record.Contexts[i]
				row.PrimaryContext = &contextCopy
				break
			}
		}
	}

	status, runtimeSource, runtimeErr := s.readRuntime(record.WorkstreamID)
	row.RuntimeSource = runtimeSource
	if runtimeErr != "" {
		row.RuntimeError = runtimeErr
	}
	if status != nil {
		row.Runtime = status
		row.LastSeenAt = status.LastSeenAt
	}
	row.Status = deriveStatus(sessionLive, status, runtimeSource)

	return row, nil
}

func (s Service) readRuntime(workstreamID string) (*models.RuntimeStatus, string, string) {
	status, err := s.Store.ReadRuntime(workstreamID)
	if err == nil {
		return &status, RuntimeSourceOK, ""
	}
	if errors.Is(err, os.ErrNotExist) {
		return nil, RuntimeSourceMissing, ""
	}
	return nil, RuntimeSourceInvalid, err.Error()
}

func deriveStatus(sessionLive bool, status *models.RuntimeStatus, runtimeSource string) string {
	if !sessionLive {
		return models.RuntimeStateDead
	}
	if status == nil || runtimeSource != RuntimeSourceOK {
		return models.RuntimeStateUnknown
	}
	return status.State
}

// ExtensionEnv returns the environment variables the harness injects for the
// Pi runtime-status extension.
func ExtensionEnv(roots paths.Roots, workstreamID, tmuxSession string) ([]string, error) {
	if err := models.ValidateWorkstreamID(workstreamID); err != nil {
		return nil, fmt.Errorf("validate workstreamId: %w", err)
	}
	if err := models.ValidateTmuxSession(workstreamID, tmuxSession); err != nil {
		return nil, fmt.Errorf("validate tmuxSession: %w", err)
	}

	return []string{
		EnvWorkstreamID + "=" + workstreamID,
		EnvRuntimeDir + "=" + roots.Runtime,
		EnvTmuxSession + "=" + tmuxSession,
	}, nil
}
