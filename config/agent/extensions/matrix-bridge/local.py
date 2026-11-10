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
import sqlite3
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


def lock_path(file, suffix=".lock"):
    return locks() / (hashlib.sha256(str(Path(file).resolve()).encode()).hexdigest() + suffix)


@contextlib.contextmanager
def lock(file, suffix=".lock"):
    fd = os.open(lock_path(file, suffix), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
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


def read_session(file, full=True):
    file = Path(file).resolve(strict=True)
    info = file.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
        raise ValueError("native session must be a user-owned regular file, not a hard link")
    header = None
    title = None
    with file.open(encoding="utf-8") as source:
        for line in source:
            if not line.strip():
                continue
            # Listing/focusing an active file does not validate or parse every
            # message/tool/image. Native resume still validates the full file.
            if header is not None and not full and '"session_info"' not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                if not full and header is not None:
                    continue  # A concurrent partial metadata append is not corruption evidence.
                raise
            if not isinstance(entry, dict):
                raise ValueError("malformed native session")
            if header is None:
                if entry.get("type") != "session" or not isinstance(entry.get("id"), str) or not entry["id"] or not isinstance(entry.get("cwd"), str) or not Path(entry["cwd"]).is_absolute():
                    raise ValueError("invalid native session header")
                header = entry
            elif entry.get("type") == "session_info" and isinstance(entry.get("name"), str):
                title = entry["name"]
    if header is None:
        raise ValueError("empty native session")
    return {"version": 1, "file": str(file), "id": header["id"], "cwd": header["cwd"], "title": title or Path(header["cwd"]).name or "Pi", "modified": info.st_mtime}


def configured_path(value):
    if value == "%h" or value.startswith("%h/"):
        value = str(Path.home()) + value[2:]
    path = Path(value)
    if not path.is_absolute():
        raise ValueError("configured session/state roots must be absolute")
    return path


def presentation():
    """Optional host-local archive view. Its absence never gates native Pi."""
    configured = os.environ.get("PI_BRIDGE_STATE_DIRECTORY")
    if not configured:
        return {}
    connection = None
    try:
        directory = configured_path(configured)
        database = directory / "bridge.sqlite"
        for path, kind in ((directory, stat.S_ISDIR), (database, stat.S_ISREG)):
            info = path.lstat()
            if not kind(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                return {}
        connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=.05)
        result = {}
        for file, value in connection.execute("SELECT file,value FROM bindings"):
            try:
                flags = json.loads(value)
                if isinstance(file, str) and isinstance(flags, dict) and isinstance(flags.get("nativeId"), str):
                    result[file] = {"nativeId": flags["nativeId"], "archived": flags.get("archived")}
            except ValueError:
                continue
        return result
    except (OSError, ValueError, sqlite3.Error):
        return {}
    finally:
        if connection is not None:
            connection.close()


def presentation_flags(saved, view):
    value = view.get(saved["file"], {})
    # Replacing a file must not attach another native identity's archive flag.
    return {"archived": value["archived"]} if value.get("nativeId") == saved["id"] and isinstance(value.get("archived"), bool) else {}


def tmux_socket():
    if os.environ.get("PI_BRIDGE_TMUX_SOCKET"):
        return os.environ["PI_BRIDGE_TMUX_SOCKET"]
    fields = os.environ.get("TMUX", "").split(",")
    return fields[0] if len(fields) == 3 and Path(fields[0]).is_absolute() else None


def tmux(*args, timeout=5):
    env = dict(os.environ)
    env.pop("TMUX", None)
    env.pop("TMUX_PANE", None)
    if tmux_socket():
        command = [env.get("PI_BRIDGE_TMUX", "tmux"), "-u", "-S", tmux_socket()]
    else:
        command = [env.get("PI_BRIDGE_TMUX", "tmux"), "-u"]
        if env.get("XDG_RUNTIME_DIR"):
            env["TMUX_TMPDIR"] = env["XDG_RUNTIME_DIR"]
    if args[0] not in ("new-session", "new-window"):
        command.append("-N")  # A read/annotation cannot create a server after loss.
    # tmux parses trailing semicolons even in an argv array. Every argument in
    # this helper is data (no tmux command sequences), so quote that syntax.
    literal = [arg[:-1] + "\\;" if arg.endswith(";") else arg for arg in args]
    result = subprocess.run(command + literal, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
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
            owner = json.loads(os.read(fd, 32768))
        except (ValueError, OSError):
            return {"running": True}
    result = {"running": True}
    if not isinstance(owner, dict):
        return result
    pane = owner.get("pane")
    if not isinstance(pane, str) or not pane.startswith("%") or not pane[1:].isdigit():
        return result
    try:
        fields = tmux("display-message", "-p", "-t", pane, "#{pane_id}\t#{pid}\t#{pane_dead}").split("\t")
        # Server identity is only a focus hint, never permission to stop a process.
        if len(fields) == 3 and fields[0] == pane and fields[1] == str(owner.get("serverPid")) and fields[2] == "0":
            result["pane"] = pane
            result["serverPid"] = int(fields[1])
    except (RuntimeError, subprocess.TimeoutExpired):
        pass
    return result


def process_birth(pid):
    try:
        value = Path(f"/proc/{int(pid)}/stat").read_text()
        return value[value.rfind(")") + 2:].split()[19]
    except (OSError, ValueError, IndexError):
        return None


def discard_hint(file, pane, server):
    # Once this pane has acquired the file, it is not a bootstrap anymore. The
    # record remains after /new or /resume releases it; it only INVALIDATES a
    # hint here, never establishes current ownership or launch authority.
    try:
        fd = os.open(lock_path(file), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
                return True
            data = os.read(fd, 32768)
            if not data:
                return False
            owner = json.loads(data)
            return not isinstance(owner, dict) or owner.get("pane") == pane and str(owner.get("serverPid")) == server
        finally:
            os.close(fd)
    except FileNotFoundError:
        return False
    except (OSError, ValueError):
        return True  # A corrupt advisory record cannot reserve a session.


def pending_windows():
    # Reconstruct once per inventory, not once per historical file. These are
    # live focus hints, never writer/termination authority or reservations.
    result = {}
    try:
        rows = tmux("list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pid}\t#{@pi_native_launch}")
        for line in rows.splitlines():
            fields = line.split("\t", 4)
            if len(fields) != 5 or fields[2] != "0":
                continue
            try:
                value = json.loads(fields[4])
            except ValueError:
                continue
            if isinstance(value, dict) and isinstance(value.get("file"), str) and value.get("pid") == fields[1] and value.get("server") == fields[3] and value.get("birth") and value["birth"] == process_birth(fields[1]):
                created = value.get("created")
                # A live but wedged bootstrap is not a permanent reservation.
                # A later start still has to acquire the native kernel lock.
                if not isinstance(created, (int, float)) or not 0 <= time.monotonic() - created <= 60 or discard_hint(value["file"], fields[0], fields[3]):
                    continue
                result[value["file"]] = {"running": False, "pending": True, "pane": fields[0], "serverPid": int(fields[3])}
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
        pass
    return result


def mark_pending(file, pane):
    fields = tmux("display-message", "-p", "-t", pane, "#{pane_pid}\t#{pid}").split("\t")
    if len(fields) != 2:
        return
    birth = process_birth(fields[0])
    if birth:
        value = json.dumps({"file": file, "pid": fields[0], "server": fields[1], "birth": birth, "created": time.monotonic()})
        tmux("set-option", "-p", "-t", pane, "@pi_native_launch", value)


def open_session(file, expected_id=None):
    saved = read_session(file, full=False)
    if expected_id is not None and (saved["id"] != expected_id or saved["file"] != str(Path(file).absolute())):
        raise ValueError("selected native session identity/path changed")
    if not Path(saved["cwd"]).is_dir():
        raise ValueError("native session workspace is missing; history was not changed")
    with lock(saved["file"], ".open.lock") as (admitted, _):
        if not admitted:
            raise RuntimeError("another local open is in progress; retry shortly")
        observed = observe(saved["file"])
        if observed["running"]:
            return {**saved, **observed}
        pending = pending_windows().get(saved["file"])
        if pending:
            return {**saved, **pending}
        # Validation is only needed when actually launching. Never read/repair
        # a live writer's partially appended history as an admission condition.
        saved = read_session(saved["file"])
        if expected_id is not None and saved["id"] != expected_id:
            raise ValueError("selected native session identity changed")
        launcher = os.environ.get("PI_BRIDGE_PI")
        if not launcher or not Path(launcher).is_absolute():
            raise ValueError("PI_BRIDGE_PI must name the packaged native Pi launcher")
        cwd = str(Path(saved["cwd"]).resolve())
        args = [launcher, "--session", saved["file"]]
        if os.environ.get("PI_BRIDGE_DIRENV"):
            if not Path(os.environ["PI_BRIDGE_DIRENV"]).is_absolute():
                raise ValueError("direnv must be an absolute executable")
            args = [os.environ["PI_BRIDGE_DIRENV"], "exec", cwd] + args
        window_launcher = os.environ.get("PI_BRIDGE_WINDOW_LAUNCHER")
        if window_launcher:
            if not Path(window_launcher).is_absolute():
                raise ValueError("window launcher must be an absolute executable")
            env = dict(os.environ)
            env.pop("TMUX", None)
            env.pop("TMUX_PANE", None)
            if tmux_socket():
                env["TMUX_PROJECT_SOCKET"] = tmux_socket()
            result = subprocess.run([window_launcher, "native-window"], input=json.dumps({"cwd": cwd, "argv": args}), env=env,
                                    text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
            if result.returncode:
                raise RuntimeError("workspace window creation failed: " + " ".join(result.stderr.split())[:400])
            pane = json.loads(result.stdout)["pane"]
        else:
            group = "pi-" + hashlib.sha256(cwd.encode()).hexdigest()[:16]
            try:
                existing = tmux("list-sessions", "-F", "#{session_name}").splitlines()
            except RuntimeError:
                existing = []
            common = ["-d", "-P", "-F", "#{pane_id}", "-c", cwd, "-n", "Pi"]
            if group in existing:
                pane = tmux("new-window", "-t", group + ":", *common, "--", *args)
            else:
                pane = tmux("new-session", "-s", group, *common, "--", *args)
        if not isinstance(pane, str) or not pane.startswith("%") or not pane[1:].isdigit():
            raise ValueError("window launcher returned an invalid pane")
        mark_pending(saved["file"], pane)
        # Holding this transient open lock joins ordinary concurrent calls. Pi
        # itself owns the session lock, so an interrupted launcher cannot leave
        # a permanent reservation or admit a second writer after a slow start.
        until = time.monotonic() + 10
        while time.monotonic() < until:
            observed = observe(saved["file"])
            if observed["running"]:
                return {**saved, **observed}
            try:
                if tmux("display-message", "-p", "-t", pane, "#{pane_dead}") != "0":
                    raise RuntimeError("Pi exited before acquiring its native session; inspect the failed terminal")
            except RuntimeError as error:
                raise RuntimeError("Pi window exited before session ownership; retry is safe") from error
            time.sleep(.05)
        pending = pending_windows().get(saved["file"])
        if not pending:
            raise RuntimeError("Pi window no longer has a live bootstrap hint; inspect locally and retry")
        return {**saved, **pending}


def list_sessions(include_archived=False):
    roots = json.loads(os.environ.get("PI_BRIDGE_SESSION_ROOTS", "[]"))
    if not roots:
        roots = [str(Path.home() / ".pi/agent/sessions")]
    view = presentation()
    pending = pending_windows()
    files = set(view)
    for root in roots:
        files.update(str(file) for file in configured_path(root).rglob("*.jsonl"))
    seen = set()
    rows = []
    for file in files:
        try:
            saved = read_session(file, full=False)
            if saved["file"] in seen:
                continue
            seen.add(saved["file"])
            flags = presentation_flags(saved, view)
            if flags.get("archived") and not include_archived:
                continue
            observed = observe(saved["file"])
            rows.append({**saved, **flags, **(observed if observed["running"] else pending.get(saved["file"], observed))})
        except (ValueError, OSError):
            # A bad historical file must not hide unrelated local sessions.
            continue
    return sorted(rows, key=lambda r: (-r["modified"], r["file"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["list", "open", "status"])
    parser.add_argument("file", nargs="?")
    parser.add_argument("--expected-id", help="refuse a changed selected native identity/path")
    parser.add_argument("--all", action="store_true", help="include archived native sessions")
    args = parser.parse_args()
    try:
        if args.operation == "list":
            if args.file:
                raise ValueError("list takes no session file")
            if args.expected_id:
                raise ValueError("list takes no expected identity")
            result = list_sessions(args.all)
        else:
            if not args.file:
                raise ValueError("a native session file is required")
            if args.operation == "open":
                result = open_session(args.file, args.expected_id)
            else:
                saved = read_session(args.file, full=False)
                if args.expected_id and (saved["id"] != args.expected_id or saved["file"] != str(Path(args.file).absolute())):
                    raise ValueError("selected native session identity/path changed")
                observed = observe(saved["file"])
                result = {**saved, **presentation_flags(saved, presentation()), **(observed if observed["running"] else pending_windows().get(saved["file"], observed))}
        print(json.dumps(result))
    except (ValueError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
