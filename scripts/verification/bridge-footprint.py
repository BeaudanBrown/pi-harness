#!/usr/bin/env python3
"""Read-only fixed-scope inventory for #170/#171; never reads live state/secrets.

Count physical lines, including blanks/comments, in tracked worktree files or
explicit committed trees. Tests/fixtures and missing (deleted) files are excluded. Shared scopes are
reported separately, not silently attributed to the bridge. Stage new source
files before measuring so the inventory agrees with Git-aware Nix packaging.
"""
import argparse
import json
import subprocess
from fnmatch import fnmatch
from pathlib import Path

SCOPES = {
    "legacy_runtime": ["config/agent/extensions/managed-sessions"],
    "native_runtime_including_migration": ["config/agent/extensions/matrix-bridge"],
    "shared_matrix": ["config/agent/extensions/matrix-shared"],
    "stateless_chat_including_old_account": ["config/agent/extensions/bridge-chat"],
    "packaging_and_retention": [
        "nix/module.nix", "nix/package.nix", "nix/*bridge*.nix", "nix/*managed*",
        "nix/pi-harness-resources.nix", "nix/pi-session-lock.nix",
        "scripts/pin-runtime.py", "scripts/managed*", "scripts/relay-rollout.sh",
        "config/agent/managed-host-policy.json",
    ],
    "downstream_go_all_production": ["modules/cli/tmux/tmux-project-go/*.go"],
    "downstream_toplevel_tmux_and_pi_config": [
        "modules/cli/tmux/*.nix", "modules/cli/tmux/shared-*.sh", "modules/cli/pi-harness/*.nix",
    ],
}


def measure(root, patterns, revision=None):
    def git(*args):
        return subprocess.check_output(["git", "-C", str(root), *args])

    tree = git("rev-parse", "--verify", "--end-of-options", revision + "^{tree}").decode().strip() if revision else None
    if tree:
        # ls-tree does not implement ls-files globs. Enumerate only these source
        # prefixes, then apply the same patterns. No repository-wide/private scan.
        prefixes = sorted({p.split("*", 1)[0].rsplit("/", 1)[0] if "*" in p else p for p in patterns})
        entries = git("ls-tree", "-rz", tree, "--", *prefixes).decode().split("\0")
        files = {}
        for entry in filter(None, entries):
            metadata, name = entry.split("\t", 1)
            if any(name == p or name.startswith(p + "/") or fnmatch(name, p) for p in patterns):
                mode, kind, oid = metadata.split()
                if kind != "blob" or mode == "120000":
                    raise ValueError(f"Production inventory requires a regular source blob: {name}")
                files[name] = oid
    else:
        files = dict.fromkeys(filter(None, git("ls-files", "-z", "--", *patterns).decode().split("\0")))
    rows = []
    for name, oid in sorted(files.items()):
        if "fixtures" in Path(name).parts or "tests" in Path(name).parts or name.endswith("_test.go"):
            continue
        if tree:
            data = git("cat-file", "blob", oid)
        else:
            path = root / name
            if path.is_symlink():
                raise ValueError(f"Production inventory must not follow a symlink: {name}")
            if not path.is_file():
                continue
            data = path.read_bytes()
        rows.append({"path": name, "lines": len(data.splitlines())})
    return {"files": len(rows), "lines": sum(row["lines"] for row in rows), "paths": rows}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dotfiles", type=Path, required=True)
    parser.add_argument("--harness-ref", help="Optional committed harness baseline")
    parser.add_argument("--dotfiles-ref", help="Optional committed consuming baseline")
    args = parser.parse_args()
    harness = Path(__file__).resolve().parents[2]
    print(json.dumps({"scopes": SCOPES, "groups": {
        key: measure(args.dotfiles if key.startswith("downstream_") else harness, patterns,
                     args.dotfiles_ref if key.startswith("downstream_") else args.harness_ref)
        for key, patterns in SCOPES.items()
    }}, indent=2))
