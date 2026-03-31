package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/beaudanbrown/pi-harness/internal/models"
	"github.com/beaudanbrown/pi-harness/internal/paths"
	"github.com/beaudanbrown/pi-harness/internal/store"
)

func TestRunWithoutArgsPrintsUsage(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	exitCode := Run(nil, &stdout, &stderr)

	if exitCode != 0 {
		t.Fatalf("Run() exit code = %d, want 0", exitCode)
	}
	if stderr.Len() != 0 {
		t.Fatalf("Run() wrote unexpected stderr: %q", stderr.String())
	}
	if !strings.Contains(stdout.String(), "Usage:") {
		t.Fatalf("Run() stdout = %q, want usage text", stdout.String())
	}
}

func TestRunVersion(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	exitCode := Run([]string{"version"}, &stdout, &stderr)

	if exitCode != 0 {
		t.Fatalf("Run() exit code = %d, want 0", exitCode)
	}
	if got := strings.TrimSpace(stdout.String()); got != "pi-harness dev" {
		t.Fatalf("Run() stdout = %q, want %q", got, "pi-harness dev")
	}
	if stderr.Len() != 0 {
		t.Fatalf("Run() wrote unexpected stderr: %q", stderr.String())
	}
}

func TestRunUnknownCommand(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	exitCode := Run([]string{"bogus"}, &stdout, &stderr)

	if exitCode != 1 {
		t.Fatalf("Run() exit code = %d, want 1", exitCode)
	}
	if stdout.Len() != 0 {
		t.Fatalf("Run() wrote unexpected stdout: %q", stdout.String())
	}
	if got := stderr.String(); !strings.Contains(got, "unknown command") || !strings.Contains(got, "Usage:") {
		t.Fatalf("Run() stderr = %q, want error plus usage", got)
	}
}

func TestRunNewCreatesManifest(t *testing.T) {
	app, roots, _ := testApplication(t, fakeSessions{}, fixedNow())

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := run([]string{"new", "Focus", "bugfix"}, &stdout, &stderr, app)

	if exitCode != 0 {
		t.Fatalf("run(new) exit code = %d, want 0, stderr=%q", exitCode, stderr.String())
	}
	if got := strings.TrimSpace(stdout.String()); got != "created focus-bugfix (ph:focus-bugfix)" {
		t.Fatalf("run(new) stdout = %q", got)
	}

	record, err := store.New(roots).ReadManifest("focus-bugfix")
	if err != nil {
		t.Fatalf("ReadManifest() error = %v", err)
	}
	if record.Title != "Focus bugfix" {
		t.Fatalf("manifest title = %q, want %q", record.Title, "Focus bugfix")
	}
	if record.CreatedAt != "2026-03-31T02:00:00Z" || record.UpdatedAt != "2026-03-31T02:00:00Z" {
		t.Fatalf("manifest timestamps = (%q, %q)", record.CreatedAt, record.UpdatedAt)
	}
}

func TestRunListJSONReturnsMergedRows(t *testing.T) {
	app, roots, _ := testApplication(t, fakeSessions{live: map[string]bool{"ph:alpha": true}}, fixedNow())
	testStore := store.New(roots)

	mustWriteManifest(t, testStore, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "alpha",
		Title:         "Alpha",
		TmuxSession:   paths.TmuxSessionName("alpha"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:10:00Z",
		Contexts: []models.WorkstreamContext{
			{
				ContextID:   "ctx-main",
				DisplayName: "Main checkout",
				Path:        "/tmp/alpha",
				Kind:        models.ContextKindCheckout,
				Mode:        models.ContextModeIsolated,
				Role:        models.ContextRolePrimary,
			},
		},
		PrimaryContextID: "ctx-main",
	})
	mustWriteRuntime(t, testStore, models.RuntimeStatus{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "alpha",
		TmuxSession:   paths.TmuxSessionName("alpha"),
		State:         models.RuntimeStateIdle,
		CWD:           "/tmp/alpha",
		LastSeenAt:    "2026-03-31T01:11:00Z",
	})

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := run([]string{"list", "--json"}, &stdout, &stderr, app)
	if exitCode != 0 {
		t.Fatalf("run(list --json) exit code = %d, stderr=%q", exitCode, stderr.String())
	}

	var rows []models.WorkstreamRow
	if err := json.Unmarshal(stdout.Bytes(), &rows); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("len(rows) = %d, want 1", len(rows))
	}
	if rows[0].Status != models.RuntimeStateIdle {
		t.Fatalf("rows[0].Status = %q, want idle", rows[0].Status)
	}
	if rows[0].PrimaryContext == nil || rows[0].PrimaryContext.DisplayName != "Main checkout" {
		t.Fatalf("rows[0].PrimaryContext = %#v", rows[0].PrimaryContext)
	}
	if rows[0].RuntimeSource != "ok" {
		t.Fatalf("rows[0].RuntimeSource = %q, want ok", rows[0].RuntimeSource)
	}
}

