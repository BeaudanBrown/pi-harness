# Supplemental, disposable NixOS integration test. No production credentials/API/model.
{
  nixpkgs,
  piPackage,
  system ? "x86_64-linux",
}:
let
  pkgs = import nixpkgs { inherit system; };
  tls = pkgs.runCommand "synthetic-chat-state-tls" { nativeBuildInputs = [ pkgs.openssl ]; } ''
    mkdir "$out"
    openssl req -x509 -newkey rsa:2048 -nodes -days 36500 \
      -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 \
      -keyout "$out/key.pem" -out "$out/cert.pem"
  '';
  # Deliberately public synthetic fixture token and key, never real account material.
  token = pkgs.writeText "synthetic-chat-state-token" "fixture-owner-token\n";
  server = pkgs.writeText "synthetic-chat-state-matrix.py" ''
    import json, os, socket, ssl, time
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import urlsplit, parse_qs
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.headers.get('Authorization') != 'Bearer fixture-owner-token':
                self.send_error(401)
                return
            url = urlsplit(self.path)
            if url.path.endswith('/account/whoami'):
                value = {'user_id': '@owner:fixture.test', 'device_id': 'fixture-device'}
            elif url.path.endswith('/sync'):
                query = parse_qs(url.query)
                kind = json.loads(query['filter'][0])['room']['timeline']['types'][0]
                with open('/run/fake-matrix/requests', 'a') as output:
                    output.write(json.dumps({'kind': kind, 'since': query.get('since', [""])[0]}) + '\n')
                time.sleep(0.05)
                value = {'next_batch': 'fixture-next', 'rooms': {}}
            else:
                self.send_error(404)
                return
            body = json.dumps(value).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            try: self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError): pass
        def do_POST(self):
            raise RuntimeError('No join or other Matrix mutation is part of this fixture')
        def log_message(self, *_): pass
    server = ThreadingHTTPServer(('127.0.0.1', 8443), Handler)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain('${tls}/cert.pem', '${tls}/key.pem')
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    notify = os.environ['NOTIFY_SOCKET']
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as status:
        status.connect(('\0' + notify[1:]) if notify.startswith('@') else notify)
        status.sendall(b'READY=1')
    server.serve_forever()
  '';
in
pkgs.testers.runNixOSTest {
  name = "bridge-chat-systemd-state-directory";
  nodes.machine = { lib, ... }: {
    imports = [ ../nix/bridge-chat.nix ];
    options.services.pi-harness.package = lib.mkOption { type = lib.types.raw; };
    config = {
      services.pi-harness.package = { pi = piPackage; };
      users.users.fixture = { isNormalUser = true; uid = 1000; };
      services.pi-harness.bridgeChat.assistant = {
        enable = true;
        homeserver = "https://localhost:8443";
        ownerUserId = "@owner:fixture.test";
        matrixTokenFile = "/run/fake-matrix/owner-token";
        modelUser = "fixture";
        piAgentDirectory = "/home/fixture/.pi/agent";
        roomIds = [ "!chat:fixture.test" ];
        trustedBridgeBots.fixture = "@bot:fixture.test";
      };
      systemd.services.pi-chat-transport = {
        after = [ "fake-matrix.service" ];
        requires = [ "fake-matrix.service" ];
        environment.NODE_EXTRA_CA_CERTS = "${tls}/cert.pem";
      };
      # Empty intake needs no SDK worker, real login or model endpoint.
      systemd.services.pi-chat-model.unitConfig.ConditionPathExists = "!/";
      systemd.services.fake-matrix = {
        wantedBy = [ "multi-user.target" ];
        serviceConfig = {
          Type = "notify";
          ExecStartPre = "${pkgs.coreutils}/bin/install -m 0600 ${token} /run/fake-matrix/owner-token";
          ExecStart = "${pkgs.python3}/bin/python3 ${server}";
          RuntimeDirectory = "fake-matrix";
        };
      };
      virtualisation.memorySize = 1024;
    };
  };
  testScript = ''
    import json
    start_all()
    machine.wait_for_unit('pi-chat-transport.service')
    machine.succeed('test -L /var/lib/pi-chat-transport')
    assert machine.succeed('readlink /var/lib/pi-chat-transport').strip() == 'private/pi-chat-transport'
    assert machine.succeed('systemctl show pi-chat-transport.service -p DynamicUser --value').strip() == 'yes'

    def healthy():
        pid = machine.succeed('systemctl show pi-chat-transport.service -p MainPID --value').strip()
        machine.wait_until_succeeds(f"journalctl --no-pager -o cat _PID={pid} | grep -F '\"event\":\"bridge_invitations\",\"unavailable\":false'", timeout=30)
        machine.fail(f"journalctl --no-pager -o cat _PID={pid} | grep -F 'bridge_invitations_unavailable'")

    healthy()
    before = machine.succeed('stat -c %i /var/lib/private/pi-chat-transport/requests.sqlite /var/lib/private/pi-chat-transport/bridge-invites.sqlite')
    machine.succeed('systemctl restart pi-chat-transport.service')
    healthy()
    assert machine.succeed('stat -c %i /var/lib/private/pi-chat-transport/requests.sqlite /var/lib/private/pi-chat-transport/bridge-invites.sqlite') == before
    requests = [json.loads(line) for line in machine.succeed('cat /run/fake-matrix/requests').splitlines()]
    for kind in ['m.room.message', 'm.room.member']:
        assert any(row['kind'] == kind and row['since'] == 'fixture-next' for row in requests)

    # Strict journal-file refusal survives trusted state-root normalization.
    machine.succeed('systemctl stop pi-chat-transport.service')
    machine.succeed('mv /var/lib/private/pi-chat-transport/bridge-invites.sqlite /var/lib/private/pi-chat-transport/saved-invites.sqlite')
    machine.succeed('ln -s requests.sqlite /var/lib/private/pi-chat-transport/bridge-invites.sqlite')
    machine.succeed('systemctl start pi-chat-transport.service')
    pid = machine.succeed('systemctl show pi-chat-transport.service -p MainPID --value').strip()
    machine.wait_until_succeeds(f"journalctl --no-pager -o cat _PID={pid} | grep -F 'bridge_invitations_unavailable'", timeout=30)
    machine.succeed('test -L /var/lib/private/pi-chat-transport/bridge-invites.sqlite')
  '';
}
