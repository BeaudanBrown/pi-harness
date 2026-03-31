package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/beaudanbrown/pi-harness/internal/models"
	"github.com/beaudanbrown/pi-harness/internal/paths"
	hruntime "github.com/beaudanbrown/pi-harness/internal/runtime"
	"github.com/beaudanbrown/pi-harness/internal/store"
	"github.com/beaudanbrown/pi-harness/internal/tmux"
)

const (
	binaryName    = "pi-harness"
	versionString = "dev"
)

type application struct {
	store   store.Store
	runtime hruntime.Service
	now     func() time.Time
}

func newApplication(roots paths.Roots, sessions hruntime.SessionInspector, now func() time.Time) application {
	if now == nil {
		now = time.Now
	}
	return application{
		store:   store.New(roots),
		runtime: hruntime.New(roots, sessions),
		now:     now,
	}
}

// Run executes the top-level CLI entrypoint.
func Run(args []string, stdout, stderr io.Writer) int {
	app := newApplication(paths.DefaultRoots(), tmux.New(), time.Now)
	return run(args, stdout, stderr, app)
}

func run(args []string, stdout, stderr io.Writer, app application) int {
	if len(args) == 0 {
		writeUsage(stdout)
		return 0
	}

	switch args[0] {
	case "help", "-h", "--help":
		writeUsage(stdout)
		return 0
	case "version", "--version":
		fmt.Fprintf(stdout, "%s %s\n", binaryName, versionString)
		return 0
	case "new":
		if err := app.runNew(args[1:], stdout); err != nil {
			fmt.Fprintf(stderr, "new: %v\n", err)
			return 1
		}
		return 0
	case "list":
		if err := app.runList(args[1:], stdout); err != nil {
			fmt.Fprintf(stderr, "list: %v\n", err)
			return 1
		}
		return 0
	case "status":
		if err := app.runStatus(args[1:], stdout); err != nil {
			fmt.Fprintf(stderr, "status: %v\n", err)
			return 1
		}
		return 0
	default:
		fmt.Fprintf(stderr, "unknown command %q\n\n", args[0])
		writeUsage(stderr)
		return 1
	}
}

func (app application) runNew(args []string, stdout io.Writer) error {
	if len(args) == 0 {
		return errors.New("title is required")
	}

	title := strings.TrimSpace(strings.Join(args, " "))
	if title == "" {
		return errors.New("title is required")
	}

	existingIDs, err := app.store.ListWorkstreamIDs()
	if err != nil {
		return fmt.Errorf("list workstreams: %w", err)
	}

	existingSet := make(map[string]struct{}, len(existingIDs))
	for _, existingID := range existingIDs {
		existingSet[existingID] = struct{}{}
	}

	workstreamID := paths.GenerateWorkstreamID(title, existingSet)
	now := app.now().UTC().Format(time.RFC3339)
	record := models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  workstreamID,
		Title:         title,
		TmuxSession:   paths.TmuxSessionName(workstreamID),
		CreatedAt:     now,
		UpdatedAt:     now,
		Contexts:      []models.WorkstreamContext{},
		Notes:         "",
	}

	if err := app.store.WriteManifest(record); err != nil {
		return fmt.Errorf("write manifest: %w", err)
	}

	fmt.Fprintf(stdout, "created %s (%s)\n", record.WorkstreamID, record.TmuxSession)
	return nil
}

func (app application) runList(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("list", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	jsonOutput := flags.Bool("json", false, "emit JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("list does not accept positional arguments")
	}

	rows, err := app.runtime.List(context.Background())
	if err != nil {
		return fmt.Errorf("load workstreams: %w", err)
	}
	if *jsonOutput {
		return writeJSON(stdout, rows)
	}

	tw := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "WORKSTREAM\tSTATUS\tTITLE\tPRIMARY CONTEXT")
	for _, row := range rows {
		primary := "-"
		if row.PrimaryContext != nil {
			primary = row.PrimaryContext.DisplayName
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", row.WorkstreamID, row.Status, row.Title, primary)
	}
	return tw.Flush()
}

func (app application) runStatus(args []string, stdout io.Writer) error {
	if len(args) != 1 {
		return errors.New("usage: pi-harness status <workstream>")
	}

	row, err := app.runtime.Get(context.Background(), args[0])
	if err != nil {
		return fmt.Errorf("load workstream %q: %w", args[0], err)
	}

	primary := "-"
	if row.PrimaryContext != nil {
		primary = fmt.Sprintf("%s (%s)", row.PrimaryContext.DisplayName, row.PrimaryContext.Path)
	}

	runtimeState := row.RuntimeSource
	lastSeen := "-"
	lastProcessing := "-"
	activeModel := "-"
	cwd := "-"
	if row.Runtime != nil {
		runtimeState = row.Runtime.State
		lastSeen = row.Runtime.LastSeenAt
		if row.Runtime.LastProcessingAt != "" {
			lastProcessing = row.Runtime.LastProcessingAt
		}
		if row.Runtime.ActiveModel != "" {
			activeModel = row.Runtime.ActiveModel
		}
		if row.Runtime.CWD != "" {
			cwd = row.Runtime.CWD
		}
	}

	fmt.Fprintf(stdout, "Workstream: %s\n", row.WorkstreamID)
	fmt.Fprintf(stdout, "Title: %s\n", row.Title)
	fmt.Fprintf(stdout, "Status: %s\n", row.Status)
	fmt.Fprintf(stdout, "Tmux session: %s\n", row.TmuxSession)
	fmt.Fprintf(stdout, "Tmux session live: %t\n", row.TmuxSessionLive)
	fmt.Fprintf(stdout, "Created at: %s\n", row.CreatedAt)
	fmt.Fprintf(stdout, "Updated at: %s\n", row.UpdatedAt)
	fmt.Fprintf(stdout, "Primary context: %s\n", primary)
	fmt.Fprintf(stdout, "Contexts: %d\n", len(row.Contexts))
	fmt.Fprintf(stdout, "Runtime source: %s\n", row.RuntimeSource)
	fmt.Fprintf(stdout, "Runtime state: %s\n", runtimeState)
	fmt.Fprintf(stdout, "Runtime cwd: %s\n", cwd)
	fmt.Fprintf(stdout, "Last seen at: %s\n", lastSeen)
	fmt.Fprintf(stdout, "Last processing at: %s\n", lastProcessing)
	fmt.Fprintf(stdout, "Active model: %s\n", activeModel)
	if row.RuntimeError != "" {
		fmt.Fprintf(stdout, "Runtime error: %s\n", row.RuntimeError)
	}
	return nil
}

func writeJSON(w io.Writer, value any) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

func writeUsage(w io.Writer) {
	fmt.Fprintf(w, "%s manages local Pi workstreams.\n\n", binaryName)
	fmt.Fprintf(w, "Usage:\n  %s <command>\n\n", binaryName)
	fmt.Fprint(w, "Commands:\n")
	for _, command := range commandNames() {
		fmt.Fprintf(w, "  %s\n", command)
	}
}

func commandNames() []string {
	return []string{
		"new",
		"list",
		"status",
		"attach",
		"menu",
		"add-context",
		"help",
		"version",
	}
}

// HasCommand reports whether a scaffolded command name is reserved already.
func HasCommand(name string) bool {
	for _, command := range commandNames() {
		if strings.EqualFold(command, name) {
			return true
		}
	}
	return false
}
