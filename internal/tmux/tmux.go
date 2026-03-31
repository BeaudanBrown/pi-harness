package tmux

// Client reserves the package boundary for tmux session control.
type Client struct{}

// New returns a scaffold tmux client.
func New() Client {
	return Client{}
}
