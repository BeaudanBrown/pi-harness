package runtime

import (
	"fmt"

	"github.com/beaudanbrown/pi-harness/internal/models"
	"github.com/beaudanbrown/pi-harness/internal/paths"
)

const (
	EnvWorkstreamID = "PI_HARNESS_WORKSTREAM_ID"
	EnvRuntimeDir   = "PI_HARNESS_RUNTIME_DIR"
	EnvTmuxSession  = "PI_HARNESS_TMUX_SESSION"
)

// Service reserves the package boundary for runtime state merging logic.
type Service struct {
	Roots paths.Roots
}

// New returns a scaffold runtime service.
func New(roots paths.Roots) Service {
	return Service{Roots: roots}
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
