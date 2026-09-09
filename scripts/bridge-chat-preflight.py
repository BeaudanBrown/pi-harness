"""Read-only bridge preflight. Never prints credentials, identities or API bodies.

Runs outside Pi under systemd with credential copies of bridge runtime YAML.
Only the fixed whoami GET on configured literal-loopback endpoints is allowed.
A successful probe is not evidence of chat intake or outbound relay behavior.
"""

import json
import os
from pathlib import Path
import re
import signal
import sys
import urllib.error
import urllib.parse
import urllib.request

import yaml

MAX_CONFIG = 1024 * 1024
MAX_RESPONSE = 256 * 1024
PROBE_TIMEOUT_SECONDS = 4


class ProbeTimeout(BaseException):
    # Escape urllib's OSError wrapping and parser error recovery to stop the
    # entire probe, not merely one socket operation.
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_bounded(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        import stat
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("not a regular file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(maximum + 1)
        if len(data) > maximum:
            raise ValueError("too large")
        return data
    finally:
        os.close(fd)


def endpoint_url(endpoint, owner):
    parsed = urllib.parse.urlsplit(endpoint)
    if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "::1")
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
            or parsed.port is None or not 1 <= parsed.port <= 65535):
        raise ValueError("invalid endpoint")
    return endpoint.rstrip("/") + "/_matrix/provision/v3/whoami?" + urllib.parse.urlencode({"user_id": owner})


def get_whoami(endpoint, owner, secret):
    request = urllib.request.Request(endpoint_url(endpoint, owner), headers={
        "Authorization": "Bearer " + secret,
        "Accept": "application/json",
    }, method="GET")
    # Do not inherit HTTP_PROXY, credentials in proxy URLs, cookies, or redirects.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=8) as response:
        if response.status != 200:
            raise ValueError("unexpected status")
        body = response.read(MAX_RESPONSE + 1)
        if len(body) > MAX_RESPONSE:
            raise ValueError("oversized response")
        return json.loads(body)


def probe(credential_path, endpoint, owner, fetch=get_whoami):
    result = {"status": "config_unavailable", "liveMessagePath": "unverified"}
    try:
        config = yaml.safe_load(read_bounded(credential_path, MAX_CONFIG))
        if not isinstance(config, dict):
            raise ValueError("invalid config")
        bridge = config.get("bridge", {})
        provisioning = config.get("provisioning", {})
        if not isinstance(bridge, dict) or not isinstance(provisioning, dict):
            raise ValueError("invalid config")
        relay = bridge.get("relay", {})
        permissions = bridge.get("permissions", {})
        if not isinstance(relay, dict) or not isinstance(permissions, dict):
            raise ValueError("invalid config")
        result["relayEnabled"] = relay.get("enabled") if type(relay.get("enabled")) is bool else None
        permission = permissions.get(owner)
        result["explicitOwnerPermission"] = permission if permission in ("admin", "user", "relay") else "unspecified"
        secret = provisioning.get("shared_secret")
        if not isinstance(secret, str) or not secret or secret == "disable":
            result["status"] = "provisioning_disabled"
            return result
        if secret.startswith("$"):
            result["status"] = "credential_unresolved"
            return result
        if len(secret) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in secret):
            result["status"] = "credential_invalid"
            return result
        endpoint_url(endpoint, owner)
        result["status"] = "request_failed"
        response = fetch(endpoint, owner, secret)
        if not isinstance(response, dict) or not isinstance(response.get("logins"), list):
            raise ValueError("invalid response")
        logins = response["logins"]
        if len(logins) > 128 or any(not isinstance(login, dict) for login in logins):
            raise ValueError("invalid logins")
        connected = 0
        for login in logins:
            state = login.get("state", {})
            if not isinstance(state, dict):
                raise ValueError("invalid state")
            connected += state.get("state_event", login.get("state_event")) == "CONNECTED"
        result.update(status="inspected", loginCount=len(logins), connectedLoginCount=connected)
    except urllib.error.HTTPError as error:
        # Never stringify exceptions: URLs, response text and headers are sensitive.
        result["status"] = "unauthorized" if error.code in (401, 403) else "http_error"
        error.close()
    except ProbeTimeout:
        raise
    except Exception:
        pass
    return result


def timed_probe(credential_path, endpoint, owner):
    # The standalone Linux service runs on the main thread. An absolute alarm
    # also bounds slow-drip responses and YAML parsing, not just socket inactivity.
    # Eight probes use at most 32 seconds, reserving 13 seconds for report/startup.
    def expired(_signum, _frame):
        raise ProbeTimeout()
    previous = signal.signal(signal.SIGALRM, expired)
    try:
        signal.setitimer(signal.ITIMER_REAL, PROBE_TIMEOUT_SECONDS)
        return probe(credential_path, endpoint, owner)
    except ProbeTimeout:
        return {"status": "probe_timed_out", "liveMessagePath": "unverified"}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def main():
    try:
        settings = json.loads(read_bounded(sys.argv[1], 16384))
        owner = settings["ownerUserId"]
        bridges = settings["bridges"]
        if (not isinstance(owner, str) or not re.fullmatch(r"@[^\s:]{1,128}:[^\s]{1,128}", owner)
                or not isinstance(bridges, dict) or not 1 <= len(bridges) <= 8):
            raise ValueError("invalid settings")
        credentials = Path(os.environ["CREDENTIALS_DIRECTORY"])
        for name, endpoint in bridges.items():
            if not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", name):
                raise ValueError("invalid credential name")
            endpoint_url(endpoint, owner)
        # Do not print caller-chosen labels, which might contain personal names.
        report = {"bridge-" + str(index): timed_probe(credentials / name, bridges[name], owner)
                  for index, name in enumerate(sorted(bridges), start=1)}
        print(json.dumps({"schemaVersion": 1, "scope": "read-only-bridge-preflight", "bridges": report}, sort_keys=True))
        return 0
    except Exception:
        print('{"schemaVersion":1,"status":"invalid_preflight_settings"}')
        return 1


if __name__ == "__main__":
    sys.exit(main())
