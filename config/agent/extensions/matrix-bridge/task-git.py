"""Finite Git waiter for task-worker.ts's fixed argv; not a host dispatcher.

FD 3 was locked BEFORE spawning this process. Its atomic inheritance closes the
helper-death gap before Git begins. Git and its hooks never inherit that lease.
"""
import json
import os
import subprocess
import sys

os.fstat(3)  # Fail before executing if the caller did not transfer its lease.
# The interpreter keeps the host environment. Only Git/hooks receive project
# exports. Parent death before a complete request must not start an effect.
request = json.loads(sys.stdin.buffer.read(2 * 1024 * 1024))
child = subprocess.Popen(sys.argv[1:], close_fds=True, env=request["env"], stdin=subprocess.PIPE)
child.communicate(None if request.get("input") is None else request["input"].encode())
code = child.returncode
sys.exit(code if code >= 0 else 128 - code)
