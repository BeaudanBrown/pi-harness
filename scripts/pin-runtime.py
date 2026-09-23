#!/usr/bin/env python3
"""Keep an immutable launcher closure rooted for exactly its running lifetime."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile


def main():
    launcher = os.path.realpath(sys.argv[1])
    parts = Path(launcher).parts
    if len(parts) < 4 or parts[1:3] != ("nix", "store"):
        raise SystemExit("runtime pin requires an immutable Nix launcher")
    store_path = str(Path(*parts[:4]))
    state = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "pi-runtime-roots"
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state.is_symlink() or state.stat().st_uid != os.getuid() or state.stat().st_mode & 0o077:
        raise SystemExit("runtime roots must be private and owned by the launching user")
    directory = Path(tempfile.mkdtemp(prefix="launch-", dir=state))
    root = directory / "runtime"
    child = None
    try:
        subprocess.run([os.environ["PI_RUNTIME_NIX_STORE"], "--add-root", str(root), "--indirect", "--realise", store_path],
                       check=True, stdout=subprocess.DEVNULL)
        env = dict(os.environ, PI_HARNESS_PINNED_LAUNCHER=launcher)
        # No new session/process group: preserve terminal and Pi signal semantics.
        pending = []
        def forward(signum, _frame):
            if child is not None:
                try:
                    child.send_signal(signum)
                except ProcessLookupError:
                    pass
            else:
                pending.append(signum)
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(signum, forward)
        child = subprocess.Popen([launcher, *sys.argv[2:]], env=env)
        for signum in pending:
            forward(signum, None)
        code = child.wait()
        return code if code >= 0 else 128 - code
    finally:
        # SIGKILL can leave a stale root. Prefer retention to deleting a closure
        # still needed by an orphan. Explicit maintenance may remove dead pins.
        if child is None or child.poll() is not None:
            root.unlink(missing_ok=True)
            directory.rmdir()


if __name__ == "__main__":
    sys.exit(main())
