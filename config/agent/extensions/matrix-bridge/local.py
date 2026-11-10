#!/usr/bin/env python3
"""Local native-session list/open/status. No relay, Matrix or lifecycle registry.

All execution is fixed argv. Locks are kernel-held; on-disk contents are only
advisory window display data. Never signal a PID or terminate a window here.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time


def locks():
    directory = Path(os.environ.get("PI_SESSION_LOCK_DIRECTORY", str(Path.home() / ".cache/pi-session-locks")))
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("native session lock directory must be private and owned by this user")
    return directory


@contextlib.contextmanager
def lock(file, suffix=".lock"):
    key = hashlib.sha256(str(Path(file).resolve()).encode()).hexdigest()
    fd = os.open(locks() / (key + suffix), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
            raise ValueError("unsafe native session lock file")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False, fd
        else:
            yield True, fd
    finally:
        os.close(fd)


def read_session(file):
    file = Path(file).resolve(strict=True)
    info = file.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("native session must be a regular file, not a hard link")
    header = None
    title = None
    with file.open(encoding="utf-8") as source:
        for line in source:
            if not line.strip():
                continue
            entry = json.loads(line)
            if not isinstance(entry, dict):
                raise ValueError("malformed native session")
            if header is None:
                if entry.get("type") != "session" or not isinstance(entry.get("id"), str) or not isinstance(entry.get("cwd"), str):
                    raise ValueError("invalid native session header")
                header = entry
            elif entry.get("type") == "session_info" and isinstance(entry.get("name"), str):
                title = entry["name"]
    if header is None:
        raise ValueError("empty native session")
    return {"file": str(file), "id": header["id"], "cwd": header["cwd"], "title": title or Path(header["cwd"]).name or "Pi", "modified": info.st_mtime}


def tmux(*args, timeout=5):
    env = dict(os.environ)
    env.pop("TMUX", None)
    env.pop("TMUX_PANE", None)
    if "PI_BRIDGE_TMUX_SOCKET" in env:
        command = [env.get("PI_BRIDGE_TMUX", "tmux"), "-S", env["PI_BRIDGE_TMUX_SOCKET"]]
    else:
        command = [env.get("PI_BRIDGE_TMUX", "tmux")]
        if env.get("XDG_RUNTIME_DIR"):
            env["TMUX_TMPDIR"] = env["XDG_RUNTIME_DIR"]
    result = subprocess.run(command + list(args), env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        # Local-only diagnostics: never print argv/environment or remote bodies.
        detail = " ".join(result.stderr.split())[:400]
        raise RuntimeError(f"tmux {args[0]} failed (exit {result.returncode}): {detail}")
    return result.stdout.strip()


def observe(file):
    with lock(file) as (available, fd):
        if available:
            return {"running": False}
        try:
            owner = json.loads(os.read(fd, 4096))
        except (ValueError, OSError):
            return {"running": True}
    result = {"running": True}
    pane = owner.get("pane")
    if not isinstance(pane, str) or not pane.startswith("%") or not pane[1:].isdigit():
        return result
    try:
        fields = tmux("display-message", "-p", "-t", pane, "#{pane_id}\t#{pid}\t#{pane_dead}").split("\t")
        # Server identity is only a focus hint, never permission to stop a process.
        if len(fields) == 3 and fields[0] == pane and fields[1] == str(owner.get("serverPid")) and fields[2] == "0":
            result["pane"] = pane
    except (RuntimeError, subprocess.TimeoutExpired):
        pass
    return result


def open_session(file):
    saved = read_session(file)
    if not Path(saved["cwd"]).is_dir():
        raise ValueError("native session workspace is missing; history was not changed")
    with lock(saved["file"], ".open.lock") as (admitted, _):
        if not admitted:
            raise RuntimeError("another local open is in progress; retry shortly")
        observed = observe(saved["file"])
        if observed["running"]:
            return {**saved, **observed}
        launcher = os.environ.get("PI_BRIDGE_PI")
        if not launcher or not Path(launcher).is_absolute():
            raise ValueError("PI_BRIDGE_PI must name the packaged native Pi launcher")
        cwd = str(Path(saved["cwd"]).resolve())
        group = "pi-" + hashlib.sha256(cwd.encode()).hexdigest()[:16]
        try:
            existing = tmux("list-sessions", "-F", "#{session_name}").splitlines()
        except RuntimeError:
            existing = []
        args = [launcher, "--session", saved["file"]]
        if os.environ.get("PI_BRIDGE_DIRENV"):
            args = [os.environ["PI_BRIDGE_DIRENV"], "exec", cwd] + args
        common = ["-d", "-P", "-F", "#{pane_id}", "-c", cwd, "-n", "Pi"]
        if group in existing:
            pane = tmux("new-window", "-t", group + ":", *common, "--", *args)
        else:
            pane = tmux("new-session", "-s", group, *common, "--", *args)
        # Holding this transient open lock joins ordinary concurrent calls. Pi
        # itself owns the session lock, so an interrupted launcher cannot leave
        # a permanent reservation or admit a second writer after a slow start.
        until = time.monotonic() + 10
        while time.monotonic() < until:
            observed = observe(saved["file"])
            if observed["running"]:
                return {**saved, **observed}
            try:
                if tmux("display-message", "-p", "-t", pane, "#{pane_dead}") == "1":
                    raise RuntimeError("Pi exited before acquiring its native session; inspect the failed terminal")
            except RuntimeError as error:
                raise RuntimeError("Pi window exited before session ownership; retry is safe") from error
            time.sleep(.05)
        return {**saved, "running": False, "pending": True, "pane": pane}


def list_sessions():
    roots = json.loads(os.environ.get("PI_BRIDGE_SESSION_ROOTS", "[]"))
    if not roots:
        roots = [str(Path.home() / ".pi/agent/sessions")]
    seen = set()
    rows = []
    for root in roots:
        for file in Path(root).rglob("*.jsonl"):
            try:
                saved = read_session(file)
                if saved["file"] in seen:
                    continue
                seen.add(saved["file"])
                rows.append({**saved, **observe(saved["file"])})
            except (ValueError, OSError):
                # A bad historical file must not hide unrelated local sessions.
                continue
    return sorted(rows, key=lambda r: (-r["modified"], r["file"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["list", "open", "status"])
    parser.add_argument("file", nargs="?")
    args = parser.parse_args()
    try:
        if args.operation == "list":
            if args.file:
                raise ValueError("list takes no session file")
            result = list_sessions()
        else:
            if not args.file:
                raise ValueError("a native session file is required")
            result = open_session(args.file) if args.operation == "open" else {**read_session(args.file), **observe(args.file)}
        print(json.dumps(result))
    except (ValueError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
