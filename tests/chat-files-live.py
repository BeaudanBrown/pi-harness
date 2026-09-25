"""Real packaged sandbox smoke test. Downloads one public W3C sample PDF; never sends/publishes."""
import base64
import os
import pathlib
import subprocess
import sys
import tempfile

package = pathlib.Path(sys.argv[1])
with tempfile.TemporaryDirectory(prefix='pi-chat-download-live-') as directory:
    root = pathlib.Path(directory)
    # No silently unsandboxed fallback, even when the requested host is local.
    denied = subprocess.run([str(package / 'bin/pi-chat-download'), directory], input=b'https://127.0.0.1/', capture_output=True, timeout=100)
    assert denied.returncode != 0 and not (root / 'payload').exists()
    missing = subprocess.run([str(package / 'bin/pi-chat-download'), directory + '/missing'], input=b'https://www.w3.org/', capture_output=True, timeout=10)
    assert missing.returncode != 0
    result = subprocess.run([str(package / 'bin/pi-chat-download'), directory], input=b'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', capture_output=True, timeout=100, env={**os.environ, 'HTTPS_PROXY': 'http://127.0.0.1:1', 'CHAT_SECRET_CANARY': 'not-for-child'})
    assert result.returncode == 0, result.stderr.decode()
    data = (root / 'payload').read_bytes()
    assert data.startswith(b'%PDF-') and b'%%EOF' in data[-2048:] and 0 < len(data) <= 25 * 1024 * 1024
    print('PASS: immutable isolated public HTTPS downloader, private-host rejection and fail-closed setup')
    sentinel = root / 'outside.txt'
    sentinel.write_text('private')
    outside = subprocess.run([str(package / 'bin/pi-chat-image'), str(sentinel), 'info:'], capture_output=True, timeout=15)
    assert outside.returncode != 0
    # Real image decoder has no host filesystem or network namespace access.
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')
    decoded = subprocess.run([str(package / 'bin/pi-chat-image'), 'png:-', '-format', '%m %w %h', 'info:'], input=png, capture_output=True, timeout=15)
    assert decoded.returncode == 0 and decoded.stdout == b'PNG 1 1', decoded.stderr.decode()
    print('PASS: isolated image decoder and host-file denial')
