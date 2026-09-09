import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("preflight", Path(__file__).parents[1] / "scripts/bridge-chat-preflight.py")
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)
OWNER = "@owner:example.com"
SECRET = "never-print-this-secret"


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "signal"
        self.endpoint = "http://127.0.0.1:29328"
        self.config()

    def config(self, secret=SECRET):
        self.path.write_text(json.dumps({"bridge": {"permissions": {OWNER: "admin"}, "relay": {"enabled": False}},
                                         "provisioning": {"shared_secret": secret}}))

    def test_whitelisted_report_and_exact_request(self):
        seen = []
        def fetch(endpoint, owner, secret):
            seen.append((endpoint, owner, secret))
            return {"bridge_bot": "secret-identity", "logins": [{"id": "secret-login", "name": "private-name",
                "state": {"state_event": "CONNECTED", "info": {"secret": SECRET}}}]}
        report = preflight.probe(self.path, self.endpoint, OWNER, fetch)
        self.assertEqual(seen, [(self.endpoint, OWNER, SECRET)])
        self.assertEqual(report, {"status": "inspected", "liveMessagePath": "unverified", "relayEnabled": False,
                                 "explicitOwnerPermission": "admin", "loginCount": 1, "connectedLoginCount": 1})
        self.assertNotIn(SECRET, json.dumps(report))

    def test_missing_disabled_unresolved_invalid_secrets_never_request(self):
        for secret, status in [(None, "provisioning_disabled"), ("disable", "provisioning_disabled"),
                               ("$TOKEN", "credential_unresolved"), ("a\nb", "credential_invalid")]:
            with self.subTest(status=status):
                self.config(secret)
                def forbidden(*args):
                    self.fail("must not request")
                self.assertEqual(preflight.probe(self.path, self.endpoint, OWNER, forbidden)["status"], status)

    def test_errors_never_echo_sensitive_data(self):
        def fetch(*args):
            raise ValueError(SECRET + " private URL and response")
        self.assertEqual(preflight.probe(self.path, self.endpoint, OWNER, fetch)["status"], "request_failed")
        self.path.write_text("!!python/object/apply:os.system [echo " + SECRET + "]")
        self.assertEqual(preflight.probe(self.path, self.endpoint, OWNER, fetch)["status"], "config_unavailable")

    def test_malformed_and_disconnected_logins_do_not_report_connected(self):
        for response in [{}, {"logins": "secret"}, {"logins": [None]}, {"logins": [{"state": "invalid"}]}, {"logins": [{}] * 129}]:
            self.assertEqual(preflight.probe(self.path, self.endpoint, OWNER, lambda *args: response)["status"], "request_failed")
        report = preflight.probe(self.path, self.endpoint, OWNER, lambda *args: {"logins": [{"state": {"state_event": "BAD_CREDENTIALS"}}]})
        self.assertEqual(report["connectedLoginCount"], 0)
        self.assertEqual(report["liveMessagePath"], "unverified")

    def test_credential_files_are_bounded_regular_and_no_follow(self):
        target = self.path.with_name("link")
        target.symlink_to(self.path)
        self.assertEqual(preflight.probe(target, self.endpoint, OWNER)["status"], "config_unavailable")
        self.path.write_bytes(b"x" * (preflight.MAX_CONFIG + 1))
        self.assertEqual(preflight.probe(self.path, self.endpoint, OWNER)["status"], "config_unavailable")
        fifo = self.path.with_name("fifo")
        os.mkfifo(fifo)
        self.assertEqual(preflight.probe(fifo, self.endpoint, OWNER)["status"], "config_unavailable")

    def test_only_literal_loopback_endpoints(self):
        for endpoint in ["http://example.com:80", "http://localhost:80", "http://127.0.0.1:80@evil:80", "http://127.0.0.1:80/?token=secret",
                         "http://127.0.0.1:80/path", "http://127.0.0.1:80/#fragment", "http://127.0.0.1:99999", "https://127.0.0.1:80"]:
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                preflight.endpoint_url(endpoint, OWNER)
        self.assertIn("user_id=%40owner%3Aexample.com", preflight.endpoint_url("http://[::1]:1234", OWNER))

    def test_real_http_get_redaction_redirect_and_response_bound(self):
        calls = []
        mode = ["ok"]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                calls.append((self.command, self.path, self.headers.get("Authorization")))
                if mode[0] == "redirect":
                    self.send_response(302)
                    self.send_header("Location", "/must-not-follow")
                    self.end_headers()
                    return
                self.send_response(401 if mode[0] == "unauthorized" else 200)
                self.end_headers()
                if mode[0] == "slow":
                    try:
                        for _ in range(100):
                            self.wfile.write(b" ")
                            self.wfile.flush()
                            time.sleep(0.01)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    return
                self.wfile.write(b"x" * (preflight.MAX_RESPONSE + 1) if mode[0] == "huge" else b'{"logins":[]}')
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            endpoint = "http://127.0.0.1:" + str(server.server_port)
            with patch.dict(os.environ, {"http_proxy": "http://invalid.example:1", "no_proxy": ""}):
                for value, expected in [("ok", "inspected"), ("redirect", "http_error"), ("unauthorized", "unauthorized"), ("huge", "request_failed")]:
                    mode[0] = value
                    report = preflight.probe(self.path, endpoint, OWNER)
                    self.assertEqual(report["status"], expected)
                    self.assertNotIn(SECRET, json.dumps(report))
            mode[0] = "slow"
            with patch.object(preflight, "PROBE_TIMEOUT_SECONDS", 0.03):
                self.assertEqual(preflight.timed_probe(self.path, endpoint, OWNER)["status"], "probe_timed_out")
            self.assertEqual(len(calls), 5)
            self.assertTrue(all(call == ("GET", "/_matrix/provision/v3/whoami?user_id=%40owner%3Aexample.com", "Bearer " + SECRET) for call in calls))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_absolute_deadline_returns_report_and_cancels_alarm(self):
        def stalled(*args):
            while True:
                time.sleep(0.005)
        with patch.object(preflight, "PROBE_TIMEOUT_SECONDS", 0.03), patch.object(preflight, "probe", stalled):
            reports = [preflight.timed_probe(self.path, self.endpoint, OWNER) for _ in range(8)]
        self.assertTrue(all(report["status"] == "probe_timed_out" for report in reports))
        self.assertEqual(preflight.signal.getitimer(preflight.signal.ITIMER_REAL)[0], 0)

    def test_main_no_identity_output_and_invalid_settings(self):
        settings = self.path.with_name("settings.json")
        settings.write_text(json.dumps({"ownerUserId": OWNER, "bridges": {"signal": self.endpoint}}))
        # Disable remote requests while exercising the real entrypoint.
        self.config("disable")
        output = io.StringIO()
        with patch.dict(os.environ, {"CREDENTIALS_DIRECTORY": self.directory.name}), patch.object(preflight.sys, "argv", ["preflight", str(settings)]), contextlib.redirect_stdout(output):
            self.assertEqual(preflight.main(), 0)
        self.assertNotIn(OWNER, output.getvalue())
        self.assertNotIn("signal", output.getvalue())
        self.assertEqual(json.loads(output.getvalue())["bridges"]["bridge-1"]["status"], "provisioning_disabled")
        settings.write_text(json.dumps({"ownerUserId": OWNER, "bridges": {"../signal": self.endpoint}}))
        with patch.dict(os.environ, {"CREDENTIALS_DIRECTORY": self.directory.name}), patch.object(preflight.sys, "argv", ["preflight", str(settings)]), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(preflight.main(), 1)


if __name__ == "__main__":
    unittest.main()
