"""Credential-free, descriptor-rooted file operations. Run ONLY in the packaged sandbox.

One bounded JSON request per Unix connection. The trusted caller supplies a durable
operation id; retries of mutations never execute again. There is no shell/eval,
project code loading, URL fetching, or publication capability in this process.
"""
import contextlib
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import stat
import time
import uuid

MAX_BYTES = 1024 * 1024
MAX_FRAME = 7 * MAX_BYTES
MAX_ENTRIES = 2000
MAX_RECORDS = 10000
MUTATIONS = frozenset(('write', 'edit', 'mkdir', 'rename', 'delete'))
ACTIONS = MUTATIONS | frozenset(('read', 'list', 'search', 'status'))
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
REGULAR = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC


class Rejected(Exception):
    pass


def require(condition, code='invalid_request'):
    if not condition:
        raise Rejected(code)


def parts(path, root=False):
    require(isinstance(path, str) and len(path.encode('utf-8')) <= 4096, 'invalid_path')
    if root and path == '.':
        return []
    value = path.split('/')
    require(value and len(value) <= 32 and all(
        p and not p.startswith('.') and len(p.encode('utf-8')) <= 255
        and not any(ord(c) < 32 or ord(c) == 127 or c == '\\' for c in p)
        for p in value), 'invalid_path')
    return value


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return json.dumps(value, ensure_ascii=True, separators=(',', ':'), sort_keys=True).encode()


