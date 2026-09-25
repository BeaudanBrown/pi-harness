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


class Files(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.root = self.base / 'project'
        self.root.mkdir()
        self.worker = module.Workspace(self.root)

    def tearDown(self):
        self.worker.close()
        self.tmp.cleanup()

    def call(self, action, **kwargs):
        result = self.worker.handle(dict(action=action, **kwargs))
        self.assertNotIn('error', result)
        return result

    def test_normal_tools_without_ids_digests_or_flow(self):
        self.call('mkdir', path='content')
        self.call('write', path='content/page.md', text='hello world')
        self.assertEqual(self.call('read', path='content/page.md'), {'text': 'hello world'})
        self.call('edit', path='content/page.md', old='world', new='NAS')
        self.assertEqual(self.call('search', path='.', text='NAS')['matches'][0]['path'], 'content/page.md')
        self.call('rename', path='content/page.md', destination='content/new.md')
        self.call('write', path='content/new.md', text='replacement')
        self.call('delete', path='content/new.md')
        self.assertEqual(self.call('list', path='content'), {'entries': [], 'truncated': False})
        self.assertFalse((self.root / '.pi-workspace.lock').exists())

    def test_support_files_and_independent_host_edit(self):
        self.call('write', path='.gitignore', text='public/')
        (self.root / 'file').write_text('host edit')
        self.call('edit', path='file', old='host edit', new='agent edit')
        self.assertEqual((self.root / 'file').read_text(), 'agent edit')

    def test_paths_and_control_files(self):
        for path in ('/etc/passwd', '../outside', 'a/../../outside', '.git/config', '.pi/settings.json', '.publishing/requests/x', './file', 'a//b', 'a/./b', 'a\\b', 'a\x00b', '', 'a/' + 'x' * 256):
            with self.subTest(path=path):
                self.assertIn('error', self.worker.handle(dict(action='read', path=path)))
        self.assertIn('error', self.worker.handle(dict(action='rename', path='file', destination='../out')))

    def test_no_shell_or_extra_fields(self):
        for request in ({'action': 'bash', 'command': 'id'}, {'action': 'read', 'path': '.', 'root': '/etc'}, {'action': ['read']}, {'action': 'command', 'name': 'arbitrary'}):
            self.assertIn('error', self.worker.handle(request))

    def test_only_host_commands_no_model_arguments(self):
        argv = ['/nix/store/test/bin/check', '--fixed']
        self.worker.commands = {'check': argv}
        with mock.patch.object(module, 'run_command', return_value={'exitCode': 0, 'output': 'ok'}) as runner:
            self.assertEqual(self.call('command', name='check')['output'], 'ok')
            runner.assert_called_once_with(argv, self.root, cancelled=None)
            self.assertIn('error', self.worker.handle({'action': 'command', 'name': 'check', 'args': ['--evil']}))

    def test_command_runner_is_bounded_and_clears_environment(self):
        import sys
        with mock.patch.dict(os.environ, {'PRIVATE_CANARY': 'secret'}):
            result = module.run_command([sys.executable, '-c', 'import os;print(os.getenv("PRIVATE_CANARY", "absent"))'], self.root)
        self.assertEqual(result, {'exitCode': 0, 'output': 'absent\n'})
        with self.assertRaises(module.Rejected):
            module.run_command([sys.executable, '-c', 'print("x" * 100000)'], self.root)
        with self.assertRaises(module.Rejected):
            module.run_command([sys.executable, '-c', 'import time;time.sleep(5)'], self.root, timeout=.05)

    def test_command_cancellation_also_covers_closed_stdout(self):
        import sys
        calls = []
        def cancelled():
            calls.append(True)
            return len(calls) > 2
        with self.assertRaisesRegex(module.Rejected, 'command_cancelled'):
            module.run_command([sys.executable, '-c', 'import os,time;os.close(1);os.close(2);time.sleep(5)'], self.root, cancelled=cancelled)

    def test_command_configuration_rejects_project_executable(self):
        with self.assertRaises(module.Rejected):
            module.Workspace(self.root, {'check': ['./check.sh']})

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
                self.assertIn('error', self.worker.handle(dict(action='write', path=path, text='bad')))
        self.assertEqual(self.call('list', path='.'), {'entries': [], 'truncated': False})
        self.assertEqual(outside.read_text(), 'secret')

    def test_edit_requires_one_match_but_does_not_lock_project(self):
        (self.root / 'file').write_text('same same')
        self.assertIn('error', self.worker.handle(dict(action='edit', path='file', old='same', new='new')))
        self.call('write', path='other', text='allowed')

    def test_streaming_enumeration_limit(self):
        from types import SimpleNamespace
        class Entries:
            count = 0
            def __enter__(self): return self
            def __exit__(self, *_args): pass
            def __iter__(self):
                for _ in range(1000000):
                    self.count += 1
                    yield SimpleNamespace(name='.ignored')
        entries = Entries()
        with mock.patch.object(module.os, 'scandir', return_value=entries):
            result = self.call('list', path='.')
        self.assertEqual(result, {'entries': [], 'truncated': True})
        self.assertEqual(entries.count, module.MAX_ENTRIES + 1)

    def test_listing_byte_budget(self):
        for i in range(30): (self.root / ('long-name-' + str(i))).write_text('a')
        with mock.patch.object(module, 'MAX_BYTES', 300): result = self.call('list', path='.')
        self.assertTrue(result['truncated'])
        self.assertLess(len(module.encode(result)), 400)

    def test_replacement_symlink_race_rejected(self):
        (self.root / 'file').write_text('original')
        original = self.worker.replace
        def race(fd, name, data, before):
            (self.root / 'file').unlink()
            (self.root / 'file').symlink_to(self.base / 'secret')
            return original(fd, name, data, before)
        (self.base / 'secret').write_text('untouched')
        with mock.patch.object(self.worker, 'replace', side_effect=race):
            self.assertIn('error', self.worker.handle(dict(action='write', path='file', text='changed')))
        self.assertEqual((self.base / 'secret').read_text(), 'untouched')

    def test_rename_does_not_overwrite(self):
        (self.root / 'source').write_text('source')
        (self.root / 'dest').write_text('dest')
        self.assertIn('error', self.worker.handle(dict(action='rename', path='source', destination='dest')))
        self.assertEqual((self.root / 'dest').read_text(), 'dest')

    def test_bounds(self):
        (self.root / 'large').write_bytes(b'x' * (module.MAX_BYTES + 1))
        self.assertIn('error', self.worker.handle(dict(action='read', path='large')))
        self.assertIn('error', self.worker.handle(dict(action='write', path='file', text='x' * (module.MAX_BYTES + 1))))


if __name__ == '__main__':
    unittest.main()
