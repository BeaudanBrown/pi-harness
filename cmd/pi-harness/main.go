package main

import (
	"os"

	"github.com/beaudanbrown/pi-harness/internal/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:], os.Stdout, os.Stderr))
}
