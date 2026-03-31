package cli

import (
	"fmt"
	"os"

	"github.com/beaudanbrown/pi-harness/internal/models"
)

const sharedDefaultTmuxSession = "default"

func insideTmux() bool {
	return os.Getenv("TMUX") != ""
}

func outsideTmuxMenuMessage() string {
	return fmt.Sprintf("Outside tmux: joining the shared %s tmux session, then opening the workstream menu.", sharedDefaultTmuxSession)
}

func outsideTmuxAttachMessage(record models.WorkstreamRecord) string {
	return fmt.Sprintf("Outside tmux: joining tmux and attaching %s (%s).", record.WorkstreamID, record.TmuxSession)
}
