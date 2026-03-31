#!/usr/bin/env bash
set -uo pipefail

repo_root="$(git rev-parse --show-toplevel)"
prompt_file="${LOOP_PROMPT:-${repo_root}/prompts/implementation/session-switcher-v1-iteration.md}"
max_iterations="${LOCAL_MAX_ITERATIONS:-${MAX_ITERATIONS:-${ITERATIONS:-10}}}"
model="${CODEX_MODEL:-gpt-5.4}"
reasoning="${CODEX_REASONING:-medium}"
sandbox="${CODEX_SANDBOX:-danger-full-access}"
dry_run="${DRY_RUN:-0}"
run_verify="${PI_HARNESS_LOOP_VERIFY:-1}"
require_clean="${PI_HARNESS_LOOP_REQUIRE_CLEAN:-0}"
full_auto="${PI_HARNESS_LOOP_FULL_AUTO:-1}"
resume_in_progress="${PI_HARNESS_LOOP_RESUME_IN_PROGRESS:-1}"
reopen_stale_in_progress="${PI_HARNESS_LOOP_REOPEN_STALE_IN_PROGRESS:-1}"
beads_label="${BEADS_WORK_LABEL:-session-switcher-v1}"
execution_label="${BEADS_EXECUTION_LABEL:-leaf}"
beads_actor="${BEADS_ACTOR:-$(git -C "${repo_root}" config user.name 2>/dev/null || true)}"

if [ -z "${beads_actor}" ]; then
  beads_actor="${USER:-}"
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --iterations|-n)
      max_iterations="$2"
      shift 2
      ;;
    --model|-m)
      model="$2"
      shift 2
      ;;
    --reasoning|-r)
      reasoning="$2"
      shift 2
      ;;
    --prompt|-p)
      prompt_file="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift 1
      ;;
    --verify|--no-verify|--clean|--no-clean|--resume-in-progress|--no-resume-in-progress|--reopen-stale-in-progress|--no-reopen-stale-in-progress)
      case "$1" in
        --verify)
          run_verify=1
          ;;
        --no-verify)
          run_verify=0
          ;;
        --clean)
          require_clean=1
          ;;
        --no-clean)
          require_clean=0
          ;;
        --resume-in-progress)
          resume_in_progress=1
          ;;
        --no-resume-in-progress)
          resume_in_progress=0
          ;;
        --reopen-stale-in-progress)
          reopen_stale_in_progress=1
          ;;
        --no-reopen-stale-in-progress)
          reopen_stale_in_progress=0
          ;;
      esac
      shift 1
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: session-switcher-local-loop.sh [options]

Run Codex in a local bounded loop backed by Beads issue selection.

Options:
  --iterations, -n <N>  Number of Codex runs (default 10)
  --model, -m <model>   Codex model (default: gpt-5.4)
  --reasoning, -r <lvl> Reasoning effort (default: medium)
  --prompt, -p <path>   Prompt file (default: prompts/implementation/session-switcher-v1-iteration.md)
  --dry-run             Print the generated prompt and exit
  --verify              Run `nix run .#verify` after each iteration (default: enabled)
  --no-verify           Skip verify
  --clean               Require clean worktree after each iteration
  --no-clean            Do not require clean worktree (default)
  --resume-in-progress  Resume one claimed in-progress leaf issue when no ready open leaf exists (default)
  --no-resume-in-progress
                        Fail instead of resuming claimed in-progress leaf work
  --reopen-stale-in-progress
                        Reopen multiple stranded in-progress leaf issues when the worktree is clean (default)
  --no-reopen-stale-in-progress
                        Fail instead of reopening multiple stranded in-progress leaf issues
  -h, --help            Show this help
USAGE
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
    *)
      echo "Unexpected positional argument: $1" >&2
      exit 1
      ;;
  esac
done