func TestRunStatusReportsDerivedDeadState(t *testing.T) {
	app, roots, _ := testApplication(t, fakeSessions{}, fixedNow())
	testStore := store.New(roots)

	mustWriteManifest(t, testStore, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "alpha",
		Title:         "Alpha",
		TmuxSession:   paths.TmuxSessionName("alpha"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:10:00Z",
		Contexts:      []models.WorkstreamContext{},
	})

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := run([]string{"status", "alpha"}, &stdout, &stderr, app)
	if exitCode != 0 {
		t.Fatalf("run(status) exit code = %d, stderr=%q", exitCode, stderr.String())
	}

	output := stdout.String()
	if !strings.Contains(output, "Status: dead") {
		t.Fatalf("status output = %q, want derived dead status", output)
	}
	if !strings.Contains(output, "Tmux session live: false") {
		t.Fatalf("status output = %q, want tmux liveness", output)
	}
	if !strings.Contains(output, "Runtime source: missing") {
		t.Fatalf("status output = %q, want missing runtime source", output)
	}
}

func TestRunAttachBootstrapsMissingSessionAndSwitches(t *testing.T) {
	app, roots, sessions := testApplication(t, fakeSessions{
		live: map[string]bool{},
	}, fixedNow())
	testStore := store.New(roots)

	mustWriteManifest(t, testStore, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "alpha",
		Title:         "Alpha",
		TmuxSession:   paths.TmuxSessionName("alpha"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:10:00Z",
		Contexts: []models.WorkstreamContext{
			{
				ContextID:   "ctx-main",
				DisplayName: "Main checkout",
				Path:        "/tmp/alpha",
				Kind:        models.ContextKindCheckout,
				Mode:        models.ContextModeIsolated,
				Role:        models.ContextRolePrimary,
			},
		},
		PrimaryContextID: "ctx-main",
	})

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := run([]string{"attach", "alpha"}, &stdout, &stderr, app)
	if exitCode != 0 {
		t.Fatalf("run(attach) exit code = %d, stderr=%q", exitCode, stderr.String())
	}
	if got := strings.TrimSpace(stdout.String()); got != "bootstrapped alpha (ph:alpha)" {
		t.Fatalf("run(attach) stdout = %q", got)
	}

	if len(sessions.ensureCalls) != 1 {
		t.Fatalf("EnsureSession() calls = %d, want 1", len(sessions.ensureCalls))
	}
	ensureCall := sessions.ensureCalls[0]
	if ensureCall.session != "ph:alpha" || ensureCall.cwd != "/tmp/alpha" {
		t.Fatalf("EnsureSession() call = %#v", ensureCall)
	}
	if got := sessions.attachCalls; len(got) != 1 || got[0] != "ph:alpha" {
		t.Fatalf("AttachOrSwitch() calls = %#v", got)
	}
}

func TestRunAttachUsesHomeDirectoryWithoutPrimaryContext(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	app, roots, sessions := testApplication(t, fakeSessions{}, fixedNow())
	testStore := store.New(roots)

	mustWriteManifest(t, testStore, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "alpha",
		Title:         "Alpha",
		TmuxSession:   paths.TmuxSessionName("alpha"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:10:00Z",
		Contexts:      []models.WorkstreamContext{},
	})

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := run([]string{"attach", "alpha"}, &stdout, &stderr, app)
	if exitCode != 0 {
		t.Fatalf("run(attach) exit code = %d, stderr=%q", exitCode, stderr.String())
	}

	ensureCall := sessions.ensureCalls[0]
	if ensureCall.cwd != os.Getenv("HOME") {
		t.Fatalf("EnsureSession() cwd = %q, want %q", ensureCall.cwd, os.Getenv("HOME"))
	}
}

