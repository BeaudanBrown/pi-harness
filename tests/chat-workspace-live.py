"""Run the real immutable package against disposable fixtures; no host service activation."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time


def ask(path, request):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(5)
        client.connect(str(path))
        client.sendall(json.dumps(request).encode() + b'\n')
        data = bytearray()
        while not data.endswith(b'\n'):
            chunk = client.recv(65536)
            assert chunk, 'unexpected close'
            data.extend(chunk)
        return json.loads(data)


def descendants(pid):
    values = {pid}
    for _ in range(10):
        previous = set(values)
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit():
                continue
            try:
                status = (entry / 'status').read_text()
                parent = next(int(line.split()[1]) for line in status.splitlines() if line.startswith('PPid:'))
                if parent in values:
                    values.add(int(entry.name))
            except (OSError, StopIteration):
                pass
        if values == previous:
            break
    return values


def main(launcher, command=None):
    with tempfile.TemporaryDirectory(prefix='pi-workspace-live-') as temporary:
        base = Path(temporary).resolve()
        root, ipc = [base / p for p in ('project', 'ipc')]
        for path in (root, ipc):
            path.mkdir()
        (root / 'hello.txt').write_text('hello')
        for name in ('.git', '.pi', '.agents', '.publishing'):
            (root / name).mkdir()
            (root / name / 'private').write_text('control-secret')
        outside = base / 'outside-secret'
        outside.write_text('outside-canary')
        (root / 'escape').symlink_to(outside)
        with (base / 'stderr').open('w+') as errors:
            process = subprocess.Popen([launcher, str(root), str(ipc)], stdout=subprocess.DEVNULL,
                                       stderr=errors, start_new_session=True,
                                       env={**os.environ, 'PI_WORKSPACE_SECRET_CANARY': 'must-not-enter'})
            try:
                endpoint = ipc / 'workspace.sock'
                deadline = time.monotonic() + 15
                while not endpoint.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(.05)
                if not endpoint.exists():
                    errors.seek(0)
                    raise AssertionError('packaged sandbox did not start: ' + errors.read()[-2000:])
                assert ask(endpoint, {'action': 'read', 'path': 'hello.txt'})['text'] == 'hello'
                for path in (str(outside), '../outside-secret', 'escape', '.pi/private', '.publishing/private'):
                    assert 'error' in ask(endpoint, {'action': 'read', 'path': path}), path
                request = {'action': 'write', 'path': 'new.txt', 'text': 'new'}
                result = ask(endpoint, request)
                assert result == {'path': 'new.txt'}, result
                assert (root / 'new.txt').read_text() == 'new'
                if command:
                    result = ask(endpoint, {'action': 'command', 'name': command})
                    assert result == {'exitCode': 0, 'output': 'host-approved command works\n'}, result
                    assert 'error' in ask(endpoint, {'action': 'command', 'name': command, 'args': ['bad']})
                # Inspect actual worker namespaces/environment and mounted view,
                # not just path validation responses from the public interface.
                workers = []
                for pid in descendants(process.pid):
                    try:
                        args = (Path('/proc') / str(pid) / 'cmdline').read_bytes().split(b'\0')
                        if any(arg.endswith(b'-workspace.py') for arg in args):
                            workers.append(pid)
                    except OSError:
                        pass
                assert workers, 'worker process not found'
                pid = workers[-1]
                proc = Path('/proc') / str(pid)
                for namespace in ('mnt', 'net', 'pid', 'user'):
                    assert os.readlink(proc / 'ns' / namespace) != os.readlink(Path('/proc/self/ns') / namespace), namespace
                assert b'PI_WORKSPACE_SECRET_CANARY' not in (proc / 'environ').read_bytes()
                view = proc / 'root'
                assert not (view / str(outside).lstrip('/')).exists()
                assert not (view / 'home').exists()
                for name in ('.git', '.pi', '.agents', '.publishing'):
                    assert list((view / 'workspace' / name).iterdir()) == [], name
                assert len((proc / 'net/route').read_text().splitlines()) == 1, 'unexpected route'
                print('PASS: packaged read/write, outside/control denial, private namespaces, clean environment and selective mounts')
            finally:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
        # Launcher validation failures cannot mutate even if supplied paths overlap.
        failed = subprocess.run([launcher, str(root), str(root)], capture_output=True, timeout=10)
        assert failed.returncode != 0
        assert not (root / 'operations.sqlite').exists()
        print('PASS: invalid sandbox setup fails closed without executing worker')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
