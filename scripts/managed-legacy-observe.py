"""Read-only legacy exit evidence. Never adopts, marks, closes or signals a window.

Only the relay calls this fixed launcher operation. Evidence authorizes clearing
stale metadata after manual closure, never termination of the observed processes.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

MAX_PROCESSES = 256
FORMAT = "#{session_name}|#{window_id}|#{pane_id}|#{pane_pid}|#{@managed_pi_conversation_id}|#{@managed_pi_launch_id}|#{window_panes}|#{window_linked}|#{pane_dead}"


def birth(proc, pid):
    try:
        text = (proc / str(pid) / "stat").read_text()
    except FileNotFoundError:
        return None
    fields = text[text.rindex(")") + 2:].split()
    return {"pid": str(pid), "startTicks": fields[19]}, int(fields[1]), fields[0]


def inventory(proc, conversation_id, session_file, unreadable=None, session_directory=None):
    rows = {}
    matches = set()
    for path in proc.iterdir():
        if not path.name.isdecimal():
            continue
        try:
            if path.stat().st_uid != os.getuid():
                continue
            before = birth(proc, path.name)
            if before is None:
                continue
            # Zombies cannot write; their process identity still remains evidence.
            if before[2] == "Z":
                env, argv = [], []
            else:
                env_bytes = (path / "environ").read_bytes()
                argv_bytes = (path / "cmdline").read_bytes()
                if len(env_bytes) > 1024 * 1024 or len(argv_bytes) > 1024 * 1024:
                    raise ValueError("process inventory exceeds bounds")
                env, argv = env_bytes.split(b"\0"), argv_bytes.split(b"\0")
            after = birth(proc, path.name)
            # Scheduling state (e.g. sleeping -> running) is not identity.
            # Keep birth/parent fencing and reject changes to the zombie branch
            # above, which determines whether environment/arguments are read.
            if after is None or before[:2] != after[:2] or (before[2] == "Z") != (after[2] == "Z"):
                raise ValueError("process inventory changed; retry")
            rows[path.name] = (before[0], before[1])
            if (f"PI_MANAGED_SESSION_CONVERSATION_ID={conversation_id}".encode() in env
                    or f"PI_MANAGED_PROJECT_SESSION_FILE={session_file}".encode() in env
                    or any(arg == os.fsencode(session_file) and i > 0 and argv[i - 1] == b"--session" for i, arg in enumerate(argv))
                    or session_directory and (any(entry.startswith(b"PI_MANAGED_PROJECT_SESSION_FILE=" + os.fsencode(session_directory) + b"/") for entry in env)
                        or any(arg.startswith(os.fsencode(session_directory) + b"/") and i > 0 and argv[i - 1] == b"--session" for i, arg in enumerate(argv)))):
                matches.add(path.name)
        except FileNotFoundError:
            continue
        except PermissionError:
            if unreadable is None:
                raise
            unreadable.append(path.name)
            if len(unreadable) > MAX_PROCESSES:
                raise ValueError("unreadable process inventory exceeds bounds")
    return rows, matches


def observe_manual(request, panes, proc=Path("/proc")):
    if set(request) != {"conversationId", "window", "sessionDirectory", "manualClosure"} or request["manualClosure"] is not True:
        raise ValueError("invalid manual observation request")
    cid, window, directory = request["conversationId"], request["window"], request["sessionDirectory"]
    if not re.fullmatch(r"conv_[a-f0-9]{32}", cid) or not isinstance(directory, str) or not directory.startswith("/") or Path(directory).name != cid:
        raise ValueError("invalid manual observation identity")
    if set(window) != {"sessionName", "windowId", "paneId"} or not re.fullmatch(r"@[0-9]+", window["windowId"]) or not re.fullmatch(r"%[0-9]+", window["paneId"]):
        raise ValueError("invalid saved window")
    lines = [line.split("|") for line in panes.splitlines() if line]
    if any(len(line) != 9 for line in lines):
        raise ValueError("ambiguous tmux inventory")
    unreadable = []
    _, writers = inventory(proc, cid, directory + "/session.jsonl", unreadable, directory)
    conflicts = bool(writers or any(line[4] == cid or line[1] == window["windowId"] or line[2] == window["paneId"] for line in lines))
    return {"conflicts": conflicts, "unreadableProcesses": sorted(unreadable, key=int),
            "bootId": (proc / "sys/kernel/random/boot_id").read_text().strip()}


def observe(request, panes, proc=Path("/proc")):
    if "manualClosure" in request:
        return observe_manual(request, panes, proc)
    if set(request) not in ({"conversationId", "window", "sessionFile"}, {"conversationId", "window", "sessionFile", "evidence"}):
        raise ValueError("invalid observation request")
    cid, window, session = request["conversationId"], request["window"], request["sessionFile"]
    if not re.fullmatch(r"conv_[a-f0-9]{32}", cid) or not isinstance(session, str) or not session.startswith("/"):
        raise ValueError("invalid observation identity")
    if (set(window) != {"sessionName", "windowId", "paneId"} or not re.fullmatch(r"@[0-9]+", window["windowId"])
            or not re.fullmatch(r"%[0-9]+", window["paneId"])):
        raise ValueError("invalid saved window")
    lines = [line.split("|") for line in panes.splitlines() if line]
    if any(len(line) != 9 for line in lines):
        raise ValueError("ambiguous tmux inventory")
    matching = [line for line in lines if line[4] == cid]
    boot = (proc / "sys/kernel/random/boot_id").read_text().strip()
    rows, writers = inventory(proc, cid, session)
    if "evidence" in request:
        evidence = request["evidence"]
        if (set(evidence) != {"bootId", "processes"} or not re.fullmatch(r"[a-f0-9-]{36}", evidence["bootId"])
                or not 1 <= len(evidence["processes"]) <= MAX_PROCESSES):
            raise ValueError("invalid exit evidence")
        for item in evidence["processes"]:
            if set(item) != {"pid", "startTicks"} or not re.fullmatch(r"[1-9][0-9]*", item["pid"]) or not re.fullmatch(r"[0-9]+", item["startTicks"]):
                raise ValueError("invalid process evidence")
        alive = boot == evidence["bootId"] and any(rows.get(p["pid"], (None,))[0] == p for p in evidence["processes"])
        # Even an unrelated replacement in the old window blocks recovery. The
        # operator must close the original window, not just disconnect its Pi.
        retained = matching or any(line[1] == window["windowId"] for line in lines)
        return {"state": "running" if alive or writers or retained else "gone"}
    if len(matching) != 1:
        raise ValueError("legacy window is absent or ambiguous; exit evidence cannot be captured")
    line = matching[0]
    if line[0] != window["sessionName"] or line[1] != window["windowId"] or line[5] or line[6:] != ["1", "0", "0"]:
        raise ValueError("legacy window changed or is not a single live unlinked pane")
    if line[3] not in rows:
        raise ValueError("legacy pane process is unavailable")
    tree = {line[3]}
    while True:
        expanded = tree | {pid for pid, (_, parent) in rows.items() if str(parent) in tree}
        if expanded == tree:
            break
        tree = expanded
    # A reusable marker/window ID alone is insufficient even for capturing exit
    # evidence. The current pane tree must carry this exact conversation/session
    # identity. The persisted pane ID may be stale; it is never used as authority
    # to adopt or signal either the old or the currently observed process.
    if not tree.intersection(writers):
        raise ValueError("current pane has no matching conversation/session process")
    captured = tree | writers
    # Include descendants of detached identity-bearing writers as well.
    while True:
        expanded = captured | {pid for pid, (_, parent) in rows.items() if str(parent) in captured}
        if expanded == captured:
            break
        captured = expanded
    if len(captured) > MAX_PROCESSES:
        raise ValueError("legacy process tree exceeds bounds")
    return {"bootId": boot, "processes": [rows[pid][0] for pid in sorted(captured, key=int)]}


def main():
    if os.environ.get("TMUX") or os.environ.get("TMUX_PANE"):
        raise ValueError("attached tmux targets are forbidden")
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime or os.environ.get("TMUX_TMPDIR") != runtime:
        raise ValueError("managed tmux runtime is unavailable")
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError("request exceeds bounds")
    request = json.loads(raw)
    def panes():
        result = subprocess.run([sys.argv[1], "list-panes", "-a", "-F", FORMAT], check=True, capture_output=True, timeout=5)
        if len(result.stdout) > 65536:
            raise ValueError("tmux inventory exceeds bounds")
        return result.stdout.decode()
    first = panes()
    result = observe(request, first)
    if panes() != first:
        raise ValueError("tmux inventory changed; retry")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never expose process arguments, environment, paths or subprocess stderr.
        print("Legacy exit inspection unavailable; inspect the original window manually", file=sys.stderr)
        sys.exit(1)
