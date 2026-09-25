"""One public HTTPS download into an isolated temporary directory. No credentials."""
import http.client
import ipaddress
import os
import socket
import ssl
import sys
import time
import urllib.parse

MAX_BYTES = 25 * 1024 * 1024
MAX_SECONDS = 90


def public_address(value):
    address = ipaddress.ip_address(value)
    if not address.is_global or address.is_multicast or address.is_unspecified:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped or address.sixtofour or address.teredo:
            return False
        if address in ipaddress.ip_network('64:ff9b::/96') or address in ipaddress.ip_network('64:ff9b:1::/48'):
            return False
    return True


def destination(url, resolver=socket.getaddrinfo):
    if not isinstance(url, str) or not url or len(url) > 8192 or any(ord(c) < 33 or ord(c) == 127 for c in url):
        raise ValueError('invalid_url')
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.username is not None or parsed.password is not None or not parsed.hostname or parsed.fragment or parsed.port not in (None, 443):
        raise ValueError('public_https_required')
    host = parsed.hostname.encode('idna').decode('ascii')
    if '%' in host:
        raise ValueError('scoped_address_rejected')
    addresses = {item[4][0] for item in resolver(host, 443, type=socket.SOCK_STREAM)}
    # Reject mixed public/private answers rather than choosing the public one.
    if not addresses or not all(public_address(address) for address in addresses):
        raise ValueError('nonpublic_destination')
    target = parsed.path or '/'
    if parsed.query:
        target += '?' + parsed.query
    return host, sorted(addresses)[0], target


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, address, timeout, context):
        super().__init__(host, 443, timeout=timeout, context=context)
        self.address = address

    def connect(self):
        # Connect to the already checked numeric address. TLS authenticates the
        # original hostname; no second hostname resolution and no proxy env.
        raw = socket.create_connection((self.address, 443), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


def download(url, output, *, resolver=socket.getaddrinfo, connection=PinnedHTTPS, context=None):
    deadline = time.monotonic() + MAX_SECONDS
    context = context or ssl.create_default_context(cafile='/ca.pem')
    for _ in range(6):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError('download_timeout')
        host, address, target = destination(url, resolver)
        client = connection(host, address, min(remaining, 15), context)
        try:
            client.request('GET', target, headers={'Accept-Encoding': 'identity', 'User-Agent': 'Pi-chat-file-fetch/1'})
            response = client.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader('Location')
                if not location:
                    raise ValueError('missing_redirect')
                url = urllib.parse.urljoin(url, location)
                continue  # Every hop resolves and validates again.
            if response.status != 200:
                raise ValueError('download_http_error')
            if response.getheader('Content-Encoding', 'identity').lower() != 'identity':
                raise ValueError('encoded_response_rejected')
            length = response.getheader('Content-Length')
            if length is not None and (not length.isdigit() or int(length) > MAX_BYTES):
                raise ValueError('download_too_large')
            size = 0
            with open(output, 'xb') as stream:
                while True:
                    if time.monotonic() >= deadline:
                        raise ValueError('download_timeout')
                    chunk = response.read(min(65536, MAX_BYTES + 1 - size))
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise ValueError('download_too_large')
                    stream.write(chunk)
            if not size or length is not None and size != int(length):
                raise ValueError('incomplete_download')
            return size
        finally:
            client.close()
    raise ValueError('too_many_redirects')


if __name__ == '__main__':
    os.umask(0o077)
    try:
        url = sys.stdin.buffer.read(8193).decode('utf-8')
        download(url, '/download/payload')
    except Exception:
        # Never log URL query strings, remote bodies or native exceptions.
        try:
            os.unlink('/download/payload')
        except FileNotFoundError:
            pass
        print('Public file download failed.', file=sys.stderr)
        sys.exit(1)
