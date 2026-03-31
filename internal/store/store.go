package store

import "github.com/beaudanbrown/pi-harness/internal/paths"

// Store reserves the package boundary for manifest and runtime persistence.
type Store struct {
	Roots paths.Roots
}

// New returns a scaffold store bound to the harness directory roots.
func New(roots paths.Roots) Store {
	return Store{Roots: roots}
}