func TestRunAddContextCreatesIsolatedGitWorktreeManifestEntry(t *testing.T) {
	app, roots, _ := testApplication(t, fakeSessions{}, fixedNow())
	testStore := store.New(roots)

	mustWriteManifest(t, testStore, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "alpha",
		Title:         "Alpha",
		TmuxSession:   paths.TmuxSessionName("alpha"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:00:00Z",
		Contexts:      []models.WorkstreamContext{},
	})

	repoRoot := createGitRepo(t)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := run([]string{"add-context", "alpha", repoRoot}, &stdout, &stderr, app)
	if exitCode != 0 {
		t.Fatalf("run(add-context) exit code = %d, stderr=%q", exitCode, stderr.String())
	}
	if !strings.Contains(stdout.String(), "attached") {
		t.Fatalf("run(add-context) stdout = %q, want attach confirmation", stdout.String())
	}

	record, err := testStore.ReadManifest("alpha")
	if err != nil {
		t.Fatalf("ReadManifest(alpha) error = %v", err)
	}
	if len(record.Contexts) != 1 {
		t.Fatalf("len(Contexts) = %d, want 1", len(record.Contexts))
	}
	context := record.Contexts[0]
	if context.Path == repoRoot {
		t.Fatalf("context.Path = %q, want isolated worktree path", context.Path)
	}
	if context.Path != roots.WorktreePath("alpha", context.ContextID) {
		t.Fatalf("context.Path = %q, want worktree layout path", context.Path)
	}
	if context.OwnerWorkstreamID != "alpha" {
		t.Fatalf("context.OwnerWorkstreamID = %q, want alpha", context.OwnerWorkstreamID)
	}
	if context.Branch == "" {
		t.Fatal("context.Branch = empty, want owned branch metadata")
	}
}

func TestRunMenuOpensPopupAndAttachesSelectedWorkstream(t *testing.T) {
	app, roots, sessions := testApplication(t, fakeSessions{
		live: map[string]bool{"ph:beta": true},
	}, fixedNow())
	testStore := store.New(roots)
	app.executable = func() (string, error) { return "/tmp/pi-harness", nil }

	mustWriteManifest(t, testStore, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "beta",
		Title:         "Beta",
		TmuxSession:   paths.TmuxSessionName("beta"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:10:00Z",
		Contexts:      []models.WorkstreamContext{},
	})
	sessions.popupHook = func(command string) error {
		path := selectorOutputPath(t, command)
		return os.WriteFile(path, []byte("beta\n"), 0o600)
	}

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := run([]string{"menu"}, &stdout, &stderr, app)
	if exitCode != 0 {
		t.Fatalf("run(menu) exit code = %d, stderr=%q", exitCode, stderr.String())
	}

	if len(sessions.popupCalls) != 1 {
		t.Fatalf("DisplayPopup() calls = %d, want 1", len(sessions.popupCalls))
	}
	if got := sessions.attachCalls; len(got) != 1 || got[0] != "ph:beta" {
		t.Fatalf("AttachOrSwitch() calls = %#v", got)
	}
	if got := sessions.ensureCalls; len(got) != 1 || got[0].session != "ph:beta" {
		t.Fatalf("EnsureSession() calls = %#v", got)
	}
}

func TestRunMenuLeavesSessionUnchangedWhenSelectorCloses(t *testing.T) {
	app, roots, sessions := testApplication(t, fakeSessions{}, fixedNow())
	testStore := store.New(roots)
	app.executable = func() (string, error) { return "/tmp/pi-harness", nil }

	mustWriteManifest(t, testStore, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "beta",
		Title:         "Beta",
		TmuxSession:   paths.TmuxSessionName("beta"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:10:00Z",
		Contexts:      []models.WorkstreamContext{},
	})
	sessions.popupHook = func(command string) error {
		path := selectorOutputPath(t, command)
		return os.WriteFile(path, []byte("\n"), 0o600)
	}

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := run([]string{"menu"}, &stdout, &stderr, app)
	if exitCode != 0 {
		t.Fatalf("run(menu) exit code = %d, stderr=%q", exitCode, stderr.String())
	}
	if len(sessions.attachCalls) != 0 {
		t.Fatalf("AttachOrSwitch() calls = %#v, want none", sessions.attachCalls)
	}
	if len(sessions.ensureCalls) != 0 {
		t.Fatalf("EnsureSession() calls = %#v, want none", sessions.ensureCalls)
	}
}

