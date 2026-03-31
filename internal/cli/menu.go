package cli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/beaudanbrown/pi-harness/internal/models"
)

const internalMenuSelectCommand = "__menu-select"
const internalMenuAttachCommand = "__menu-attach"

type workstreamSelector interface {
	Select(context.Context, []models.WorkstreamRow) (string, error)
}

type commandSelector struct {
	runner commandExecutor
}

type commandExecutor interface {
	Run(context.Context, string, []string, io.Reader, io.Writer) error
}

type execCommandExecutor struct{}

func (execCommandExecutor) Run(ctx context.Context, name string, args []string, stdin io.Reader, stdout io.Writer) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func newCommandSelector() commandSelector {
	return commandSelector{runner: execCommandExecutor{}}
}

func (s commandSelector) Select(ctx context.Context, rows []models.WorkstreamRow) (string, error) {
	if len(rows) == 0 {
		return "", nil
	}

	input := renderSelectorInput(rows)
	var output bytes.Buffer
	err := s.runner.Run(ctx, "fzf", []string{
		"--delimiter=\t",
		"--with-nth=2,3,4",
		"--layout=reverse",
		"--height=100%",
	}, strings.NewReader(input), &output)
	if err != nil {
		if isSelectorAbort(err) {
			return "", nil
		}
		return "", fmt.Errorf("run fzf: %w", err)
	}

	return parseSelectedWorkstreamID(output.String())
}

func renderSelectorInput(rows []models.WorkstreamRow) string {
	var b strings.Builder
	for _, row := range rows {
		fmt.Fprintf(&b, "%s\t%s\t%s\t%s\n", row.WorkstreamID, menuStatusLabel(row.Status), row.Title, attachmentSummary(row.Contexts))
	}
	return b.String()
}

func menuStatusLabel(status string) string {
	if status == models.RuntimeStateIdle {
		return "waiting"
	}
	return status
}

func parseSelectedWorkstreamID(raw string) (string, error) {
	line := strings.TrimSpace(raw)
	if line == "" {
		return "", nil
	}

	id, _, found := strings.Cut(line, "\t")
	if !found {
		return "", errors.New("selector output missing workstream id field")
	}
	if err := models.ValidateWorkstreamID(id); err != nil {
		return "", fmt.Errorf("validate selected workstream id: %w", err)
	}
	return id, nil
}

func isSelectorAbort(err error) bool {
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		return false
	}
	code := exitErr.ExitCode()
	return code == 1 || code == 130
}

func (app application) runMenu(args []string, stdout io.Writer) error {
	if len(args) != 0 {
		return errors.New("usage: pi-harness menu")
	}

	executable, err := app.executable()
	if err != nil {
		return fmt.Errorf("resolve executable path: %w", err)
	}

	command := shellQuote(executable) + " " + internalMenuAttachCommand
	if insideTmux() {
		if err := app.tmux.DisplayPopup(context.Background(), command); err != nil {
			return fmt.Errorf("open popup selector: %w", err)
		}
	} else {
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("resolve home directory: %w", err)
		}
		fmt.Fprintln(stdout, outsideTmuxMenuMessage())
		if err := app.tmux.JoinSessionWithPopup(context.Background(), sharedDefaultTmuxSession, home, command); err != nil {
			return fmt.Errorf("join shared tmux session and open popup: %w", err)
		}
	}
	return nil
}

func (app application) runInternalMenuAttach() error {
	rows, err := app.runtime.List(context.Background())
	if err != nil {
		return fmt.Errorf("load workstreams: %w", err)
	}

	selected, err := app.selector.Select(context.Background(), rows)
	if err != nil {
		return err
	}
	if selected == "" {
		return nil
	}

	return app.runAttach([]string{selected}, io.Discard)
}

func (app application) runInternalMenuSelect(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: pi-harness __menu-select <output-path>")
	}

	rows, err := app.runtime.List(context.Background())
	if err != nil {
		return fmt.Errorf("load workstreams: %w", err)
	}

	selected, err := app.selector.Select(context.Background(), rows)
	if err != nil {
		return err
	}

	if err := os.WriteFile(args[0], []byte(selected+"\n"), 0o600); err != nil {
		return fmt.Errorf("write selector output: %w", err)
	}
	return nil
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}
