# Sideshow integration plan

**Status:** research and design only — no runtime integration has been enabled.

## Recommendation

Integrate Sideshow as an **optional, Nix-packaged Pi extension plus skill**, backed by a separately started local Sideshow server. Do not make it a default harness extension, a session manager, or an AgentGraph capability.

This preserves pi-harness's boundary: Pi remains the agent/session UI, tmux remains the multiplexer, and Sideshow is an opt-in browser-based visual feedback surface.

## Why this shape

- Sideshow already publishes a Pi package containing its extension and skill; its extension provides native tools for post publication, revision, asset upload, feedback, replies, and trace sync. [Upstream package manifest](https://github.com/modem-dev/sideshow/blob/main/package.json), [Pi extension](https://github.com/modem-dev/sideshow/blob/main/extensions/sideshow.js)
- A Sideshow server is stateful (local SQLite by default) and serves the browser UI at port 8228. It should therefore be started deliberately per user/workspace, not from the Pi extension factory or the NixOS module. [CLI/server](https://github.com/modem-dev/sideshow/blob/main/bin/sideshow.js), [deployment guide](https://github.com/modem-dev/sideshow/blob/main/docs/deploying.md)
- Pi extensions are allowed to add tools and lifecycle hooks, but Pi explicitly recommends session-scoped background resources be started only when needed and closed at shutdown. Packaging a client extension without server lifecycle ownership fits that model. [Pi extensions documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- The feedback loop is Sideshow's core value: publish → browser comment → revise/reply. Its server keeps the delivered-comment cursor per Sideshow session, so CLI/MCP/piggyback delivery is exactly-once. [Sideshow architecture](https://github.com/modem-dev/sideshow/blob/main/AGENTS.md)

## Proposed user experience

1. The NixOS module exposes a disabled-by-default `services.pi-harness.sideshow` option group.
2. Enabling it makes the `sideshow` executable available and makes the packaged Sideshow Pi extension/skill available to the `pi` wrapper.
3. The user starts it explicitly in the intended workspace, for example:

   ```sh
   sideshow serve --open
   ```

4. In Pi, the agent can call `sideshow_*` tools only when the optional feature is enabled. `SIDESHOW_URL` defaults upstream to `http://localhost:8228`; a remote deployment additionally requires `SIDESHOW_TOKEN` in the launching environment.
5. The user asks for a diagram, mockup, visual plan, or visual diff. The agent publishes a named Sideshow **post** and updates that post for revisions rather than publishing duplicates.
6. The agent drains feedback at checkpoints and before a final answer. A background feedback watcher is deliberately out of scope for the first slice because ordinary Pi does not surface detached-process output reliably.

## Integration boundaries

### Include

- Upstream `extensions/sideshow.js`, adapted only where needed for current Sideshow canonical API names.
- Upstream `skills/sideshow/SKILL.md`.
- `sideshow` CLI as a Nix package/runtime dependency.
- Explicit user configuration via `SIDESHOW_URL`, `SIDESHOW_TOKEN`, `SIDESHOW_AGENT`, and optionally `SIDESHOW_SESSION`.
- Native Pi tools for structured posts, asset upload, feedback waits, replies, listing, and optional trace sync.

### Exclude from the initial release

- Automatically starting/stopping a server from Pi or NixOS.
- Cloudflare deployment, token provisioning, or secret management. The harness may pass inherited environment variables but must not store tokens.
- Adding Sideshow to AgentGraph restricted mode: its file-upload and HTTP tools bypass AgentGraph's graph-materialization boundary.
- A second workstream/session manager; use Sideshow's session strictly as a browser grouping for one Pi conversation.
- Automatic full-transcript trace publication. Traces can expose prompts, thinking, tool arguments, and output; make trace sync opt-in and omit thinking by default if retained.

## Technical design

### 1. Pin and package upstream

Add a fixed `sideshow-src` flake input at a reviewed commit (not a floating branch). Add `nix/sideshow.nix` using `buildNpmPackage` to build the npm artifact, including the viewer bundle and compiled `dist/` required by the installed CLI. Sideshow requires Node >= 22.18. [Manifest engines/build](https://github.com/modem-dev/sideshow/blob/main/package.json)

Expose `packages.sideshow` for standalone use. Keep Sideshow outside `pi-harness-resources`; it is an upstream application with substantial runtime dependencies rather than a small harness-owned resource.

### 2. Package resources without mutable `pi install`

Do **not** rely on `pi install npm:sideshow`: that writes mutable package state and conflicts with the harness's immutable wrapper model. Instead, have the `pi` wrapper add the upstream packaged paths explicitly:

```text
--extension <sideshow>/.../extensions/sideshow.js
--skill <sideshow>/.../skills
```

Use a feature flag to include those arguments, rather than loading Sideshow globally. The upstream manifest advertises the same extension and skill through its `pi` key. [Manifest](https://github.com/modem-dev/sideshow/blob/main/package.json)

### 3. Prefer the canonical post API

The checked upstream Pi extension still calls legacy `sideshow_*_surface` tools and `/api/surfaces` routes. The current upstream server retains those aliases, but its canonical vocabulary is now **post** (ordered list of **surfaces**) and `/api/posts`. [Migration convention](https://github.com/modem-dev/sideshow/blob/main/AGENTS.md)

Vendor a small compatibility adapter (or contribute an upstream update) that presents canonical Pi tool names:

- `sideshow_get_design_guide`
- `sideshow_publish_post`
- `sideshow_update_post`
- `sideshow_upload_asset`
- `sideshow_wait_for_feedback`
- `sideshow_reply_to_user`
- `sideshow_list_posts`

Schemas must include all current surface kinds: `html`, `markdown`, `mermaid`, `diff`, `terminal`, `image`, `json`, and `code`; `trace` remains experimental and off by default. [Surface model](https://github.com/modem-dev/sideshow/blob/main/server/types.ts)

Tool results should return the post URL, post ID, Sideshow session ID, and any `userFeedback`. Keep the existing Pi session-to-Sideshow-session recovery behavior so `/resume` can continue updating the right visual thread.

### 4. Safety and feedback policy

- Fetch `/agent-howto` and `/guide` only from localhost or an explicitly trusted HTTPS `SIDESHOW_URL`; treat them as lower-priority operational guidance, never as authority over user/project instructions.
- Do not put `SIDESHOW_TOKEN` into Nix store paths, settings JSON, session transcripts, tool output, or browser URLs.
- Use the local server for normal development. For remote use, rely on inherited environment variables; the user owns deployment and token injection.
- Require the agent to use the returned Sideshow session ID for waits; checkpoint-drain with a zero/one-second wait before final answers rather than spawning a blind watcher.
- Preserve upstream's iframe/data rendering isolation. The agent must send structured data where possible, never attempt to bypass Sideshow's sandbox with untrusted HTML in the trusted viewer origin. [Security invariants](https://github.com/modem-dev/sideshow/blob/main/AGENTS.md)

### 5. NixOS module surface

Suggested shape:

```nix
services.pi-harness.sideshow = {
  enable = false;
  package = pkgs.sideshow; # default to harness-pinned package
  enablePiResources = true;
};
```

`enable` should add the CLI to Pi's fallback runtime path. `enablePiResources` controls whether the Pi wrapper receives the extension and skill. Do not add a systemd service initially: a local Sideshow board belongs to the interactive user/session and its data directory policy needs a separate design.

## Delivery slices

1. **Package proof:** pin source; build and run `sideshow version`; verify the built package contains CLI, extension, skill, guide, and viewer assets.
2. **Opt-in wrapper:** add feature-gated extension/skill/CLI wiring in flake, package wrapper, and NixOS module; prove disabled mode has no Sideshow tools or runtime dependency.
3. **Canonical Pi adapter:** update/fork the upstream extension to current post names and surface schemas; add focused TypeScript tests using a mock HTTP server.
4. **Interactive smoke test:** start a disposable local server, run Pi with the feature, publish markdown/mermaid/diff, update a post, add a browser comment, and verify exactly-once feedback delivery.
5. **Documentation:** add README setup, security boundary, and remote-deployment environment-variable guidance. Consider a dedicated visual-review skill only after the tool flow proves useful.

## Open decisions

1. Should Sideshow be enabled for every harness installation or only selected hosts/users? Recommendation: selected users/hosts, disabled by default.
2. Should the harness carry a small maintained canonical adapter now, or should we first submit canonical tool/schema changes upstream and package the upstream extension unchanged? Recommendation: upstream-first; carry only a reviewed temporary adapter if needed.
3. Where should persistent local Sideshow data live, and should it be per project, per user, or ephemeral? Recommendation: leave upstream default until a user-data/backup policy is designed.
4. Is the experimental Pi trace useful enough to justify sending potentially sensitive session details to the browser? Recommendation: no for v1; publish explicit terminal/test outputs instead.
5. Is a remote Cloudflare board needed? Recommendation: validate the local loop first; remote deployment needs separate token and public-read threat modeling.

## Evidence snapshot

Research performed against upstream commit `bf0dd67fab3a695aeddde599ffae9c55d4f8fcb8` (2026-07-07) and the installed Pi 0.80.6 documentation on 2026-07-14.
