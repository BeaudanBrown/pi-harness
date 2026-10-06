# Read-only automatic eligibility. Explicit workspace operations keep their
# existing non-Git support; this path must never classify a nested checkout as
# its enclosing workspace, or treat failed validation as a standalone fallback.
if [[ "${operation-}" == workspace-identify-auto ]]; then
  : "${request:?launcher request is required}"
  auto_roots=$(jq -ce 'select(type == "object")' <<<"${PI_MANAGED_SESSIONS_WORKSPACE_ROOTS:?}")
  auto_cwd=$(jq -er '.cwd | select(type == "string" and length >= 1 and length <= 4096 and startswith("/") and (test("[\u0000-\u001f\u007f]") | not))' <<<"$request")
  [[ ! -L "$auto_cwd" && -d "$auto_cwd" && $(realpath -e "$auto_cwd") == "$auto_cwd" ]]
  if ! auto_checkout=$(git -C "$auto_cwd" rev-parse --show-toplevel 2>/dev/null); then
    printf '%s\n' '{"eligible":false,"reason":"not-git-checkout"}'
    exit 0
  fi
  [[ -n "$auto_checkout" && ${#auto_checkout} -le 4096 && "$auto_checkout" != *$'\n'* ]]
  auto_checkout=$(realpath -e "$auto_checkout")
  auto_matches=0
  auto_placement=""
  while IFS= read -r auto_encoded; do
    auto_row=$(printf '%s' "$auto_encoded" | base64 --decode)
    auto_key=$(jq -er '.key | select(type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"))' <<<"$auto_row")
    auto_root_raw=$(jq -er '.value | select(type == "string" and length >= 1 and length <= 4096 and startswith("/") and (test("[\u0000-\u001f\u007f]") | not))' <<<"$auto_row")
    [[ -e "$auto_root_raw" ]] || continue
    [[ ! -L "$auto_root_raw" ]]
    auto_root=$(realpath -e "$auto_root_raw")
    [[ -d "$auto_root" ]]
    # A named root owns immediate-child checkouts, not arbitrary nested repos.
    # This also disambiguates nested named roots without weakening explicit
    # non-Git workspace identification.
    [[ $(dirname "$auto_checkout") == "$auto_root" ]] || continue
    auto_workspace=$(basename "$auto_checkout")
    [[ "$auto_workspace" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]
    [[ "$auto_cwd" == "$auto_checkout" || "$auto_cwd" == "$auto_checkout/"* ]]
    auto_relative="${auto_cwd#"$auto_checkout"}"
    auto_relative="${auto_relative#/}"
    auto_candidate=$(jq -nce --arg rootKey "$auto_key" --arg workspace "$auto_workspace" --arg relativeCwd "$auto_relative" \
      '{rootKey:$rootKey,workspace:$workspace,relativeCwd:$relativeCwd}')
    auto_matches=$((auto_matches + 1))
    auto_placement=$auto_candidate
  done < <(jq -r 'to_entries[] | @base64' <<<"$auto_roots")
  if [[ $auto_matches -eq 0 ]]; then
    printf '%s\n' '{"eligible":false,"reason":"outside-configured-checkouts"}'
    exit 0
  fi
  if [[ $auto_matches -ne 1 ]]; then
    echo 'Ambiguous configured checkout roots' >&2
    exit 1
  fi
  # Reuse the trusted resolver in a separate process: its fail-closed shell
  # checks must not be disabled by calling a function in an `if` condition.
  auto_proof=$(printf '%s\n' "$auto_placement" | "$0" managed workspace-resolve)
  jq -e --arg cwd "$auto_cwd" --arg checkout "$auto_checkout" '.cwd == $cwd and .workspacePath == $checkout' <<<"$auto_proof" >/dev/null
  auto_common=$(realpath -e "$(git -C "$auto_checkout" rev-parse --path-format=absolute --git-common-dir)")
  auto_worktrees=$(git --git-dir="$auto_common" worktree list --porcelain)
  [[ -n "$auto_worktrees" && ${#auto_worktrees} -le 65536 ]]
  EXPECTED_AUTO_CHECKOUT="$auto_checkout" awk '$0 == "worktree " ENVIRON["EXPECTED_AUTO_CHECKOUT"] { found=1 } END { exit !found }' <<<"$auto_worktrees"
  if [[ -f "$auto_checkout/.git" ]]; then
    auto_gitdir=$(realpath -e "$(git -C "$auto_checkout" rev-parse --path-format=absolute --git-dir)")
    [[ -f "$auto_gitdir/gitdir" && ! -L "$auto_gitdir/gitdir" ]]
    auto_backlink=$(<"$auto_gitdir/gitdir")
    [[ $(realpath -e "$auto_backlink") == "$auto_checkout/.git" ]]
  fi
  jq -nce --argjson placement "$auto_placement" --arg cwd "$auto_cwd" '{eligible:true,placement:$placement,cwd:$cwd}'
  exit 0
fi