class Workspace:
    def __init__(self, root, state):
        self.root = os.open(root, DIRECTORY)
        self.lock = None
        self.project_lock = None
        self.db = None
        try:
            self.project_lock = os.open('.pi-workspace.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.root)
            metadata = os.fstat(self.project_lock)
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1 and metadata.st_uid == os.geteuid(), 'invalid_project_lock')
            fcntl.flock(self.project_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.lock = os.open(str(Path(state) / 'lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.db = sqlite3.connect(str(Path(state) / 'operations.sqlite'))
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.execute('PRAGMA secure_delete=ON')
            self.db.execute('PRAGMA max_page_count=4096')
            self.db.execute('CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, phase TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL)')
            self.db.execute("UPDATE operations SET phase='uncertain', result='{}' WHERE phase='running'")
            self.db.commit()
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None
        if self.lock is not None:
            os.close(self.lock)
            self.lock = None
        if self.project_lock is not None:
            os.close(self.project_lock)
            self.project_lock = None
        if self.root is not None:
            os.close(self.root)
            self.root = None

    @contextlib.contextmanager
    def directory(self, components):
        # A new open description avoids shared directory offsets/cached
        # enumeration state on network and sandbox-backed filesystems.
        fd = os.open('.', DIRECTORY, dir_fd=self.root)
        try:
            for component in components:
                nxt = os.open(component, DIRECTORY, dir_fd=fd)
                os.close(fd)
                fd = nxt
            yield fd
        finally:
            os.close(fd)

    @contextlib.contextmanager
    def parent(self, path):
        components = parts(path)
        with self.directory(components[:-1]) as fd:
            yield fd, components[-1]

    @staticmethod
    def info(fd, name):
        value = os.stat(name, dir_fd=fd, follow_symlinks=False)
        require(stat.S_ISREG(value.st_mode) and value.st_nlink == 1, 'not_single_regular_file')
        require(value.st_size <= MAX_BYTES, 'file_too_large')
        return value

    @staticmethod
    def identity(value):
        return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)

    def load(self, fd, name):
        before = self.info(fd, name)
        source = os.open(name, REGULAR, dir_fd=fd)
        try:
            require(self.identity(before) == self.identity(os.fstat(source)), 'source_changed')
            data = bytearray()
            while True:
                block = os.read(source, min(65536, MAX_BYTES + 1 - len(data)))
                if not block:
                    break
                data.extend(block)
                require(len(data) <= MAX_BYTES, 'file_too_large')
            require(self.identity(before) == self.identity(os.fstat(source)), 'source_changed')
            return bytes(data), before
        finally:
            os.close(source)

    def replace(self, fd, name, data, expected):
        temporary = '.pi-write-' + uuid.uuid4().hex
        target = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=fd)
        try:
            with os.fdopen(target, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            if expected is None:
                # Hard-linking the completed temporary file publishes without
                # overwriting any newly appeared destination (including links).
                os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                os.unlink(temporary, dir_fd=fd)
            else:
                require(self.identity(self.info(fd, name)) == self.identity(expected), 'source_changed')
                os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd)
        finally:
            try:
                os.unlink(temporary, dir_fd=fd)
            except FileNotFoundError:
                pass

    def validate(self, request):
        require(isinstance(request, dict))
        action = request.get('action')
        require(isinstance(action, str) and action in ACTIONS)
        keys = {'action', 'path'}
        if action in MUTATIONS or action == 'status':
            require(isinstance(request.get('id'), str) and re.fullmatch(r'[a-f0-9]{64}', request['id']))
            keys.add('id')
        if action == 'status':
            keys.remove('path')
        elif action == 'write':
            keys |= {'text', 'expected'}
            require(isinstance(request.get('text'), str) and len(request['text'].encode()) <= MAX_BYTES)
            require(request.get('expected') == 'absent' or isinstance(request.get('expected'), str) and re.fullmatch(r'[a-f0-9]{64}', request['expected']))
        elif action == 'edit':
            keys |= {'old', 'new', 'expected'}
            require(all(isinstance(request.get(k), str) and len(request[k].encode()) <= MAX_BYTES for k in ('old', 'new')))
            require(request['old'] and isinstance(request.get('expected'), str) and re.fullmatch(r'[a-f0-9]{64}', request['expected']))
        elif action in ('delete', 'rename'):
            keys.add('expected')
            require(isinstance(request.get('expected'), str) and re.fullmatch(r'[a-f0-9]{64}', request['expected']))
            if action == 'rename':
                keys.add('destination')
                parts(request.get('destination'))
        elif action == 'search':
            keys.add('text')
            require(isinstance(request.get('text'), str) and 0 < len(request['text'].encode()) <= 1024)
        require(set(request) == keys)
        if action != 'status':
            parts(request.get('path'), root=action in ('list', 'search'))
        return action

    def handle(self, request):
        try:
            action = self.validate(request)
            if action == 'status':
                row = self.db.execute('SELECT phase,result FROM operations WHERE id=?', (request['id'],)).fetchone()
                return {'phase': row[0], 'result': json.loads(row[1])} if row else {'phase': 'unknown'}
            if action not in MUTATIONS:
                return self.execute(request)
            fingerprint = digest(encode(request))
            row = self.db.execute('SELECT fingerprint,phase,result FROM operations WHERE id=?', (request['id'],)).fetchone()
            if row:
                require(row[0] == fingerprint, 'operation_conflict')
                return {'phase': row[1], 'result': json.loads(row[2])}
            # Never evict uncertain identities or silently retry after a crash.
            require(not self.db.execute("SELECT 1 FROM operations WHERE phase='uncertain' LIMIT 1").fetchone(), 'reconciliation_required')
            require(self.db.execute('SELECT count(*) FROM operations').fetchone()[0] < MAX_RECORDS, 'journal_full')
            self.db.execute("INSERT INTO operations VALUES (?,?,'running','{}',?)", (request['id'], fingerprint, int(time.time())))
            self.db.commit()
            try:
                result = self.execute(request)
                phase = 'done'
            except (Rejected, UnicodeError) as exc:
                # Semantic preconditions fail before any primary file change.
                result, phase = {'error': str(exc) if isinstance(exc, Rejected) else 'invalid_text'}, 'failed'
            except OSError:
                # An OS error can occur after a filesystem effect (e.g. fsync).
                result, phase = {}, 'uncertain'
            self.db.execute('UPDATE operations SET phase=?,result=? WHERE id=?', (phase, encode(result).decode(), request['id']))
            self.db.commit()
            return {'phase': phase, 'result': result}
        except (Rejected, OSError, UnicodeError) as exc:
            return {'error': str(exc) if isinstance(exc, Rejected) else 'operation_rejected'}

    def entries(self, path):
        rows, scanned, output_bytes = [], 0, 0
        pending = [(parts(path, root=True), path)]
        while pending:
            components, prefix = pending.pop()
            with self.directory(components) as fd:
                names, exhausted = [], False
                # Stream before sorting, counting hidden/rejected names too.
                # Neither a huge directory nor escaped long paths can force an
                # unbounded allocation before we discover a limit.
                with os.scandir(fd) as entries:
                    for entry in entries:
                        scanned += 1
                        if scanned > MAX_ENTRIES:
                            exhausted = True
                            break
                        names.append(entry.name)
                for name in sorted(names):
                    if name.startswith('.'):
                        continue
                    relative = name if prefix == '.' else prefix + '/' + name
                    parts(relative)
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):
                        pending.append((components + [name], relative))
                        kind = 'directory'
                    elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                        kind = 'file'
                    else:
                        continue
                    row = {'path': relative, 'type': kind, 'bytes': info.st_size}
                    output_bytes += len(encode(row)) + 1
                    if output_bytes > MAX_BYTES:
                        return rows, True
                    rows.append(row)
                if exhausted:
                    return rows, True
        return rows, False

    def execute(self, request):
        action, path = request['action'], request['path']
        if action in ('list', 'search'):
            rows, truncated = self.entries(path)
            if action == 'list':
                return {'entries': rows, 'truncated': truncated}
            require(not truncated, 'search_too_large')
            matches = []
            budget = 8 * MAX_BYTES
            for row in rows:
                if row['type'] != 'file' or row['bytes'] > MAX_BYTES:
                    continue
                budget -= row['bytes']
                require(budget >= 0, 'search_too_large')
                with self.parent(row['path']) as (fd, name):
                    data, _ = self.load(fd, name)
                try:
                    text = data.decode('utf-8')
                except UnicodeError:
                    continue
                for number, line in enumerate(text.splitlines(), 1):
                    if request['text'] in line:
                        matches.append({'path': row['path'], 'line': number, 'text': line[:512]})
                        if len(matches) >= 100:
                            return {'matches': matches, 'truncated': True}
            return {'matches': matches, 'truncated': False}
        with self.parent(path) as (fd, name):
            if action == 'mkdir':
                os.mkdir(name, 0o755, dir_fd=fd)
                os.fsync(fd)
                return {'path': path}
            if action == 'write' and request['expected'] == 'absent':
                data, before = request['text'].encode(), None
            else:
                data, before = self.load(fd, name)
                if action == 'read':
                    return {'text': data.decode('utf-8'), 'sha256': digest(data)}
                require(digest(data) == request['expected'], 'source_changed')
                if action == 'write':
                    data = request['text'].encode()
                elif action == 'edit':
                    text = data.decode('utf-8')
                    require(text.count(request['old']) == 1, 'edit_not_unique')
                    data = text.replace(request['old'], request['new'], 1).encode()
                elif action == 'delete':
                    require(self.identity(self.info(fd, name)) == self.identity(before), 'source_changed')
                    os.unlink(name, dir_fd=fd)
                    os.fsync(fd)
                    return {'path': path, 'deleted': True}
                elif action == 'rename':
                    with self.parent(request['destination']) as (dest, dest_name):
                        require(self.identity(self.info(fd, name)) == self.identity(before), 'source_changed')
                        # Linux RENAME_NOREPLACE: no clobber of racing destinations.
                        libc = ctypes.CDLL(None, use_errno=True)
                        rename = libc.renameat2
                        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
                        rename.restype = ctypes.c_int
                        if rename(fd, os.fsencode(name), dest, os.fsencode(dest_name), 1):
                            raise OSError(ctypes.get_errno(), 'rename rejected')
                        os.fsync(fd)
                        os.fsync(dest)
                    return {'path': request['destination'], 'sha256': digest(data)}
            require(len(data) <= MAX_BYTES, 'file_too_large')
            self.replace(fd, name, data, before)
            return {'path': path, 'sha256': digest(data)}


def serve(workspace, path):
    listener = socket.socket(socket.AF_UNIX)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    listener.bind(path)
    os.chmod(path, 0o660)
    listener.listen(4)
    while True:
        connection, _ = listener.accept()
        with connection:
            connection.settimeout(10)
            try:
                data = bytearray()
                while not data.endswith(b'\n'):
                    chunk = connection.recv(min(65536, MAX_FRAME + 1 - len(data)))
                    require(chunk, 'incomplete_request')
                    data.extend(chunk)
                    require(len(data) <= MAX_FRAME, 'request_too_large')
                request = json.loads(data)
                result = workspace.handle(request)
                response = encode(result)
                require(len(response) <= MAX_FRAME, 'response_too_large')
                connection.sendall(response + b'\n')
            except (ValueError, Rejected, OSError, UnicodeError):
                try:
                    connection.sendall(b'{"error":"request_rejected"}\n')
                except OSError:
                    pass


if __name__ == '__main__':
    # The launcher sets the only supported production paths. No path/command
    # arguments or environment-controlled plugin/resource loading are accepted.
    os.umask(0o077)
    with contextlib.closing(Workspace('/workspace', '/state')) as workspace:
        serve(workspace, '/ipc/workspace.sock')
