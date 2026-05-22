import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NIX_RUNTIME_GUIDANCE = `

Nix runtime guidance:
- This machine uses Nix/NixOS. When a required command is missing, do not ask the user to install it globally.
- Prefer project-provided Nix entrypoints first, such as \`nix develop -c <command>\`, \`nix run .#<app> -- <args>\`, or the repository's documented verification command.
- For one-off external tools, use ephemeral Nix commands such as \`nix shell nixpkgs#<package> -c <command> <args>\` or \`nix run nixpkgs#<package> -- <args>\`.
- Prefer focused checks before expensive builds, but use the repository's canonical verification gate when appropriate.
- Do not run destructive commands, long-lived daemons, or unusually large downloads/builds unless they are necessary for the task or approved by the user.`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: event.systemPrompt + NIX_RUNTIME_GUIDANCE,
	}));
}
