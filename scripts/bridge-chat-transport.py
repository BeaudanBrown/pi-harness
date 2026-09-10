"""Owner-only Matrix command transport. No model credentials or agent runtime."""
import contextlib
import fcntl
import hashlib
import http.client
import json
import os
import re
import signal
import socket
import sqlite3
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_QUESTION = 8000
MAX_ANSWER = 12000
MAX_AGE_MS = 300000
MAX_PENDING = 8
MAX_RECORDS = 5000
FAILURE = "I couldn't complete that request. Please send a new !pi command to try again."


@contextlib.contextmanager
def deadline(seconds):
    def expired(*_):
        raise TimeoutError("deadline")
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class Matrix:
    def __init__(self, base, token):
        url = urllib.parse.urlsplit(base)
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
            raise ValueError("homeserver must be an HTTPS origin")
        if not token or len(token) > 4096 or re.search(r"\s", token):
            raise ValueError("token")
        self.base = base.rstrip("/") + "/_matrix/client/v3"
        self.token = token
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method, path, data=None, query=None):
        url = self.base + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        req = urllib.request.Request(url, method=method,
            data=None if data is None else json.dumps(data).encode(),
            headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        with deadline(40):
            with self.opener.open(req, timeout=35) as response:
                body = response.read(4 * 1024 * 1024 + 1)
                if len(body) > 4 * 1024 * 1024:
                    raise ValueError("response too large")
                result = json.loads(body)
                if not isinstance(result, dict):
                    raise ValueError("response shape")
                return result

    def usable(self, room, owner):
        prefix = "/rooms/" + urllib.parse.quote(room, safe="") + "/state/"
        try:
            self.request("GET", prefix + "m.room.encryption/")
            return False
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
        creation = self.request("GET", prefix + "m.room.create/")
        member = self.request("GET", prefix + "m.room.member/" + urllib.parse.quote(owner, safe=""))
        return creation.get("type") != "m.space" and member.get("membership") == "join"

    def sync(self, cursor, senders, pending):
        filters = {"presence": {"types": []}, "account_data": {"types": []},
            "room": {"include_leave": True, "account_data": {"types": []},
                "ephemeral": {"types": []}, "state": {"types": []},
                "timeline": {"types": ["m.room.message"], "senders": senders, "limit": 50}}}
        query = {"timeout": 0 if pending or not cursor else 15000,
                 "set_presence": "offline", "filter": json.dumps(filters)}
        if cursor:
            query["since"] = cursor
        return self.request("GET", "/sync", query=query)

    def send(self, room, txn, text):
        return self.request("PUT", "/rooms/" + urllib.parse.quote(room, safe="") +
            "/send/m.room.message/" + txn,
            {"msgtype": "m.text", "body": "Pi: " + text, "m.mentions": {}})


def command(event, senders, floor, now):
    if not isinstance(event, dict) or event.get("type") != "m.room.message" or not isinstance(event.get("sender"), str) or event["sender"] not in senders:
        return None
    if not isinstance(event.get("event_id"), str) or not event["event_id"].startswith("$") or len(event["event_id"]) > 512:
        return None
    ts = event.get("origin_server_ts")
    if type(ts) is not int or ts <= max(floor, now - MAX_AGE_MS) or ts > now + 30000:
        return None
    unsigned = event.get("unsigned", {})
    if not isinstance(unsigned, dict) or "redacted_because" in unsigned:
        return None
    content = event.get("content")
    if not isinstance(content, dict) or content.get("msgtype") != "m.text":
        return None
    if any(k in content for k in ("m.relates_to", "m.new_content", "file", "url")):
        return None
    body = content.get("body")
    if not isinstance(body, str) or not re.match(r"^!pi[ \t\r\n]", body):
        return None
    question = body[4:].strip()
    try:
        if not question or len(question.encode("utf-8")) > MAX_QUESTION or "\x00" in question:
            return None
    except UnicodeError:
        return None
    return question


class Store:
    def __init__(self, filename):
        self.lock = open(str(filename) + ".lock", "a")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception:
            self.lock.close()
            raise
        self.db = sqlite3.connect(filename)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
            PRAGMA synchronous=FULL;
            PRAGMA secure_delete=ON;
            PRAGMA max_page_count=4096;
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, floor INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS requests (
              id TEXT PRIMARY KEY, room TEXT NOT NULL, created INTEGER NOT NULL,
              phase TEXT NOT NULL, question TEXT NOT NULL DEFAULT '', answer TEXT NOT NULL DEFAULT '');
        ''')
        with self.db:
            self.db.execute("UPDATE requests SET phase='ready', question='', answer=? WHERE phase='running'", (FAILURE,))
            self.db.execute("UPDATE requests SET phase='uncertain', question='', answer='' WHERE phase='sending'")

    def close(self):
        self.db.close()
        self.lock.close()

    def get(self, key, default=""):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else default

    def put(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, str(value)))

    def pending(self):
        return self.db.execute("SELECT count(*) FROM requests WHERE phase IN ('queued','ready','running','sending')").fetchone()[0]

    def ingest(self, batch, config, now, fresh=False):
        cursor = batch.get("next_batch")
        joined = batch.get("rooms", {}).get("join", {})
        if not isinstance(cursor, str) or not cursor or len(cursor) > 16384 or not isinstance(joined, dict) or len(joined) > 10000:
            raise ValueError("sync shape")
        senders = {config["ownerUserId"], *config["remoteOwnerUserIds"]}
        floor = int(self.get("floor", str(now)))
        dropped = 0
        with self.db:
            self.db.execute("DELETE FROM requests WHERE created < ? AND phase IN ('done','uncertain','discarded')", (now - 7 * 86400000,))
            if fresh:
                self.db.execute("DELETE FROM rooms")
                self.put("floor", now)
            for room, data in joined.items():
                if not isinstance(room, str) or not room.startswith("!") or len(room) > 512 or not isinstance(data, dict):
                    raise ValueError("room shape")
                known = self.db.execute("SELECT floor FROM rooms WHERE id=?", (room,)).fetchone()
                self.db.execute("INSERT OR IGNORE INTO rooms(id) VALUES (?)", (room,))
                timeline = data.get("timeline", {})
                if not isinstance(timeline, dict):
                    raise ValueError("timeline shape")
                events = timeline.get("events", [])
                if not isinstance(events, list) or len(events) > 50:
                    raise ValueError("events shape")
                if fresh or not known or timeline.get("limited") is not False:
                    # Discard is durable, not just a skipped batch: replayed events
                    # at/before the observed boundary must never become commands.
                    timestamps = [e.get("origin_server_ts") for e in events if isinstance(e, dict)]
                    boundary = max([now] + [ts for ts in timestamps if type(ts) is int and 0 <= ts < 2**63])
                    self.db.execute("UPDATE rooms SET floor=MAX(floor, ?) WHERE id=?", (boundary, room))
                    continue
                if not config["allJoinedRooms"] and room not in config["roomIds"]:
                    continue
                for event in events:
                    question = command(event, senders, max(floor, known["floor"]), now)
                    if question is None:
                        continue
                    identity = hashlib.sha256(json.dumps([room, event["event_id"]]).encode()).hexdigest()
                    if self.db.execute("SELECT 1 FROM requests WHERE id=?", (identity,)).fetchone():
                        continue
                    count = self.db.execute("SELECT count(*) FROM requests").fetchone()[0]
                    if self.pending() >= MAX_PENDING or count >= MAX_RECORDS:
                        dropped += 1
                        continue
                    self.db.execute("INSERT INTO requests(id,room,created,phase,question) VALUES (?,?,?,'queued',?)",
                        (identity, room, event["origin_server_ts"], question))
            # Keep the known-room set bounded, and treat a rejoin as a fresh boundary.
            left = batch.get("rooms", {}).get("leave", {})
            if not isinstance(left, dict) or len(left) > 10000:
                raise ValueError("leave shape")
            for room in left:
                self.db.execute("DELETE FROM rooms WHERE id=?", (room,))
            if self.db.execute("SELECT count(*) FROM rooms").fetchone()[0] > 10000:
                raise ValueError("room capacity")
            self.put("cursor", cursor)
        return dropped

    def phase(self, identity, phase, answer=""):
        with self.db:
            self.db.execute("UPDATE requests SET phase=?, question='', answer=? WHERE id=?", (phase, answer, identity))

    def step(self, matrix, execute, config, now):
        row = self.db.execute("SELECT * FROM requests WHERE phase IN ('queued','ready') ORDER BY created,id LIMIT 1").fetchone()
        if not row:
            return
        identity, room = row["id"], row["room"]
        if row["phase"] == "ready" and now - row["created"] > MAX_AGE_MS:
            self.phase(identity, "discarded")
            return
        if not config["allJoinedRooms"] and room not in config["roomIds"]:
            self.phase(identity, "discarded")
            return
        try:
            usable = matrix.usable(room, config["ownerUserId"])
        except Exception:
            # No model or send on ambiguous room state; retain until a bounded expiry.
            if now - row["created"] > MAX_AGE_MS:
                self.phase(identity, "discarded")
            return
        if not usable:
            self.phase(identity, "discarded")
            return
        result = row["answer"]
        if row["phase"] == "queued":
            self.phase(identity, "running")
            try:
                result = execute(row["question"]) if now - row["created"] <= MAX_AGE_MS else "That request expired. Please send a new !pi command."
                if not isinstance(result, str) or not result or len(result.encode()) > MAX_ANSWER:
                    raise ValueError("answer")
            except Exception:
                result = FAILURE
            self.phase(identity, "ready", result)
        # Encryption/membership can change during model execution. Never send on ambiguity.
        try:
            if not matrix.usable(room, config["ownerUserId"]):
                self.phase(identity, "discarded")
                return
        except Exception:
            return
        self.phase(identity, "sending", result)
        try:
            response = matrix.send(room, "pi-" + identity, result)
            if not isinstance(response.get("event_id"), str) or not response["event_id"].startswith("$"):
                raise ValueError("acknowledgement")
        except Exception:
            self.phase(identity, "uncertain")
            print('{"event":"send_uncertain"}', flush=True)
            return
        self.phase(identity, "done")
        print('{"event":"matrix_reply_accepted","remoteDeliveryVerified":false}', flush=True)


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, filename):
        super().__init__("localhost", timeout=95)
        self.filename = filename

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.filename)


def model_answer(filename, question):
    connection = UnixConnection(filename)
    try:
        with deadline(100):
            connection.request("POST", "/answer", json.dumps({"question": question}), {"Content-Type": "application/json"})
            response = connection.getresponse()
            if response.status != 200:
                raise ValueError("worker unavailable")
            body = response.read(MAX_ANSWER * 6 + 100)
            value = json.loads(body)
            if not isinstance(value, dict) or set(value) != {"answer"}:
                raise ValueError("worker response")
            return value["answer"]
    finally:
        connection.close()


def token_file(filename):
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "r") as file:
        st = os.fstat(file.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o077 or st.st_size > 4097:
            raise ValueError("credential")
        return file.read(4098).strip()


def main():
    os.umask(0o077)
    with open(sys.argv[1]) as file:
        config = json.load(file)
    token = token_file(os.path.join(os.environ["CREDENTIALS_DIRECTORY"], "matrix"))
    matrix = Matrix(config["homeserver"], token)
    identity = matrix.request("GET", "/account/whoami")
    if identity.get("user_id") != config["ownerUserId"] or identity.get("is_guest") is True or not identity.get("device_id"):
        raise ValueError("dedicated owner login required")
    store = Store(os.path.join(os.environ["STATE_DIRECTORY"], "requests.sqlite"))
    fingerprint = hashlib.sha256((json.dumps(config, sort_keys=True) + token).encode()).hexdigest()
    fresh = store.get("identity") != fingerprint or not store.get("cursor")
    if fresh:
        # A new login or authorization policy must not execute old authorized work.
        with store.db:
            store.db.execute("UPDATE requests SET phase='discarded', question='', answer='' WHERE phase IN ('queued','ready')")
    try:
        while True:
            try:
                batch = matrix.sync("" if fresh else store.get("cursor"),
                    [config["ownerUserId"], *config["remoteOwnerUserIds"]], store.pending())
                dropped = store.ingest(batch, config, int(time.time() * 1000), fresh)
                with store.db:
                    store.put("identity", fingerprint)
                if fresh:
                    print('{"event":"watermark_initialized"}', flush=True)
                fresh = False
                if dropped:
                    print(json.dumps({"event": "queue_saturated", "dropped": dropped}), flush=True)
            except Exception:
                print('{"event":"sync_unavailable"}', flush=True)
                time.sleep(5)
                continue
            store.step(matrix, lambda q: model_answer(config["modelSocket"], q), config, int(time.time() * 1000))
    finally:
        store.close()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        main()
    except Exception:
        print("pi-chat-transport: stopped (details redacted)", file=sys.stderr)
        sys.exit(1)