if ! [[ "${max_iterations}" =~ ^[0-9]+$ ]] || [ "${max_iterations}" -le 0 ]; then
  echo "max iterations must be a positive integer: ${max_iterations}" >&2
  exit 1
fi

if [ ! -f "${prompt_file}" ]; then
  echo "missing prompt file: ${prompt_file}" >&2
  exit 1
fi

require_cmd bd
require_cmd codex
require_cmd git
require_cmd jq
if [ "${run_verify}" = "1" ]; then
  require_cmd nix
fi

find_ready_issue() {
  (
    cd "${repo_root}" || exit 1
    bd ready --label "${beads_label}" --label "${execution_label}" --exclude-type epic --json
  ) | jq -c '
    map(select((.issue_type // "") != "epic"))
    | sort_by(.priority, .id)
    | .[0] // empty
  '
}

find_in_progress_issues() {
  (
    cd "${repo_root}" || exit 1
    bd list --status=in_progress --assignee "${beads_actor}" --exclude-type epic --label "${beads_label}" --label "${execution_label}" --json
  ) | jq -c '
    sort_by(.priority, .id)
  '
}

print_in_progress_diagnostic() {
  local issues_json="$1"
  local issue_count
  issue_count="$(printf '%s\n' "${issues_json}" | jq 'length')"

  echo "no open ready non-epic Beads issue found for ${beads_label}" >&2
  echo "${issue_count} claimed non-epic issue(s) are still in progress for ${beads_actor}:" >&2
  printf '%s\n' "${issues_json}" | jq -r '.[] | "- \(.id) - \(.title)"' >&2
  echo "reopen abandoned clean issues with: bd update <id> --status open --assignee \"\"" >&2
  echo "or rerun with --resume-in-progress after reducing the queue to one active leaf issue" >&2
}

claim_issue() {
  local issue_id="$1"
  (
    cd "${repo_root}" || exit 1
    bd update "${issue_id}" --claim --json >/dev/null
  )
}

show_issue() {
  local issue_id="$1"
  (
    cd "${repo_root}" || exit 1
    bd show "${issue_id}" --long --json
  )
}

reopen_issue() {
  local issue_id="$1"
  (
    cd "${repo_root}" || exit 1
    bd update "${issue_id}" --status open --assignee "" --json >/dev/null
  )
}

reopen_issues() {
  local issues_json="$1"
  while IFS= read -r issue_id; do
    [ -n "${issue_id}" ] || continue
    reopen_issue "${issue_id}"
  done < <(printf '%s\n' "${issues_json}" | jq -r '.[].id')
}

iterations_with_failures=0
overall_status=0

for ((iteration = 1; iteration <= max_iterations; iteration++)); do
  issue_json="$(find_ready_issue || true)"
  if [ -z "${issue_json}" ]; then
    in_progress_issues="$(find_in_progress_issues || printf '[]\n')"
    in_progress_count="$(printf '%s\n' "${in_progress_issues}" | jq 'length')"

    if [ "${resume_in_progress}" = "1" ] && [ "${in_progress_count}" -eq 1 ]; then
      issue_json="$(printf '%s\n' "${in_progress_issues}" | jq -c '.[0]')"
      issue_was_resumed=1
      echo "resuming claimed in-progress issue for ${beads_actor}"
    elif [ "${reopen_stale_in_progress}" = "1" ] && [ "${in_progress_count}" -gt 1 ] && [ -z "$(git -C "${repo_root}" status --porcelain)" ]; then
      reopen_issues "${in_progress_issues}"
      echo "reopened ${in_progress_count} stranded in-progress issue(s) for ${beads_actor}" >&2
      issue_json="$(find_ready_issue || true)"
      if [ -z "${issue_json}" ]; then
        echo "no open ready non-epic Beads issue found for ${beads_label} after reopening stranded in-progress issues" >&2
        exit 1
      fi
      issue_was_resumed=0
    elif [ "${in_progress_count}" -gt 0 ]; then
      print_in_progress_diagnostic "${in_progress_issues}"
      exit 1
    else
      echo "no open ready non-epic Beads issue found for ${beads_label}"
      exit 0
    fi
  else
    issue_was_resumed=0
  fi

  issue_id="$(printf '%s\n' "${issue_json}" | jq -r '.id')"
  issue_title="$(printf '%s\n' "${issue_json}" | jq -r '.title')"
  issue_detail="$(show_issue "${issue_id}")"
  start_head="$(git -C "${repo_root}" rev-parse HEAD 2>/dev/null || printf 'unborn\n')"
  iteration_prompt="$(mktemp "${TMPDIR:-/tmp}/pi-harness-local-prompt.XXXXXX.md")"
  trap 'rm -f "${iteration_prompt}"' EXIT
  iteration_status=0

  {
    printf 'This is implementation loop iteration %d of %d.\n\n' "${iteration}" "${max_iterations}"
    printf 'Model: %s\n' "${model}"
    printf 'Reasoning effort: %s\n' "${reasoning}"
    printf 'Current Beads issue: %s - %s\n\n' "${issue_id}" "${issue_title}"
    cat "${prompt_file}"
    printf '\n## Current Beads Issue\n\n'
    printf '%s\n' '```json'
    printf '%s\n' "${issue_detail}"
    printf '%s\n' '```'
  } > "${iteration_prompt}"

  echo "iteration ${iteration}/${max_iterations}: ${issue_id} - ${issue_title}"

  if [ "${dry_run}" = "1" ]; then
    echo "dry run prompt written to ${iteration_prompt}"
    echo "--- prompt (truncated) ---"
    sed -n '1,80p' "${iteration_prompt}"
    echo "--- end ---"
    exit 0
  fi

  claim_issue "${issue_id}"
  issue_detail="$(show_issue "${issue_id}")"
  {
    printf '\n## Claimed Beads Issue\n\n'
    printf '%s\n' '```json'
    printf '%s\n' "${issue_detail}"
    printf '%s\n' '```'
  } >> "${iteration_prompt}"

  codex_command=(codex exec --json --model "${model}" -c model_reasoning_effort="${reasoning}" --cd "${repo_root}" --sandbox "${sandbox}")
  if [ "${full_auto}" = "1" ]; then
    codex_command+=(--full-auto)
  fi

  if ! PI_HARNESS_LOOP_ACTIVE=1 "${codex_command[@]}" < "${iteration_prompt}"; then
    echo "iteration ${iteration}/${max_iterations}: codex execution failed" >&2
    current_head="$(git -C "${repo_root}" rev-parse HEAD 2>/dev/null || printf 'unborn\n')"
    if [ "${issue_was_resumed}" = "0" ] && [ "${start_head}" = "${current_head}" ] && [ -z "$(git -C "${repo_root}" status --porcelain)" ]; then
      reopen_issue "${issue_id}"
      echo "iteration ${iteration}/${max_iterations}: reopened ${issue_id} after failed clean no-op run" >&2
    fi
    iteration_status=1
  fi

  if [ "${run_verify}" = "1" ]; then
    if ! (cd "${repo_root}" && nix run .#verify); then
      echo "iteration ${iteration}/${max_iterations}: verification failed" >&2
      iteration_status=1
    fi
  fi

  if [ "${require_clean}" = "1" ] && [ -n "$(git -C "${repo_root}" status --porcelain)" ]; then
    echo "worktree is dirty; expected clean state after verification" >&2
    iteration_status=1
  fi

  rm -f "${iteration_prompt}"
  trap - EXIT

  if [ "${iteration_status}" -ne 0 ]; then
    iterations_with_failures=$((iterations_with_failures + 1))
    overall_status=1
  fi
done

if [ "${overall_status}" -ne 0 ]; then
  echo "loop completed ${max_iterations} iterations with ${iterations_with_failures} failing iteration(s)" >&2
fi

exit "${overall_status}"
