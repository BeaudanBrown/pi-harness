---
name: playwright-browser
description: Explore and diagnose web pages with the Playwright Agent CLI, inspect accessibility/DOM/network/console state, capture screenshots or traces, generate locator/action skeletons, and turn discoveries into durable Playwright tests. Use for browser interaction, UI debugging, selector discovery, visual checks, or Playwright test generation.
---

# Playwright Browser

Use the stateful Playwright Agent CLI rather than MCP or one-shot screenshot scripts when an agent needs to interact with a browser.

## Start Here

Run this before browser work:

```bash
pi-playwright doctor
```

`pi-playwright` selects a trusted project adapter from `.pi/playwright-cli.json` or a project-local `node_modules/.bin/playwright-cli` before using the Nix-pinned harness fallback.

- Use the project adapter for application development, authenticated fixtures, test generation, and committed E2E tests.
- Use the harness fallback for disposable exploration when a project has no Playwright setup, including arbitrary public or local pages.
- Inspect `pi-playwright --help` because CLI capabilities evolve.

## Exploration Loop

Use a named session when the work spans multiple commands:

```bash
pi-playwright -s=my-task open http://127.0.0.1:8000
pi-playwright -s=my-task snapshot
pi-playwright -s=my-task console
pi-playwright -s=my-task screenshot
```

Prefer accessibility snapshots and semantic targets over coordinate clicks. Use role, label, text, or a stable app-owned test attribute when converting exploration into tests. Inspect `--help` for network commands: newer CLIs use `requests`/`request`, while older project adapters may expose `network`.

Every interaction emits equivalent Playwright TypeScript. Treat this as raw material, not a complete regression test: remove exploratory steps, use project fixtures, and add explicit assertions.

Use `show` when the user wants to observe or take over the live browser. Close disposable sessions when done:

```bash
pi-playwright -s=my-task close
pi-playwright -s=my-task delete-data
```

## Existing Playwright Tests

Use the project's documented test wrapper for durable tests. When the installed versions support CLI debugging, launch the project's seed or focused test with `--debug=cli`, attach using the session name printed by Playwright, inspect the paused page, then rerun the resulting test normally.

Do not replace deterministic E2E tests with manual browsing. Browser exploration complements tests by discovering real DOM, accessibility, console, network, and interaction behavior.

## Safety

- Default to local, disposable, seeded environments for application workflows.
- Never enter credentials into an untrusted page or expose production/customer data in snapshots, screenshots, traces, video, console, or network artifacts.
- Ask before state-changing actions against a non-local page.
- Do not enable unrestricted filesystem access.
- Do not commit browser profiles, storage state, secrets, or exploratory artifacts unless the repository explicitly requires a sanitized fixture/artifact.
- Playwright origin filters are convenience guardrails, not a complete security boundary.
- Do not start browsers in AgentGraph restricted mode or use browser tooling to bypass its tool restrictions.