func TestRunInternalMenuSelectWritesChosenWorkstreamID(t *testing.T) {
	app, roots, _ := testApplication(t, fakeSessions{
		live: map[string]bool{"ph:alpha": true},
	}, fixedNow())
	testStore := store.New(roots)
	outputPath := t.TempDir() + "/selection.txt"
	app.selector = fakeSelector{selected: "alpha"}

	mustWriteManifest(t, testStore, models.WorkstreamRecord{
		SchemaVersion: models.CurrentSchemaVersion,
		WorkstreamID:  "alpha",
		Title:         "Alpha",
		TmuxSession:   paths.TmuxSessionName("alpha"),
		CreatedAt:     "2026-03-31T01:00:00Z",
		UpdatedAt:     "2026-03-31T01:10:00Z",
		Contexts: []models.WorkstreamContext{
			{
				ContextID:   "ctx-main",
				DisplayName: "Main checkout",
				Path:        "/tmp/alpha",
				Kind:        models.ContextKindCheckout,
				Mode:        models.ContextModeIsolated,
				Role:        models.ContextRolePrimary,
			},
		},
		PrimaryContextID: "ctx-main",
	})

	if err := app.runInternalMenuSelect([]string{outputPath}); err != nil {
		t.Fatalf("runInternalMenuSelect() error = %v", err)
	}
	if got := strings.TrimSpace(string(mustReadFile(t, outputPath))); got != "alpha" {
		t.Fatalf("selection file = %q, want alpha", got)
	}
}

func TestCommandSelectorRendersRowsForFZFAndParsesSelection(t *testing.T) {
	runner := &fakeCommandExecutor{output: "alpha\twaiting\tAlpha\tMain checkout\n"}
	selector := commandSelector{runner: runner}

	selected, err := selector.Select(context.Background(), []models.WorkstreamRow{
		{
			WorkstreamID: "alpha",
			Title:        "Alpha",
			Status:       models.RuntimeStateIdle,
			PrimaryContext: &models.WorkstreamContext{
				DisplayName: "Main checkout",
			},
		},
	})
	if err != nil {
		t.Fatalf("Select() error = %v", err)
	}
	if selected != "alpha" {
		t.Fatalf("Select() = %q, want alpha", selected)
	}
	if runner.name != "fzf" {
		t.Fatalf("runner name = %q, want fzf", runner.name)
	}
	if got := strings.Join(runner.args, " "); !strings.Contains(got, "--with-nth=2,3,4") {
		t.Fatalf("runner args = %#v", runner.args)
	}
	if got := runner.stdin; got != "alpha\twaiting\tAlpha\tMain checkout\n" {
		t.Fatalf("selector stdin = %q", got)
	}
}

func TestCommandSelectorTreatsAbortAsNoSelection(t *testing.T) {
	selector := commandSelector{runner: &fakeCommandExecutor{err: exitCodeError(130)}}

	selected, err := selector.Select(context.Background(), []models.WorkstreamRow{
		{WorkstreamID: "alpha", Title: "Alpha", Status: models.RuntimeStateIdle},
	})
	if err != nil {
		t.Fatalf("Select() error = %v", err)
	}
	if selected != "" {
		t.Fatalf("Select() = %q, want empty selection", selected)
	}
}

func TestHasCommand(t *testing.T) {
	if !HasCommand("menu") {
		t.Fatal("HasCommand(menu) = false, want true")
	}
	if HasCommand("missing") {
		t.Fatal("HasCommand(missing) = true, want false")
	}
}

type fakeSessions struct {
	live        map[string]bool
	err         error
	ensureErr   error
	attachErr   error
	ensureCalls []ensureCall
	attachCalls []string
	popupErr    error
	popupCalls  []string
	popupHook   func(string) error
}

type ensureCall struct {
	session string
	cwd     string
}

func (f *fakeSessions) HasSession(_ context.Context, session string) (bool, error) {
	if f.err != nil {
		return false, f.err
	}
	return f.live[session], nil
}

