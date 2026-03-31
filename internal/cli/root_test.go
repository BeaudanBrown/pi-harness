package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
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
