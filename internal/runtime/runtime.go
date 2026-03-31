package runtime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

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

	staleRuntimeThreshold = 12 * time.Hour
)

// SessionInspector checks tmux session liveness.
type SessionInspector interface {
	HasSession(ctx context.Context, session string) (bool, error)
}

// Service merges durable manifests with runtime state and tmux inspection.
type Service struct {
	Roots             paths.Roots
	Store             store.Store
	Sessions          SessionInspector
	ShareRegistryPath string
	Now               func() time.Time
}

// New returns a runtime service.
func New(roots paths.Roots, sessions SessionInspector) Service {
	if sessions == nil {
		sessions = tmux.New()
	}
	return Service{
		Roots:             roots,
		Store:             store.New(roots),
		Sessions:          sessions,
		ShareRegistryPath: paths.ShareRegistryPath(),
		Now:               time.Now,
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

	status, runtimeSource, runtimeErr := s.readRuntime(record.WorkstreamID)
	row.RuntimeSource = runtimeSource
	if runtimeErr != "" {
		row.RuntimeError = runtimeErr
	}
	if status != nil {
		row.Runtime = status
		row.LastSeenAt = status.LastSeenAt
	}
	row.Status = deriveStatus(sessionLive, status, runtimeSource, s.now())
	s.applyMergedContextLabels(&row)

	return row, nil
}

func (s Service) now() time.Time {
	if s.Now == nil {
		return time.Now()
	}
	return s.Now()
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

func (s Service) applyMergedContextLabels(row *models.WorkstreamRow) {
	if row == nil || len(row.Contexts) == 0 {
		return
	}

	deriver := newContextLabelDeriver(s.shareRegistryPath())
	for i := range row.Contexts {
		row.Contexts[i].MetadataImport = deriver.MetadataImport(row.Contexts[i].Path)
		row.Contexts[i].DisplayName = deriver.Derive(row.Contexts[i])
	}
}

func (s Service) shareRegistryPath() string {
	if strings.TrimSpace(s.ShareRegistryPath) != "" {
		return s.ShareRegistryPath
	}
	return paths.ShareRegistryPath()
}

type contextLabelDeriver struct {
	shares        []models.SharedProject
	metadataCache map[string]models.ProjectMetadataImport
}

func newContextLabelDeriver(shareRegistryPath string) contextLabelDeriver {
	deriver := contextLabelDeriver{
		metadataCache: make(map[string]models.ProjectMetadataImport),
	}
	projects, err := store.ReadShareRegistry(shareRegistryPath)
	if err == nil {
		deriver.shares = projects
	}
	return deriver
}

func (d *contextLabelDeriver) Derive(ctx models.WorkstreamContext) string {
	if label := strings.TrimSpace(ctx.DisplayName); label != "" {
		return label
	}
	if label := d.repoMetadataLabel(ctx.MetadataImport); label != "" {
		return label
	}
	if label := d.shareLabel(ctx.Path); label != "" {
		return label
	}
	return filepath.Base(filepath.Clean(ctx.Path))
}

func (d *contextLabelDeriver) repoMetadataLabel(imported *models.ProjectMetadataImport) string {
	if imported == nil {
		return ""
	}
	return metadataImportLabel(*imported)
}

func metadataImportLabel(imported models.ProjectMetadataImport) string {
	if imported.Metadata == nil || !imported.Metadata.Active {
		return ""
	}
	if imported.Status != models.ProjectMetadataImportStatusLoaded &&
		imported.Status != models.ProjectMetadataImportStatusLoadedWithWarnings {
		return ""
	}
	return strings.TrimSpace(imported.Metadata.Name)
}

func (d *contextLabelDeriver) shareLabel(path string) string {
	cleanPath := filepath.Clean(path)
	for _, project := range d.shares {
		if cleanPath == filepath.Clean(project.GuestPath) {
			return project.AgentPath
		}
	}
	return ""
}

func (d *contextLabelDeriver) MetadataImport(path string) *models.ProjectMetadataImport {
	repoRoot := findMetadataRoot(path)
	if repoRoot == "" {
		return nil
	}
	if imported, ok := d.metadataCache[repoRoot]; ok {
		importedCopy := imported
		return &importedCopy
	}

	imported, err := store.ReadProjectMetadata(repoRoot)
	if err != nil {
		return nil
	}
	d.metadataCache[repoRoot] = imported
	importedCopy := imported
	return &importedCopy
}

func findMetadataRoot(path string) string {
	current := filepath.Clean(path)
	for {
		if _, err := os.Stat(filepath.Join(current, ".pi", "project.yaml")); err == nil {
			return current
		}
		if _, err := os.Stat(filepath.Join(current, ".git")); err == nil {
			return current
		}

		parent := filepath.Dir(current)
		if parent == current {
			return ""
		}
		current = parent
	}
}

func deriveStatus(sessionLive bool, status *models.RuntimeStatus, runtimeSource string, now time.Time) string {
	if !sessionLive {
		return models.RuntimeStateDead
	}
	if status == nil || runtimeSource != RuntimeSourceOK {
		return models.RuntimeStateUnknown
	}
	if runtimeIsStale(status, now) {
		return models.RuntimeStateUnknown
	}
	return status.State
}

func runtimeIsStale(status *models.RuntimeStatus, now time.Time) bool {
	lastSeenAt, err := time.Parse(time.RFC3339, status.LastSeenAt)
	if err != nil {
		return true
	}
	return now.Sub(lastSeenAt) > staleRuntimeThreshold
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
