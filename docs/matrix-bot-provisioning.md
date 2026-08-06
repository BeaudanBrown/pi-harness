# Matrix host-bot provisioning

Pi remote sessions use one non-admin Matrix account per host. Access tokens are
runtime credentials: they must not be committed, copied into the Nix store,
placed in Pi settings/session files, pasted into issues, or sent to an agent.

The first identity is `@pi-grill:matrix.bepis.lol`. Its stable Matrix device ID
is `PI_GRILL_RELAY`.

## 1. Create the non-admin account

Run this interactively on `nas`, where the Synapse shared-registration secret is
available to root. Do not put the password or registration secret in command
arguments:

```sh
sudo matrix-synapse-register_new_matrix_user
```

The NixOS Synapse module generates this wrapper because the configured client
listener has a TCP bind address. The wrapper already appends the generated
homeserver config, SOPS extra config, and local listener URL; do not pass another
`-c` or homeserver URL.

Enter `pi-grill`, a generated one-time password, and answer **no** when asked
whether the account is an administrator. Public Matrix registration can remain
disabled; the wrapper authenticates with Synapse's existing
`registration_shared_secret`.

## 2. Log in the relay device

Still in a trusted shell, read the password without echoing it and call the
Matrix password-login endpoint. Nothing below places the password in shell
history:

```sh
read -rsp 'pi-grill Matrix password: ' MATRIX_PASSWORD; printf '\n'
login_response="$({
  MATRIX_PASSWORD="$MATRIX_PASSWORD" jq -n \
    '{
      type: "m.login.password",
      identifier: {type: "m.id.user", user: "pi-grill"},
      password: env.MATRIX_PASSWORD,
      device_id: "PI_GRILL_RELAY",
      initial_device_display_name: "Pi relay on grill"
    }'
} | curl --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  https://matrix.bepis.lol/_matrix/client/v3/login)"
unset MATRIX_PASSWORD
```

Do not print `login_response`. Extract the token directly into the SOPS update
step below, then unset it:

```sh
MATRIX_ACCESS_TOKEN="$(jq -er '.access_token' <<<"$login_response")"
unset login_response
```

## 3. Store the runtime environment through SOPS

The grill NixOS module declares the `pi/matrix-grill-env` SOPS secret, mapped by
the dotfiles convention to `secrets/grill.yaml`. In the private SOPS checkout on
`nas`, write a YAML string whose decrypted content is exactly:

```text
PI_MATRIX_ACCESS_TOKEN=<token>
```

From `/home/beau/sops-secrets` on `nas`, use `sops set --value-stdin` so the
token is not exposed in process arguments:

```sh
cd /home/beau/sops-secrets
printf '%s' "$MATRIX_ACCESS_TOKEN" |
  jq -Rs '"PI_MATRIX_ACCESS_TOKEN=" + . + "\n"' |
  sops set --value-stdin secrets/grill.yaml '["pi/matrix-grill-env"]'
unset MATRIX_ACCESS_TOKEN
```

Do not send the token or decrypted environment line to an agent. Commit and
push the encrypted SOPS change using the repository's normal human-operated
secret workflow.

## 4. Activate and verify on grill

After the pi-harness and dotfiles changes are available to grill, activate the
new configuration through the normal NixOS deployment workflow. The rendered
environment file is owned by the primary user with mode `0400`.

Verify the identity without displaying the token:

```sh
pi-matrix-whoami
```

The only successful output is:

```text
@pi-grill:matrix.bepis.lol
```

A different identity, rejected token, missing secret, or unreachable homeserver
returns non-zero. The command never includes the token in process arguments or
prints Matrix response bodies.

## Rotation or revocation

Until the full remote-session runbook lands, rotate by logging in a replacement
`PI_GRILL_RELAY` device, replacing the SOPS value, activating grill, running
`pi-matrix-whoami`, and then deleting the old device/session from Matrix. Never
reuse the human Element access token for a Pi host bot.
