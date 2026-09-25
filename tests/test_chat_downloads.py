import importlib.util
import io
import pathlib
import socket
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('chat_download', pathlib.Path(__file__).resolve().parents[1] / 'config/agent/extensions/bridge-chat/download.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def dns(*addresses):
    return lambda *args, **kwargs: [(socket.AF_INET6 if ':' in address else socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, 443)) for address in addresses]


class Response:
    def __init__(self, status=200, data=b'%PDF-1.4\nexample\n%%EOF\n', **headers):
        self.status = status
        self.body = io.BytesIO(data)
        self.headers = headers

    def getheader(self, key, default=None):
        return self.headers.get(key, default)

    def read(self, size):
        return self.body.read(size)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.target = pathlib.Path(self.temp.name) / 'payload'
        self.connections = []

    def run_download(self, responses, url='https://example.org/file.pdf', resolver=None):
        parent = self

        class Connection:
            def __init__(self, host, address, timeout, context):
                parent.connections.append((host, address))

            def request(self, method, target, headers):
                parent.assertEqual(method, 'GET')
                parent.assertEqual(headers['Accept-Encoding'], 'identity')
                parent.assertNotIn('Authorization', headers)

            def getresponse(self):
                return responses.pop(0)

            def close(self):
                pass

        return module.download(url, self.target, resolver=resolver or dns('93.184.216.34'), connection=Connection, context=object())

    def test_public_download_is_bounded_and_pinned(self):
        size = self.run_download([Response()])
        self.assertEqual(size, self.target.stat().st_size)
        self.assertEqual(self.connections, [('example.org', '93.184.216.34')])

    def test_rejects_nonpublic_ipv4_ipv6_and_transition_addresses(self):
        for address in ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::1', '2001::1']:
            with self.subTest(address=address), self.assertRaises(ValueError):
                module.destination('https://example.org/', dns(address))
        for address in ['93.184.216.34', '2606:4700:4700::1111']:
            self.assertTrue(module.public_address(address))

    def test_mixed_dns_answers_are_denied(self):
        with self.assertRaises(ValueError):
            module.destination('https://example.org/', dns('93.184.216.34', '127.0.0.1'))

    def test_urls_do_not_accept_credentials_ports_schemes_or_controls(self):
        for url in ['http://example.org/', 'file:///etc/passwd', 'https://user:pass@example.org/', 'https://@example.org/', 'https://example.org:8443/', 'https://example.org/#fragment', 'https://example.org/\r\nX:evil', 'https://[2606:4700:4700::1111%lo]/']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                module.destination(url, dns('93.184.216.34'))

    def test_redirect_resolves_again_and_rejects_rebinding(self):
        calls = 0

        def resolver(*args, **kwargs):
            nonlocal calls
            calls += 1
            return dns('93.184.216.34' if calls == 1 else '127.0.0.1')(*args, **kwargs)

        with self.assertRaises(ValueError):
            self.run_download([Response(302, Location='/next')], resolver=resolver)
        self.assertEqual(len(self.connections), 1)
        self.assertFalse(self.target.exists())

    def test_redirect_limits_and_downgrade_rejection(self):
        for location in ['http://example.org/', 'https://user:pass@example.org/']:
            with self.assertRaises(ValueError):
                self.run_download([Response(302, Location=location)])
        with self.assertRaisesRegex(ValueError, 'too_many_redirects'):
            self.run_download([Response(302, Location='/loop') for _ in range(6)])

    def test_body_and_declared_limits_and_compression(self):
        with patch.object(module, 'MAX_BYTES', 8):
            for response in [Response(data=b'x' * 9), Response(**{'Content-Length': '9'}), Response(**{'Content-Encoding': 'gzip'}), Response(data=b'', **{'Content-Length': '0'}), Response(data=b'abc', **{'Content-Length': '6'})]:
                self.target.unlink(missing_ok=True)
                with self.assertRaises(ValueError):
                    self.run_download([response])

    def test_tls_uses_hostname_but_connects_to_checked_numeric_address(self):
        raw = Mock()
        context = Mock()
        context.wrap_socket.return_value = Mock()
        with patch.object(module.socket, 'create_connection', return_value=raw) as connect:
            client = module.PinnedHTTPS('example.org', '93.184.216.34', 10, context)
            client.connect()
            connect.assert_called_once_with(('93.184.216.34', 443), timeout=10)
            context.wrap_socket.assert_called_once_with(raw, server_hostname='example.org')


if __name__ == '__main__':
    unittest.main()
