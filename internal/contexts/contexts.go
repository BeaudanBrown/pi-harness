package contexts

// Manager reserves the package boundary for workstream context attachment logic.
type Manager struct{}

// New returns a scaffold context manager.
func New() Manager {
	return Manager{}
}
