package cli

import (
	"fmt"
	"io"
	"strings"
)

const (
	binaryName    = "pi-harness"
	versionString = "dev"
)

// Run executes the top-level CLI entrypoint.
func Run(args []string, stdout, stderr io.Writer) int {
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
	default:
		fmt.Fprintf(stderr, "unknown command %q\n\n", args[0])
		writeUsage(stderr)
		return 1
	}
}

func writeUsage(w io.Writer) {
	fmt.Fprintf(w, "%s manages local Pi workstreams.\n\n", binaryName)
	fmt.Fprintf(w, "Usage:\n  %s <command>\n\n", binaryName)
	fmt.Fprint(w, "Scaffolded commands:\n")
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