func (f *fakeSessions) EnsureSession(_ context.Context, session, cwd string) (bool, error) {
	f.ensureCalls = append(f.ensureCalls, ensureCall{session: session, cwd: cwd})
	if f.ensureErr != nil {
		return false, f.ensureErr
	}
	_, exists := f.live[session]
	if f.live == nil {
		f.live = map[string]bool{}
	}
	if !exists {
		f.live[session] = true
		return true, nil
	}
	return false, nil
}

func (f *fakeSessions) AttachOrSwitch(_ context.Context, session string) error {
	f.attachCalls = append(f.attachCalls, session)
	return f.attachErr
}

func (f *fakeSessions) DisplayPopup(_ context.Context, command string) error {
	f.popupCalls = append(f.popupCalls, command)
	if f.popupHook != nil {
		return f.popupHook(command)
	}
	return f.popupErr
}

type fakeSelector struct {
	selected string
	err      error
}

func (f fakeSelector) Select(_ context.Context, _ []models.WorkstreamRow) (string, error) {
	return f.selected, f.err
}

type fakeCommandExecutor struct {
	name   string
	args   []string
	stdin  string
	output string
	err    error
}

func (f *fakeCommandExecutor) Run(_ context.Context, name string, args []string, stdin io.Reader, stdout io.Writer) error {
	f.name = name
	f.args = append([]string(nil), args...)
	data, err := io.ReadAll(stdin)
	if err != nil {
		return err
	}
	f.stdin = string(data)
	if f.output != "" {
		if _, err := io.WriteString(stdout, f.output); err != nil {
			return err
		}
	}
	return f.err
}

func testApplication(t *testing.T, sessions fakeSessions, now func() time.Time) (application, paths.Roots, *fakeSessions) {
	t.Helper()
	base := t.TempDir()
	roots := paths.Roots{
		StateRoot:   base + "/state/pi-harness",
		Workstreams: base + "/state/pi-harness/workstreams",
		Runtime:     base + "/state/pi-harness/runtime",
		ShareRoot:   base + "/share/pi-harness",
		Worktrees:   base + "/share/pi-harness/worktrees",
	}
	controller := &sessions
	return newApplication(roots, controller, now), roots, controller
}

func fixedNow() func() time.Time {
	return func() time.Time {
		return time.Date(2026, time.March, 31, 2, 0, 0, 0, time.UTC)
	}
}

func mustWriteManifest(t *testing.T, s store.Store, record models.WorkstreamRecord) {
	t.Helper()
	if err := s.WriteManifest(record); err != nil {
		t.Fatalf("WriteManifest() error = %v", err)
	}
}

func mustWriteRuntime(t *testing.T, s store.Store, status models.RuntimeStatus) {
	t.Helper()
	if err := s.WriteRuntime(status); err != nil {
		t.Fatalf("WriteRuntime() error = %v", err)
	}
}

func mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", path, err)
	}
	return data
}

func selectorOutputPath(t *testing.T, command string) string {
	t.Helper()
	parts := strings.Split(command, "'")
	if len(parts) < 4 {
		t.Fatalf("popup command = %q, want quoted executable and output path", command)
	}
	return parts[3]
}

func createGitRepo(t *testing.T) string {
	t.Helper()
	repoRoot := t.TempDir()
	gitRun(t, repoRoot, "init", "-b", "main")
	gitRun(t, repoRoot, "config", "user.name", "Test User")
	gitRun(t, repoRoot, "config", "user.email", "test@example.com")
	if err := os.WriteFile(repoRoot+"/README.md", []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("WriteFile(README.md) error = %v", err)
	}
	gitRun(t, repoRoot, "add", "README.md")
	gitRun(t, repoRoot, "commit", "-m", "initial")
	return repoRoot
}

func gitRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s error = %v, output=%s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
}

func exitCodeError(code int) error {
	cmd := exec.Command(os.Args[0], "-test.run=TestHelperProcessExitCode")
	cmd.Env = append(os.Environ(), "GO_WANT_HELPER_PROCESS=1", "GO_HELPER_EXIT_CODE="+strconv.Itoa(code))
	err := cmd.Run()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		panic("expected exec.ExitError")
	}
	return err
}

func TestHelperProcessExitCode(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}
	code, err := strconv.Atoi(os.Getenv("GO_HELPER_EXIT_CODE"))
	if err != nil {
		code = 1
	}
	os.Exit(code)
}
