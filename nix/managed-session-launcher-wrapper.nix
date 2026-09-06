{
  pkgs,
  launcherPackage,
  launcherExecutable ? "bin/tmux_project",
}:
pkgs.writeShellApplication {
  name = "tmux_project";
  runtimeInputs = [ pkgs.coreutils pkgs.gawk pkgs.git pkgs.jq ];
  text = ''
    set -euo pipefail
    [[ "''${1-}" == managed ]]
    operation="''${2-}"
    request=$(cat)
    ${builtins.readFile ./managed-worktree-lifecycle.sh}
    result=$(printf '%s\n' "$request" | ${launcherPackage}/${launcherExecutable} "$@")
    if [[ "$operation" != workspace-resolve && "$operation" != project-create ]]; then
      printf '%s\n' "$result"
      exit 0
    fi

    root_key=$(jq -er '.rootKey | select(type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"))' <<<"$request")
    workspace=$(jq -er '.workspace | select(type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"))' <<<"$request")
    configured_root_raw=$(jq -er --arg key "$root_key" '.[$key] | select(type == "string" and length > 0)' <<<"''${PI_MANAGED_SESSIONS_WORKSPACE_ROOTS:?}")
    [[ ! -L "$configured_root_raw" ]]
    configured_root=$(realpath -e "$configured_root_raw")
    workspace_path=$(jq -er '.workspacePath | select(type == "string" and length > 0)' <<<"$result")
    workspace_path=$(realpath -e "$workspace_path")
    [[ -d "$configured_root" && -d "$workspace_path" && ! -L "$workspace_path" && $(dirname "$workspace_path") == "$configured_root" && $(basename "$workspace_path") == "$workspace" && $(stat -c %u "$workspace_path") == $(id -u) ]]

    derive_project_key() {
      local domain="$1" first="$2" second="$3"
      { printf 'pi-managed-sessions:%s:v1\0' "$domain"
        for part in "$first" "$second"; do printf '%s:' "$(printf '%s' "$part" | wc -c)"; printf '%s' "$part"; done
      } | sha256sum | cut -c1-32
    }

    checkout_display="$workspace"
    marker="$workspace_path/.git"
    if [[ -e "$marker" || -L "$marker" ]]; then
      [[ ! -L "$marker" && ( -d "$marker" || -f "$marker" ) && $(stat -c %u "$marker") == $(id -u) ]]
      [[ $(git -C "$workspace_path" rev-parse --is-inside-work-tree 2>/dev/null) == true ]]
      [[ $(realpath -e "$(git -C "$workspace_path" rev-parse --show-toplevel 2>/dev/null)") == "$workspace_path" ]]
      common_raw=$(git -C "$workspace_path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
      [[ -n "$common_raw" && ''${#common_raw} -le 4096 && "$common_raw" != *$'\n'* ]]
      common=$(realpath -e "$common_raw")
      [[ -d "$common" && ! -L "$common" && $(stat -c %u "$common") == $(id -u) ]]
      worktrees=$(git --git-dir="$common" worktree list --porcelain 2>/dev/null)
      [[ -n "$worktrees" && ''${#worktrees} -le 65536 ]]
      main_raw=$(awk '/^worktree / { print substr($0, 10); exit }' <<<"$worktrees")
      [[ -n "$main_raw" && "$main_raw" != *$'\n'* ]]
      main=$(realpath -e "$main_raw")
      [[ -d "$main" && ! -L "$main" && $(stat -c %u "$main") == $(id -u) && $(dirname "$main") == "$configured_root" ]]
      [[ $(realpath -e "$main/.git") == "$common" && -d "$main/.git" && ! -L "$main/.git" && $(stat -c %u "$main/.git") == $(id -u) ]]
      project_key="project_$(derive_project_key project-git "$root_key" "$common")"
      project_display=$(basename "$main")
    else
      if git -C "$workspace_path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then exit 1; fi
      project_key="project_$(derive_project_key project-workspace "$root_key" "$workspace")"
      project_display="$workspace"
    fi
    [[ "$project_key" =~ ^project_[a-f0-9]{32}$ ]]
    jq -en --arg project "$project_display" --arg checkout "$checkout_display" '
      [$project,$checkout] | all(type == "string" and length >= 1 and length <= 128 and (test("[\u0000-\u001f\u007f/]") | not))' >/dev/null
    jq -ce --arg projectKey "$project_key" --arg projectDisplayName "$project_display" --arg checkoutDisplayName "$checkout_display" \
      --arg rootKey "$root_key" --arg workspace "$workspace" --arg workspacePath "$workspace_path" '
      if type == "object" and .rootKey == $rootKey and .workspace == $workspace and .workspacePath == $workspacePath
      then . + {projectKey:$projectKey,projectDisplayName:$projectDisplayName,checkoutDisplayName:$checkoutDisplayName}
      else error("launcher identity mismatch") end' <<<"$result"
  '';
}
