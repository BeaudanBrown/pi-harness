package cli

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/beaudanbrown/pi-harness/internal/models"
)

func attachmentSummary(contexts []models.WorkstreamContext) string {
	switch len(contexts) {
	case 0:
		return "no paths"
	case 1:
		if label := strings.TrimSpace(contexts[0].DisplayName); label != "" {
			return label
		}
		return filepath.Base(filepath.Clean(contexts[0].Path))
	default:
		return fmt.Sprintf("%d paths", len(contexts))
	}
}
