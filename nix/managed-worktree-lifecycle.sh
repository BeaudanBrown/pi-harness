# This fragment is embedded by managed-session-launcher-wrapper.nix after request/op are set.
# shellcheck disable=SC2154
if [[ "$operation" == worktree-* ]]; then
  export LC_ALL=C
  fail() { printf '%s\n' "managed worktree validation failed" >&2; exit 1; }
  field() { jq -er "$1" <<<"$request"; }
  valid_name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; }
  root_key=$(field '.rootKey | select(type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"))')
  configured_root_raw=$(jq -er --arg key "$root_key" '.[$key] | select(type == "string" and length > 0)' <<<"${PI_MANAGED_SESSIONS_WORKSPACE_ROOTS:?}")
  [[ ! -L "$configured_root_raw" ]] || fail
  configured_root=$(realpath -e "$configured_root_raw")
  [[ -d "$configured_root" && $(stat -c %u "$configured_root") == $(id -u) ]] || fail

  resolve_project() {
    local requested="$1"
    valid_name "$requested" || fail
    workspace_path=$(realpath -e "$configured_root/$requested")
    [[ -d "$workspace_path" && ! -L "$workspace_path" && $(dirname "$workspace_path") == "$configured_root" && $(basename "$workspace_path") == "$requested" && $(stat -c %u "$workspace_path") == $(id -u) ]] || fail
    marker="$workspace_path/.git"
    [[ -e "$marker" && ! -L "$marker" && ( -d "$marker" || -f "$marker" ) && $(stat -c %u "$marker") == $(id -u) ]] || fail
    [[ $(git -C "$workspace_path" rev-parse --is-inside-work-tree 2>/dev/null) == true ]] || fail
    [[ $(realpath -e "$(git -C "$workspace_path" rev-parse --show-toplevel 2>/dev/null)") == "$workspace_path" ]] || fail
    common=$(realpath -e "$(git -C "$workspace_path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")
    [[ -d "$common" && ! -L "$common" && $(stat -c %u "$common") == $(id -u) ]] || fail
    worktrees=$(git --git-dir="$common" worktree list --porcelain 2>/dev/null)
    [[ -n "$worktrees" && ${#worktrees} -le 65536 ]] || fail
    main_raw=$(awk '/^worktree / { print substr($0, 10); exit }' <<<"$worktrees")
    main_path=$(realpath -e "$main_raw")
    [[ -d "$main_path" && ! -L "$main_path" && $(dirname "$main_path") == "$configured_root" && $(stat -c %u "$main_path") == $(id -u) ]] || fail
    [[ $(realpath -e "$main_path/.git") == "$common" && -d "$main_path/.git" && ! -L "$main_path/.git" ]] || fail
    project_workspace=$(basename "$main_path")
  }

  resolve_ref() {
    local input="$1" matches=() candidate
    [[ ${#input} -le 255 && "$input" =~ ^[A-Za-z0-9][A-Za-z0-9._/@+/-]*$ && "$input" != *..* && "$input" != */.lock && "$input" != *'@{'* ]] || fail
    if [[ "$input" == refs/* ]]; then
      [[ "$input" == refs/heads/* || "$input" == refs/remotes/* || "$input" == refs/tags/* ]] || fail
      git --git-dir="$common" show-ref --verify --quiet "$input" || fail
      matches+=("$input")
    else
      for candidate in "refs/heads/$input" "refs/remotes/$input" "refs/tags/$input"; do
        git --git-dir="$common" show-ref --verify --quiet "$candidate" && matches+=("$candidate") || true
      done
    fi
    [[ ${#matches[@]} -eq 1 ]] || fail
    resolved_ref=${matches[0]}
    resolved_commit=$(git --git-dir="$common" rev-parse --verify --end-of-options "$resolved_ref^{commit}" 2>/dev/null)
    [[ "$resolved_commit" =~ ^[a-f0-9]{40,64}$ ]] || fail
  }

  registered_block() {
    local target="$1"
    awk -v target="$target" 'BEGIN { RS=""; FS="\n" } $1 == "worktree " target { print; found=1 } END { if (!found) exit 1 }' <<<"$worktrees"
  }

  worktree_is_clean() {
    local target="$1" git_status grep_status
    set +e
    set +o pipefail
    git -C "$target" status --porcelain=v1 --untracked-files=all --ignored=matching | grep -qm1 .
    statuses=("${PIPESTATUS[@]}"); git_status=${statuses[0]}; grep_status=${statuses[1]}
    set -o pipefail
    set -e
    if [[ $grep_status -eq 0 && ( $git_status -eq 0 || $git_status -eq 141 ) ]]; then return 1; fi
    if [[ $git_status -eq 0 && $grep_status -eq 1 ]]; then return 0; fi
    fail
  }

  case "$operation" in
    worktree-list)
      workspace=$(field '.workspace')
      resolve_project "$workspace"
      entries='[]'
      while IFS= read -r -d '' block; do
        listed_path=$(awk '/^worktree / { print substr($0,10); exit }' <<<"$block")
        [[ "$listed_path" == "$configured_root/"* ]] || continue
        [[ -d "$listed_path" && ! -L "$listed_path" && $(stat -c %u "$listed_path") == $(id -u) ]] || fail
        listed_canonical=$(realpath -e "$listed_path")
        [[ "$listed_canonical" == "$listed_path" && $(dirname "$listed_canonical") == "$configured_root" ]] || fail
        listed_workspace=$(basename "$listed_canonical"); valid_name "$listed_workspace" || fail
        listed_head=$(awk '/^HEAD / { print substr($0,6); exit }' <<<"$block"); [[ "$listed_head" =~ ^[a-f0-9]{40,64}$ ]] || fail
        listed_branch=$(awk '/^branch refs\/heads\// { print substr($0,19); exit }' <<<"$block" || true)
        listed_locked=false; grep -Eq '^locked( |$)' <<<"$block" && listed_locked=true
        listed_clean=false
        if worktree_is_clean "$listed_canonical"; then listed_clean=true; fi
        item=$(jq -nce --arg workspace "$listed_workspace" --arg head "$listed_head" --arg branch "$listed_branch" --argjson isMain "$([[ "$listed_path" == "$main_path" ]] && echo true || echo false)" \
          --argjson locked "$listed_locked" --argjson clean "$listed_clean" '{workspace:$workspace,head:$head,isMain:$isMain,locked:$locked,clean:$clean} + (if $branch == "" then {} else {branch:$branch} end)')
        entries=$(jq -c --argjson item "$item" '. + [$item]' <<<"$entries")
      done < <(printf '%s\n' "$worktrees" | awk 'BEGIN { RS=""; ORS="\0" } { print }')
      jq -nce --arg rootKey "$root_key" --arg projectWorkspace "$project_workspace" --arg commonDir "$common" --argjson worktrees "$entries" \
        '{rootKey:$rootKey,projectWorkspace:$projectWorkspace,commonDir:$commonDir,worktrees:$worktrees}'
      ;;
    worktree-create-preview)
      workspace=$(field '.workspace'); base_ref=$(field '.baseRef'); branch=$(field '.branch')
      resolve_project "$workspace"
      git check-ref-format --branch "$branch" >/dev/null 2>&1 || fail
      [[ "$branch" != -* && ${#branch} -le 255 ]] || fail
      git --git-dir="$common" show-ref --verify --quiet "refs/heads/$branch" && fail
      resolve_ref "$base_ref"; base_ref_full="$resolved_ref"; base_commit="$resolved_commit"
      slug=$(printf '%s' "$branch" | tr '/A-Z' '-a-z' | sed -E 's/[^a-z0-9._-]+/-/g; s/-+/-/g; s/^[._-]+//; s/[._-]+$//' | cut -c1-64)
      [[ -n "$slug" ]] || fail
      digest=$(printf 'pi-managed-worktree-path:v1\0%s\0%s' "$project_workspace" "$branch" | sha256sum | cut -c1-8)
      max_project=$((128 - ${#slug} - ${#digest} - 2)); [[ $max_project -ge 1 ]] || fail
      prefix=${project_workspace:0:max_project}; target_workspace="$prefix-$slug-$digest"; valid_name "$target_workspace" || fail
      target_path="$configured_root/$target_workspace"
      [[ ! -e "$target_path" && ! -L "$target_path" ]] || fail
      ! grep -Fxq "worktree $target_path" <<<"$worktrees" || fail
      jq -nce --arg rootKey "$root_key" --arg sourceWorkspace "$workspace" --arg projectWorkspace "$project_workspace" --arg targetWorkspace "$target_workspace" \
        --arg commonDir "$common" --arg mainPath "$main_path" --arg targetPath "$target_path" --arg baseRef "$base_ref_full" --arg baseCommit "$base_commit" --arg branch "$branch" \
        '{rootKey:$rootKey,sourceWorkspace:$sourceWorkspace,projectWorkspace:$projectWorkspace,targetWorkspace:$targetWorkspace,commonDir:$commonDir,mainPath:$mainPath,targetPath:$targetPath,baseRef:$baseRef,baseCommit:$baseCommit,branch:$branch}'
      ;;
    worktree-create-apply)
      workspace=$(field '.sourceWorkspace'); resolve_project "$workspace"
      [[ "$common" == $(field '.commonDir') && "$main_path" == $(field '.mainPath') && "$project_workspace" == $(field '.projectWorkspace') ]] || fail
      target_workspace=$(field '.targetWorkspace'); valid_name "$target_workspace" || fail
      target_path=$(field '.targetPath'); [[ "$target_path" == "$configured_root/$target_workspace" ]] || fail
      branch=$(field '.branch'); base_ref_full=$(field '.baseRef'); base_commit=$(field '.baseCommit'); resume=$(jq -r '.resumeExisting | if type == "boolean" then tostring else error("invalid") end' <<<"$request")
      [[ "$base_ref_full" == refs/heads/* || "$base_ref_full" == refs/remotes/* || "$base_ref_full" == refs/tags/* ]] || fail
      worktrees=$(git --git-dir="$common" worktree list --porcelain 2>/dev/null)
      branch_exists=false; git --git-dir="$common" show-ref --verify --quiet "refs/heads/$branch" && branch_exists=true
      if [[ "$branch_exists" == false ]]; then
        [[ "$resume" == false && ! -e "$target_path" && ! -L "$target_path" ]] || fail
        [[ $(git --git-dir="$common" rev-parse --verify --end-of-options "$base_ref_full^{commit}" 2>/dev/null) == "$base_commit" ]] || fail
        git -C "$main_path" worktree add -b "$branch" "$target_path" "$base_commit" >/dev/null
      else
        [[ "$resume" == true && $(git --git-dir="$common" rev-parse --verify "refs/heads/$branch") == "$base_commit" ]] || fail
        if ! grep -Fxq "worktree $target_path" <<<"$worktrees"; then
          if [[ -e "$target_path" ]]; then [[ -d "$target_path" && ! -L "$target_path" && -z $(find "$target_path" -mindepth 1 -maxdepth 1 -print -quit) ]] || fail; fi
          git -C "$main_path" worktree add "$target_path" "$branch" >/dev/null
        fi
      fi
      worktrees=$(git --git-dir="$common" worktree list --porcelain 2>/dev/null); block=$(registered_block "$target_path") || fail
      grep -Fxq "branch refs/heads/$branch" <<<"$block" || fail
      [[ $(git -C "$target_path" rev-parse HEAD) == "$base_commit" ]] || fail
      jq -nce --arg rootKey "$root_key" --arg workspace "$target_workspace" --arg branch "$branch" --arg baseCommit "$base_commit" \
        '{rootKey:$rootKey,workspace:$workspace,branch:$branch,baseCommit:$baseCommit}'
      ;;
    worktree-remove-preview)
      workspace=$(field '.workspace'); resolve_project "$workspace"
      [[ "$workspace_path" != "$main_path" ]] || fail
      block=$(registered_block "$workspace_path") || fail
      locked=false; grep -Eq '^locked( |$)' <<<"$block" && locked=true
      branch_full=$(awk '/^branch refs\/heads\// { print substr($0,8); exit }' <<<"$block"); [[ "$branch_full" == refs/heads/* ]] || fail
      branch=${branch_full#refs/heads/}; head=$(git -C "$workspace_path" rev-parse HEAD); [[ "$head" =~ ^[a-f0-9]{40,64}$ ]] || fail
      clean=false; if worktree_is_clean "$workspace_path"; then clean=true; fi
      merge_input=$(jq -er '.mergeTarget // empty' <<<"$request" || true); merge_ref=""; merge_commit=""; merged_json=null
      if [[ -n "$merge_input" ]]; then resolve_ref "$merge_input"; merge_ref="$resolved_ref"; merge_commit="$resolved_commit"; merged_json=false; git --git-dir="$common" merge-base --is-ancestor "$head" "$merge_commit" && merged_json=true || true; fi
      jq -nce --arg rootKey "$root_key" --arg workspace "$workspace" --arg projectWorkspace "$project_workspace" --arg path "$workspace_path" --arg commonDir "$common" --arg mainPath "$main_path" \
        --arg branch "$branch" --arg head "$head" --argjson clean "$clean" --argjson locked "$locked" --arg mergeRef "$merge_ref" --arg mergeCommit "$merge_commit" --argjson merged "$merged_json" \
        '{rootKey:$rootKey,workspace:$workspace,projectWorkspace:$projectWorkspace,path:$path,commonDir:$commonDir,mainPath:$mainPath,branch:$branch,head:$head,clean:$clean,locked:$locked} +
         (if $mergeRef == "" then {} else {mergeTarget:$mergeRef,mergeCommit:$mergeCommit,merged:$merged} end)'
      ;;
    worktree-remove-apply)
      workspace=$(field '.workspace'); expected_path=$(field '.path'); project_workspace=$(field '.projectWorkspace')
      if [[ ! -e "$configured_root/$workspace" && ! -L "$configured_root/$workspace" ]]; then
        [[ $(jq -r '.resumeExisting | if type == "boolean" then tostring else error("invalid") end' <<<"$request") == true ]] || fail
        resolve_project "$project_workspace"
        [[ "$common" == $(field '.commonDir') && "$main_path" == $(field '.mainPath') ]] || fail
        ! grep -Fxq "worktree $expected_path" <<<"$worktrees" || fail
        branch=$(field '.branch'); head=$(field '.head')
        [[ $(git --git-dir="$common" rev-parse --verify "refs/heads/$branch" 2>/dev/null) == "$head" ]] || fail
      else
        resolve_project "$workspace"
        [[ "$workspace_path" != "$main_path" && "$workspace_path" == "$expected_path" && "$common" == $(field '.commonDir') && "$main_path" == $(field '.mainPath') ]] || fail
        block=$(registered_block "$workspace_path") || fail; ! grep -Eq '^locked( |$)' <<<"$block" || fail
        branch=$(field '.branch'); head=$(field '.head'); grep -Fxq "branch refs/heads/$branch" <<<"$block" || fail
        [[ $(git -C "$workspace_path" rev-parse HEAD) == "$head" ]] || fail
        worktree_is_clean "$workspace_path" || fail
        git -C "$main_path" worktree remove "$workspace_path" >/dev/null
      fi
      branch=$(field '.branch'); head=$(field '.head')
      [[ ! -e "$expected_path" && ! -L "$expected_path" ]] || fail
      jq -nce --arg rootKey "$root_key" --arg workspace "$workspace" --arg branch "$branch" --arg head "$head" '{rootKey:$rootKey,workspace:$workspace,branch:$branch,head:$head,removed:true}'
      ;;
    worktree-branch-delete)
      workspace=$(field '.projectWorkspace'); resolve_project "$workspace"
      [[ "$common" == $(field '.commonDir') && "$main_path" == $(field '.mainPath') ]] || fail
      branch=$(field '.branch'); head=$(field '.head'); merge_ref=$(field '.mergeTarget'); merge_commit=$(field '.mergeCommit')
      if ! git --git-dir="$common" show-ref --verify --quiet "refs/heads/$branch"; then
        [[ $(jq -r '.resumeExisting | if type == "boolean" then tostring else error("invalid") end' <<<"$request") == true ]] || fail
        jq -nce --arg branch "$branch" '{branch:$branch,deleted:true}'
        exit 0
      fi
      [[ $(git --git-dir="$common" rev-parse --verify "refs/heads/$branch" 2>/dev/null) == "$head" ]] || fail
      [[ $(git --git-dir="$common" rev-parse --verify --end-of-options "$merge_ref^{commit}" 2>/dev/null) == "$merge_commit" ]] || fail
      ! grep -Fxq "branch refs/heads/$branch" <<<"$(git --git-dir="$common" worktree list --porcelain)" || fail
      git --git-dir="$common" merge-base --is-ancestor "$head" "$merge_commit" || fail
      git -C "$main_path" branch -d -- "$branch" >/dev/null
      jq -nce --arg branch "$branch" '{branch:$branch,deleted:true}'
      ;;
    *) fail ;;
  esac
  exit 0
fi
