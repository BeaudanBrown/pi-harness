import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1] / 'config/agent/extensions/bridge-chat/workspace.py'
spec = importlib.util.spec_from_file_location('workspace', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


class Files(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.root = self.base / 'project'
        self.state = self.base / 'state'
        self.root.mkdir()
        self.state.mkdir()
        self.worker = module.Workspace(self.root, self.state)
        self.counter = 0

    def tearDown(self):
        self.worker.close()
        self.tmp.cleanup()

    def mutation(self, action, **kwargs):
        self.counter += 1
        request = dict(action=action, id=sha(str(self.counter)), **kwargs)
        return request, self.worker.handle(request)

    def test_read_edit_write_search_rename_delete(self):
        request, result = self.mutation('mkdir', path='content')
        self.assertEqual(result['phase'], 'done')
        _, result = self.mutation('write', path='content/page.md', text='hello world', expected='absent')
        self.assertEqual(result['phase'], 'done')
        self.assertEqual(self.worker.handle(dict(action='read', path='content/page.md')), dict(text='hello world', sha256=sha('hello world')))
        _, result = self.mutation('edit', path='content/page.md', old='world', new='NAS', expected=sha('hello world'))
        self.assertEqual(result['phase'], 'done')
        search = self.worker.handle(dict(action='search', path='.', text='NAS'))
        self.assertTrue(search.get('matches'), search)
        self.assertEqual(search['matches'][0]['path'], 'content/page.md')
        _, result = self.mutation('rename', path='content/page.md', destination='content/new.md', expected=sha('hello NAS'))
        self.assertEqual(result['phase'], 'done')
        self.assertFalse((self.root / 'content/page.md').exists())
        _, result = self.mutation('delete', path='content/new.md', expected=sha('hello NAS'))
        self.assertEqual(result['phase'], 'done')
        self.assertEqual(self.worker.handle(dict(action='list', path='content')), {'entries': [], 'truncated': False})

    def test_all_paths_are_relative_and_no_control_paths(self):
        for path in ('/etc/passwd', '../outside', 'content/../../outside', '.git/config', '.pi/settings.json', '.publishing/requests/x', './file', 'a//b', 'a/./b', 'a\\b', 'a\x00b', '', 'a/' + 'x' * 256):
            with self.subTest(path=path):
                self.assertIn('error', self.worker.handle(dict(action='read', path=path)))
        self.assertIn('error', self.worker.handle(dict(action='rename', id=sha('a'), path='file', destination='../out', expected=sha('x'))))

    def test_no_arbitrary_commands_or_extra_fields(self):
        for request in ({'action': 'bash', 'command': 'id'}, {'action': 'read', 'path': '.', 'root': '/etc'}, {'action': ['read']}, {'action': 'status', 'id': 'bad'}):
            self.assertIn('error', self.worker.handle(request))

    def test_symlinks_hardlinks_and_special_files(self):
        outside = self.base / 'secret'
        outside.write_text('secret')
        (self.root / 'link').symlink_to(outside)
        (self.root / 'dir').symlink_to(self.base, target_is_directory=True)
        os.link(outside, self.root / 'hard')
        os.mkfifo(self.root / 'pipe')
        for path in ('link', 'hard', 'pipe', 'dir/secret'):
            with self.subTest(path=path):
                self.assertIn('error', self.worker.handle(dict(action='read', path=path)))
        self.assertEqual(self.worker.handle(dict(action='list', path='.')), {'entries': [], 'truncated': False})

    def test_write_absent_never_clobbers(self):
        (self.root / 'file').write_text('original')
        _, result = self.mutation('write', path='file', text='bad', expected='absent')
        self.assertEqual(result['phase'], 'uncertain')
        self.assertEqual((self.root / 'file').read_text(), 'original')

    def test_edit_requires_one_match_and_expected_digest(self):
        (self.root / 'file').write_text('same same')
        _, result = self.mutation('edit', path='file', old='same', new='new', expected=sha('same same'))
        self.assertEqual(result['phase'], 'failed')
        self.assertEqual((self.root / 'file').read_text(), 'same same')

    def test_replay_conflict_and_restart(self):
        request, result = self.mutation('write', path='file', text='original', expected='absent')
        (self.root / 'file').write_text('later edit')
        self.assertEqual(self.worker.handle(request), result)
        conflict = dict(request, text='different')
        self.assertEqual(self.worker.handle(conflict), {'error': 'operation_conflict'})
        self.worker.close()
        self.worker = module.Workspace(self.root, self.state)
        self.assertEqual(self.worker.handle(request), result)
        self.assertEqual((self.root / 'file').read_text(), 'later edit')
        self.assertEqual(self.worker.handle({'action': 'status', 'id': request['id']}), result)

    def test_interrupted_mutation_never_repeats_and_blocks_new_writes(self):
        request = dict(action='write', id=sha('crash'), path='file', text='original', expected='absent')
        # Inject a crash after the filesystem side effect but before result commit.
        original = self.worker.execute
        def crash(value):
            original(value)
            raise KeyboardInterrupt()
        with mock.patch.object(self.worker, 'execute', side_effect=crash):
            with self.assertRaises(KeyboardInterrupt):
                self.worker.handle(request)
        self.worker.close()
        self.worker = module.Workspace(self.root, self.state)
        self.assertEqual(self.worker.handle(request), {'phase': 'uncertain', 'result': {}})
        _, result = self.mutation('write', path='another', text='no', expected='absent')
        self.assertEqual(result, {'error': 'reconciliation_required'})
        self.assertFalse((self.root / 'another').exists())
        self.assertEqual((self.root / 'file').read_text(), 'original')
        self.assertEqual(self.worker.handle(dict(action='read', path='file'))['text'], 'original')

    def test_journal_contains_no_file_contents(self):
        self.mutation('write', path='file', text='private-content-canary', expected='absent')
        self.assertNotIn(b'private-content-canary', (self.state / 'operations.sqlite').read_bytes())

    def test_exclusive_process_lock(self):
        with self.assertRaises(BlockingIOError):
            module.Workspace(self.root, self.state)

    def test_project_lock_applies_across_independent_state_directories(self):
        second = self.base / 'second-state'
        second.mkdir()
        with self.assertRaises(BlockingIOError):
            module.Workspace(self.root, second)
        self.assertFalse((second / 'operations.sqlite').exists())

    def test_admitted_writer_cannot_race_commit(self):
        # All admitted writers must hold the project lease. This applies to
        # write/delete/rename alike; arbitrary uncooperative host writers are
        # outside the protocol and must be excluded during deployment.
        import fcntl
        for action in ('write', 'delete', 'rename'):
            with self.subTest(action=action):
                fd = os.open(self.root / '.pi-workspace.lock', os.O_RDWR)
                try:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(fd)

    def test_directory_enumeration_is_bounded_before_materializing(self):
        from types import SimpleNamespace
        class Entries:
            count = 0
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                pass
            def __iter__(self):
                for _ in range(1000000):
                    self.count += 1
                    yield SimpleNamespace(name='.ignored')
        entries = Entries()
        with mock.patch.object(module.os, 'scandir', return_value=entries):
            result = self.worker.handle(dict(action='list', path='.'))
        self.assertEqual(result, {'entries': [], 'truncated': True})
        self.assertEqual(entries.count, module.MAX_ENTRIES + 1)

    def test_listing_byte_budget_returns_explicit_truncation(self):
        for i in range(30):
            (self.root / ('long-name-' + str(i))).write_text('a')
        with mock.patch.object(module, 'MAX_BYTES', 300):
            result = self.worker.handle(dict(action='list', path='.'))
        self.assertTrue(result['truncated'])
        self.assertLess(len(module.encode(result)), 400)

    def test_source_replacement_race_rejected(self):
        (self.root / 'file').write_text('original')
        original = self.worker.replace
        def race(fd, name, data, expected):
            (self.root / 'file').unlink()
            (self.root / 'file').symlink_to(self.base / 'secret')
            return original(fd, name, data, expected)
        (self.base / 'secret').write_text('untouched')
        with mock.patch.object(self.worker, 'replace', side_effect=race):
            _, result = self.mutation('write', path='file', text='changed', expected=sha('original'))
        self.assertEqual(result['phase'], 'failed')
        self.assertEqual((self.base / 'secret').read_text(), 'untouched')

    def test_rename_never_overwrites_existing_destination(self):
        (self.root / 'source').write_text('source')
        (self.root / 'dest').write_text('dest')
        _, result = self.mutation('rename', path='source', destination='dest', expected=sha('source'))
        self.assertEqual(result['phase'], 'uncertain')
        self.assertEqual((self.root / 'dest').read_text(), 'dest')

    def test_bounds(self):
        (self.root / 'large').write_bytes(b'x' * (module.MAX_BYTES + 1))
        self.assertIn('error', self.worker.handle(dict(action='read', path='large')))
        _, result = self.mutation('write', path='file', text='x' * (module.MAX_BYTES + 1), expected='absent')
        self.assertIn('error', result)
        self.assertEqual(self.worker.db.execute('SELECT count(*) FROM operations').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
