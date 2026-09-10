import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
import urllib.error
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("chat", Path(__file__).parents[1] / "scripts/bridge-chat-transport.py")
chat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chat)
NOW = 1800000000000
OWNER = "@owner:example.com"
ROOM = "!one:example.com"
CFG = dict(ownerUserId=OWNER, remoteOwnerUserIds=["@signal_self:example.com"], roomIds=[ROOM], allJoinedRooms=False)


def event(identity="$one", **kwargs):
    return dict(type="m.room.message", sender=OWNER, event_id=identity,
                origin_server_ts=NOW, content=dict(msgtype="m.text", body="!pi question"), **kwargs)


def batch(events, room=ROOM, limited=False, cursor="cursor"):
    return dict(next_batch=cursor, rooms={"join": {room: {"timeline": {"limited": limited, "events": events}}}})


class Matrix:
    def __init__(self):
        self.sent = []
        self.allowed = True
        self.fail_send = False

    def usable(self, *_):
        return self.allowed

    def send(self, room, txn, text):
        self.sent.append((room, txn, text))
        if self.fail_send:
            raise TimeoutError()
        return {"event_id": "$reply"}


class SelectionTests(unittest.TestCase):
    def test_only_exact_owner_question(self):
        self.assertEqual(chat.command(event(), {OWNER}, NOW - 1, NOW), "question")
        for body in ["!pi", "!pi ", "Hi !pi question", "Pi: !pi question", "!pilot question", "!PI question", "!pi " + "é" * 4001, "!pi \x00", "!pi \ud800"]:
            e = event(); e["content"]["body"] = body
            self.assertIsNone(chat.command(e, {OWNER}, NOW - 1, NOW), body)
        e = event(); e["content"]["body"] = "!pi\nnew question"
        self.assertEqual(chat.command(e, {OWNER}, NOW - 1, NOW), "new question")

    def test_rejects_forgery_history_relations_and_media(self):
        mutations = [dict(sender="@stranger:example.com"), dict(sender={}), dict(type="m.room.encrypted"),
            dict(event_id="bad"), dict(origin_server_ts=NOW - chat.MAX_AGE_MS - 1),
            dict(origin_server_ts=NOW + 30001), dict(origin_server_ts=True), dict(unsigned=[]),
            dict(unsigned={"redacted_because": {}}), dict(content=[])]
        for changes in mutations:
            e = event(); e.update(changes)
            self.assertIsNone(chat.command(e, {OWNER}, NOW - chat.MAX_AGE_MS, NOW))
        for key in ["m.relates_to", "m.new_content", "file", "url"]:
            e = event(); e["content"][key] = {}
            self.assertIsNone(chat.command(e, {OWNER}, NOW - 1, NOW))
        e = event(); e["content"]["msgtype"] = "m.image"
        self.assertIsNone(chat.command(e, {OWNER}, NOW - 1, NOW))
        e = event(); e["content"]["owner"] = OWNER; e["sender"] = "@forged:example.com"
        self.assertIsNone(chat.command(e, {OWNER}, NOW - 1, NOW))

    def test_bridge_puppet_is_explicit_not_discovered(self):
        e = event(); e["sender"] = CFG["remoteOwnerUserIds"][0]
        self.assertIsNone(chat.command(e, {OWNER}, NOW - 1, NOW))
        self.assertEqual(chat.command(e, {OWNER, e["sender"]}, NOW - 1, NOW), "question")

    def test_https_and_private_token(self):
        for origin in ["http://example.com", "https://a@b", "https://b/path", "https://b/?token=x", "file:///x"]:
            with self.assertRaises(ValueError):
                chat.Matrix(origin, "secret")
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "token"; p.write_text("secret\n"); p.chmod(0o600)
            self.assertEqual(chat.token_file(p), "secret")
            p.chmod(0o644)
            with self.assertRaises(ValueError): chat.token_file(p)
            p.chmod(0o600); link = Path(d) / "link"; link.symlink_to(p)
            with self.assertRaises(OSError): chat.token_file(link)

    def test_real_http_transport_no_proxy_redirect_or_raw_error(self):
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                seen.append((self.path, self.headers.get('Authorization')))
                if self.path.endswith('/redirect'):
                    self.send_response(302); self.send_header('Location', '/leak'); self.end_headers()
                else:
                    body = b'{"ok":true}'
                    self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with patch.dict(os.environ, {'HTTP_PROXY': 'http://127.0.0.1:1', 'HTTPS_PROXY': 'http://127.0.0.1:1'}):
                client = chat.Matrix('https://matrix.example.com', 'fixture-token')
                client.base = 'http://127.0.0.1:' + str(server.server_port)  # test fixture only
                self.assertEqual(client.request('GET', '/ok'), {'ok': True})
                with self.assertRaises(urllib.error.HTTPError): client.request('GET', '/redirect')
            self.assertEqual(seen, [('/ok', 'Bearer fixture-token'), ('/redirect', 'Bearer fixture-token')])
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_room_state_fails_closed_and_reply_shape(self):
        client = chat.Matrix("https://matrix.example.com", "secret")
        calls = []
        def req(method, path, data=None, query=None):
            calls.append((method, path, data, query))
            if "m.room.encryption" in path:
                raise urllib.error.HTTPError("redacted", 404, "missing", {}, None)
            if "m.room.create" in path: return {}
            return {"membership": "join"}
        client.request = req
        self.assertTrue(client.usable(ROOM, OWNER))
        client.send(ROOM, "pi-hash", "answer")
        self.assertEqual(calls[-1][2], {"msgtype": "m.text", "body": "Pi: answer", "m.mentions": {}})
        client.request = lambda *_a, **_k: {}
        self.assertFalse(client.usable(ROOM, OWNER))
        def denied(*_a, **_k): raise urllib.error.HTTPError("redacted", 403, "denied", {}, None)
        client.request = denied
        with self.assertRaises(urllib.error.HTTPError): client.usable(ROOM, OWNER)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.filename = Path(self.tmp.name) / "state.sqlite"
        self.store = chat.Store(self.filename)
        self.matrix = Matrix()
        historical = event('$bootstrap'); historical['origin_server_ts'] = NOW - 2
        self.store.ingest(batch([historical]), CFG, NOW - 1, fresh=True)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def reopen(self):
        self.store.close()
        self.store = chat.Store(self.filename)

    def rows(self):
        return self.store.db.execute("SELECT * FROM requests ORDER BY created,id").fetchall()

    def accept(self):
        self.store.ingest(batch([event()]), CFG, NOW)

    def test_first_new_limited_and_unauthorized_rooms_discard(self):
        self.assertEqual(len(self.rows()), 0)
        self.store.ingest(batch([event()], limited=True), CFG, NOW)
        self.assertEqual(len(self.rows()), 0)
        all_cfg = dict(CFG, allJoinedRooms=True)
        self.store.ingest(batch([event()], room="!new:example.com"), all_cfg, NOW)
        self.assertEqual(len(self.rows()), 0)
        self.store.ingest(batch([event()], room="!new:example.com"), CFG, NOW)
        self.assertEqual(len(self.rows()), 0)
        self.store.ingest(batch([event()], room="!new:example.com"), all_cfg, NOW)
        self.assertEqual(len(self.rows()), 0)
        newer = event('$newer'); newer['origin_server_ts'] = NOW + 1
        self.store.ingest(batch([newer], room="!new:example.com"), all_cfg, NOW + 1)
        self.assertEqual(len(self.rows()), 1)

    def test_discard_watermarks_survive_replay_and_restart(self):
        cfg = dict(CFG, allJoinedRooms=True)
        for kind in ('initial', 'new', 'limited'):
            room = '!' + kind + ':example.com'
            if kind == 'limited': self.store.ingest(batch([], room=room), cfg, NOW - 1)
            skipped = event('$skipped-' + kind); skipped['origin_server_ts'] = NOW + 1000
            before = len(self.rows())
            self.store.ingest(batch([skipped], room=room, limited=(kind == 'limited')), cfg, NOW, fresh=(kind == 'initial'))
            self.reopen()
            self.store.ingest(batch([skipped], room=room), cfg, NOW + 1001)
            self.assertEqual(len(self.rows()), before, kind)
            newer = event('$subsequent-' + kind); newer['origin_server_ts'] = NOW + 1002
            self.store.ingest(batch([newer], room=room), cfg, NOW + 1002)
            self.assertEqual(len(self.rows()), before + 1, kind)

    def test_dedup_and_only_question_crosses_boundary(self):
        self.accept(); self.accept()
        captured = []
        self.store.step(self.matrix, lambda q: captured.append(q) or "answer", CFG, NOW)
        self.accept()
        self.store.step(self.matrix, lambda _: self.fail("duplicate model"), CFG, NOW)
        self.assertEqual(captured, ["question"])
        self.assertEqual(len(self.matrix.sent), 1)
        self.assertEqual(self.matrix.sent[0][0], ROOM)
        row = self.rows()[0]
        self.assertEqual((row["phase"], row["question"], row["answer"]), ("done", "", ""))

    def test_two_chats_never_share_context_or_destination(self):
        other = '!two:example.com'
        cfg = dict(CFG, roomIds=[ROOM, other])
        self.store.ingest(batch([], room=other), cfg, NOW)
        self.accept()
        second = event('$second'); second['content']['body'] = '!pi separate question'
        second['origin_server_ts'] = NOW + 1
        self.store.ingest(batch([second], room=other), cfg, NOW + 1)
        captured = []
        for _ in range(2): self.store.step(self.matrix, lambda q: captured.append(q) or q, cfg, NOW)
        self.assertEqual(set(captured), {'question', 'separate question'})
        self.assertEqual({r: text for r, _, text in self.matrix.sent}, {ROOM: 'question', other: 'separate question'})

    def test_plain_chatter_never_persists(self):
        e = event(); e["content"]["body"] = "private ordinary chat sentinel"
        self.store.ingest(batch([e]), CFG, NOW)
        self.assertEqual(len(self.rows()), 0)
        self.assertNotIn(b"private ordinary", self.filename.read_bytes())

    def test_sync_acceptance_and_cursor_are_atomic(self):
        bad = batch([event()], cursor="new")
        bad["rooms"]["join"]["!bad"] = {"timeline": []}
        with self.assertRaises(ValueError): self.store.ingest(bad, CFG, NOW)
        self.assertEqual(len(self.rows()), 0)
        self.assertEqual(self.store.get("cursor"), "cursor")

    def test_crash_running_becomes_failure_not_model_retry(self):
        self.accept()
        self.store.phase(self.rows()[0]["id"], "running")
        self.reopen()
        self.store.step(self.matrix, lambda _: self.fail("must not retry model"), CFG, NOW)
        self.assertEqual(self.matrix.sent[0][2], chat.FAILURE)
        self.assertEqual(self.rows()[0]["phase"], "done")

    def test_crash_ready_sends_without_model(self):
        self.accept(); self.store.phase(self.rows()[0]["id"], "ready", "saved answer")
        self.reopen()
        self.store.step(self.matrix, lambda _: self.fail("model"), CFG, NOW)
        self.assertEqual(self.matrix.sent[0][2], "saved answer")

    def test_uncertain_send_never_retries_even_after_restart(self):
        self.accept(); self.matrix.fail_send = True
        self.store.step(self.matrix, lambda _: "answer", CFG, NOW)
        self.assertEqual(self.rows()[0]["phase"], "uncertain")
        self.reopen(); self.accept()
        self.store.step(self.matrix, lambda _: self.fail("model"), CFG, NOW)
        self.assertEqual(len(self.matrix.sent), 1)
        self.assertEqual(self.rows()[0]["answer"], "")

    def test_crash_in_sending_is_uncertain(self):
        self.accept(); self.store.phase(self.rows()[0]["id"], "sending", "answer")
        self.reopen()
        self.store.step(self.matrix, lambda _: self.fail("model"), CFG, NOW)
        self.assertEqual(self.rows()[0]["phase"], "uncertain")
        self.assertEqual(self.matrix.sent, [])

    def test_encryption_change_during_model_prevents_send(self):
        self.accept()
        def execute(_): self.matrix.allowed = False; return "answer"
        self.store.step(self.matrix, execute, CFG, NOW)
        self.assertEqual(self.matrix.sent, [])
        self.assertEqual(self.rows()[0]["phase"], "discarded")

    def test_queue_bound_expiry_and_model_failure(self):
        for i in range(chat.MAX_PENDING + 1):
            self.store.ingest(batch([event("$" + str(i))]), CFG, NOW)
        self.assertEqual(self.store.pending(), chat.MAX_PENDING)
        self.store.step(self.matrix, lambda _: self.fail("expired model"), CFG, NOW + chat.MAX_AGE_MS + 1)
        self.assertIn("expired", self.matrix.sent[0][2])
        def fail(_): raise RuntimeError("secret backend details")
        self.store.step(self.matrix, fail, CFG, NOW)
        self.assertEqual(self.matrix.sent[1][2], chat.FAILURE)

    def test_rejoin_is_discard_only_and_lock_is_exclusive(self):
        self.store.ingest({"next_batch": "left", "rooms": {"leave": {ROOM: {}}}}, CFG, NOW)
        self.accept()
        self.assertEqual(len(self.rows()), 0)
        with self.assertRaises(BlockingIOError): chat.Store(self.filename)

    def test_disallowed_and_encrypted_never_reach_model(self):
        self.accept(); self.matrix.allowed = False
        self.store.step(self.matrix, lambda _: self.fail("model"), CFG, NOW)
        self.assertEqual(self.rows()[0]["phase"], "discarded")
        self.assertEqual(self.matrix.sent, [])

    def test_retention_and_no_resurrection(self):
        self.accept(); self.store.step(self.matrix, lambda _: "answer", CFG, NOW)
        self.store.ingest(batch([event()]), CFG, NOW + 8 * 86400000)
        self.assertEqual(len(self.rows()), 0)


if __name__ == "__main__": unittest.main()
