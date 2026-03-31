package tmux

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"reflect"
	"strconv"
	"testing"
)

func TestHasSessionReturnsTrueWhenTmuxFindsSession(t *testing.T) {
	client := Controller{runner: &fakeRunner{}}

	got, err := client.HasSession(context.Background(), "ph:alpha")
	if err != nil {
		t.Fatalf("HasSession() error = %v", err)
	}
	if !got {
		t.Fatal("HasSession() = false, want true")
	}
}

func TestHasSessionReturnsFalseOnExitCodeOne(t *testing.T) {
	client := Controller{runner: &fakeRunner{
		errs: map[string]error{
			"tmux has-session -t ph:alpha": exitCodeError(1),
		},
	}}

	got, err := client.HasSession(context.Background(), "ph:alpha")
	if err != nil {
		t.Fatalf("HasSession() error = %v", err)
	}
	if got {
		t.Fatal("HasSession() = true, want false")
	}
}

func TestEnsureSessionCreatesDetachedSessionWhenMissing(t *testing.T) {
	runner := fakeRunner{
		errs: map[string]error{
			"tmux has-session -t ph:alpha": exitCodeError(1),
		},
	}
	client := Controller{runner: &runner}

	created, err := client.EnsureSession(context.Background(), "ph:alpha", "/tmp/project")
	if err != nil {
		t.Fatalf("EnsureSession() error = %v", err)
	}
	if !created {
		t.Fatal("EnsureSession() = false, want true")
	}

	want := []string{
		"tmux has-session -t ph:alpha",
		"tmux new-session -d -s ph:alpha -c /tmp/project",
	}
	if !reflect.DeepEqual(runner.calls, want) {
		t.Fatalf("runner calls = %#v, want %#v", runner.calls, want)
	}
}

func TestEnsureSessionSkipsCreationWhenPresent(t *testing.T) {
	runner := fakeRunner{}
	client := Controller{runner: &runner}

	created, err := client.EnsureSession(context.Background(), "ph:alpha", "/tmp/project")
	if err != nil {
		t.Fatalf("EnsureSession() error = %v", err)
	}
	if created {
		t.Fatal("EnsureSession() = true, want false")
	}

	want := []string{"tmux has-session -t ph:alpha"}
	if !reflect.DeepEqual(runner.calls, want) {
		t.Fatalf("runner calls = %#v, want %#v", runner.calls, want)
	}
}

func TestAttachOrSwitchUsesAttachOutsideTmux(t *testing.T) {
	runner := fakeRunner{}
	client := Controller{runner: &runner}
	t.Setenv("TMUX", "")

	if err := client.AttachOrSwitch(context.Background(), "ph:alpha"); err != nil {
		t.Fatalf("AttachOrSwitch() error = %v", err)
	}

	want := []string{"tmux attach-session -t ph:alpha"}
	if !reflect.DeepEqual(runner.calls, want) {
		t.Fatalf("runner calls = %#v, want %#v", runner.calls, want)
	}
}

func TestAttachOrSwitchUsesSwitchClientInsideTmux(t *testing.T) {
	runner := fakeRunner{}
	client := Controller{runner: &runner}
	t.Setenv("TMUX", "/tmp/tmux-1000/default,123,0")

	if err := client.AttachOrSwitch(context.Background(), "ph:alpha"); err != nil {
		t.Fatalf("AttachOrSwitch() error = %v", err)
	}

	want := []string{"tmux switch-client -t ph:alpha"}
	if !reflect.DeepEqual(runner.calls, want) {
		t.Fatalf("runner calls = %#v, want %#v", runner.calls, want)
	}
}

type fakeRunner struct {
	calls []string
	errs  map[string]error
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) error {
	call := name
	for _, arg := range args {
		call += " " + arg
	}
	f.calls = append(f.calls, call)
	if f.errs == nil {
		return nil
	}
	return f.errs[call]
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
