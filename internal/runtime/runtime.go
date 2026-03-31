package runtime

import "github.com/beaudanbrown/pi-harness/internal/paths"

// Service reserves the package boundary for runtime state merging logic.
type Service struct {
	Roots paths.Roots
}

// New returns a scaffold runtime service.
func New(roots paths.Roots) Service {
	return Service{Roots: roots}
}
