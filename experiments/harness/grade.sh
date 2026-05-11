#!/usr/bin/env bash
# bash 3.2 compatible (macOS default).
# Globs in rubric kinds (sandbox-glob-*) are resolved via `find` instead of
# bash's globstar, so `**/foo` works without `shopt -s globstar`.
# Usage: grade.sh <run-dir-or-case-id>
# Reads cases/<case>/rubric.json + the run's summary.json + sandbox, then writes score.md.
#
# rubric.json schema:
# [
#   {
#     "id": "no-create-goal",
#     "desc": "Agent must not call create_goal in turn 1.",
#     "kind": "tool-not-called",      # see KINDS below
#     "tool": "create_goal"
#   },
#   ...
# ]
#
# Supported "kind"s:
#
#   tool-called               { "tool": "<name>" }
#       Pass iff summary.tool_calls contains a call to <name>.
#
#   tool-not-called           { "tool": "<name>" }
#       Pass iff summary.tool_calls does NOT contain a call to <name>.
#
#   tool-args-jq              { "tool": "<name>", "jq": "<expr returning bool>" }
#       Pass iff at least one call to <name> exists AND the jq expr evaluated
#       on that call's .args returns true.
#
#   final-text-matches        { "pattern": "regex" }
#       Pass iff at least one final_texts entry matches the regex (perl-extended).
#
#   final-text-not-matches    { "pattern": "regex" }
#       Pass iff NO final_texts entry matches.
#
#   sandbox-file-exists       { "path": "rel/path" }
#       Pass iff <run>/sandbox/<path> exists.
#
#   sandbox-file-contains     { "path": "rel/path", "pattern": "regex" }
#       Pass iff file exists AND content matches regex.
#
#   sandbox-glob-exists       { "glob": "**/active_goal_*.md" }
#       Pass iff at least one file matching glob exists under sandbox.
#
#   sandbox-glob-not-exists   { "glob": "<g>" }
#       Pass iff NO file matches the glob.
#
#   sandbox-glob-contains     { "glob": "<g>", "pattern": "<re>" }
#       Pass iff at least one matched file contains the pattern.
#
#   usage-output-le           { "limit": 8000 }
#       Pass iff summary.usage.output <= limit.

set -euo pipefail

# Resolve a (possibly-**-containing) glob under SANDBOX, printing each match
# on a separate line. We translate the user-friendly glob into a find -path
# pattern: `**` matches any depth, anything else matches a single segment.
resolve_sandbox_glob() {
  local glob="$1"
  # Strip leading ./ if any.
  glob="${glob#./}"
  # Build a find -path pattern. find -path matches the full path including
  # SANDBOX prefix, and `**` in shell glob ≈ `*` in find -path (find doesn't
  # respect / boundaries in -path matches).
  local pattern="${SANDBOX}/${glob}"
  # Replace ** with * (find -path doesn't distinguish).
  pattern="${pattern//\*\*/*}"
  find "${SANDBOX}" -type f -path "${pattern}" 2>/dev/null
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

ARG="${1:?usage: grade.sh <run-dir-or-case-id>}"
RUN_DIR="$(resolve_run_dir "${ARG}")"
SUMMARY="${RUN_DIR}/summary.json"
[[ -f "${SUMMARY}" ]] || { echo "Run not extracted yet. Run extract.sh first." >&2; exit 2; }

# Recover the case dir for rubric.
RUNS_DIR="$(dirname "${RUN_DIR}")"
CASE_DIR="$(dirname "${RUNS_DIR}")"
RUBRIC="${CASE_DIR}/rubric.json"
[[ -f "${RUBRIC}" ]] || { echo "Missing ${RUBRIC}" >&2; exit 2; }

SANDBOX="${RUN_DIR}/sandbox"
SCORE="${RUN_DIR}/score.md"

PASS=0; FAIL=0; TOTAL=0
{
  echo "# Score: $(basename "${CASE_DIR}") — $(basename "${RUN_DIR}")"
  echo
  echo "| # | id | desc | result | detail |"
  echo "|---|---|---|---|---|"
} > "${SCORE}"

idx=0
while IFS= read -r check_json; do
  idx=$((idx + 1))
  TOTAL=$((TOTAL + 1))
  id=$(jq -r '.id'   <<<"${check_json}")
  desc=$(jq -r '.desc' <<<"${check_json}")
  kind=$(jq -r '.kind' <<<"${check_json}")
  result="FAIL"; detail=""

  case "${kind}" in
    tool-called)
      tool=$(jq -r '.tool' <<<"${check_json}")
      count=$(jq --arg t "${tool}" '[.tool_calls[] | select(.toolName == $t)] | length' "${SUMMARY}")
      if [[ "${count}" -gt 0 ]]; then result="PASS"; detail="${count} call(s)"; else detail="0 calls"; fi
      ;;
    tool-not-called)
      tool=$(jq -r '.tool' <<<"${check_json}")
      count=$(jq --arg t "${tool}" '[.tool_calls[] | select(.toolName == $t)] | length' "${SUMMARY}")
      if [[ "${count}" -eq 0 ]]; then result="PASS"; detail="0 calls"; else detail="${count} call(s)"; fi
      ;;
    tool-call-count)
      # Pass iff the call count for <tool> satisfies the comparison.
      # Supports: "eq" (default), "ge", "le", "gt", "lt" via optional .op.
      # Optional .argsJq filter: count only calls whose args match the jq expression.
      tool=$(jq -r '.tool' <<<"${check_json}")
      expected=$(jq -r '.count' <<<"${check_json}")
      op=$(jq -r '.op // "eq"' <<<"${check_json}")
      argsjq=$(jq -r '.argsJq // ""' <<<"${check_json}")
      if [[ -n "${argsjq}" ]]; then
        count=$(jq --arg t "${tool}" "[.tool_calls[] | select(.toolName == \$t) | .args | select(${argsjq})] | length" "${SUMMARY}")
      else
        count=$(jq --arg t "${tool}" '[.tool_calls[] | select(.toolName == $t)] | length' "${SUMMARY}")
      fi
      pass=0
      case "${op}" in
        eq) [[ "${count}" -eq "${expected}" ]] && pass=1 ;;
        ge) [[ "${count}" -ge "${expected}" ]] && pass=1 ;;
        le) [[ "${count}" -le "${expected}" ]] && pass=1 ;;
        gt) [[ "${count}" -gt "${expected}" ]] && pass=1 ;;
        lt) [[ "${count}" -lt "${expected}" ]] && pass=1 ;;
        *)  detail="unknown op: ${op}" ;;
      esac
      if [[ "${pass}" -eq 1 ]]; then result="PASS"; detail="${count} call(s) ${op} ${expected}"; else [[ -z "${detail}" ]] && detail="${count} call(s), expected ${op} ${expected}"; fi
      ;;
    tool-args-jq)
      tool=$(jq -r '.tool' <<<"${check_json}")
      expr=$(jq -r '.jq' <<<"${check_json}")
      hits=$(jq --arg t "${tool}" '[.tool_calls[] | select(.toolName == $t) | .args]' "${SUMMARY}")
      if [[ "$(jq 'length' <<<"${hits}")" -eq 0 ]]; then
        detail="tool not called"
      else
        ok=$(jq "any(.[]; ${expr})" <<<"${hits}")
        if [[ "${ok}" == "true" ]]; then result="PASS"; detail="match"; else detail="no args matched: ${expr}"; fi
      fi
      ;;
    tool-args-jq-none)
      # Pass iff NO call to <tool> satisfies <jq>. Calls=0 also passes.
      tool=$(jq -r '.tool' <<<"${check_json}")
      expr=$(jq -r '.jq' <<<"${check_json}")
      hits=$(jq --arg t "${tool}" '[.tool_calls[] | select(.toolName == $t) | .args]' "${SUMMARY}")
      n=$(jq 'length' <<<"${hits}")
      if [[ "${n}" -eq 0 ]]; then
        result="PASS"; detail="tool not called"
      else
        any=$(jq "any(.[]; ${expr})" <<<"${hits}")
        if [[ "${any}" == "false" ]]; then result="PASS"; detail="${n} call(s), none match"; else detail="at least one call matches forbidden ${expr}"; fi
      fi
      ;;
    final-text-matches)
      pat=$(jq -r '.pattern' <<<"${check_json}")
      if jq -r '.final_texts[]' "${SUMMARY}" | grep -qE "${pat}"; then result="PASS"; detail="matched"; else detail="no match for /${pat}/"; fi
      ;;
    final-text-not-matches)
      pat=$(jq -r '.pattern' <<<"${check_json}")
      if jq -r '.final_texts[]' "${SUMMARY}" | grep -qE "${pat}"; then detail="unexpected match for /${pat}/"; else result="PASS"; detail="no match"; fi
      ;;
    sandbox-file-exists)
      p=$(jq -r '.path' <<<"${check_json}")
      if [[ -f "${SANDBOX}/${p}" ]]; then result="PASS"; detail="exists"; else detail="missing"; fi
      ;;
    sandbox-file-contains)
      p=$(jq -r '.path' <<<"${check_json}")
      pat=$(jq -r '.pattern' <<<"${check_json}")
      if [[ -f "${SANDBOX}/${p}" ]] && grep -qE "${pat}" "${SANDBOX}/${p}"; then result="PASS"; detail="matched"; else detail="file missing or no match"; fi
      ;;
    sandbox-glob-exists)
      g=$(jq -r '.glob' <<<"${check_json}")
      hit="$(resolve_sandbox_glob "${g}" | head -n1)"
      if [[ -n "${hit}" ]]; then result="PASS"; detail="$(basename "${hit}")"; else detail="no match for ${g}"; fi
      ;;
    sandbox-glob-not-exists)
      g=$(jq -r '.glob' <<<"${check_json}")
      hit="$(resolve_sandbox_glob "${g}" | head -n1)"
      if [[ -z "${hit}" ]]; then result="PASS"; detail="no match (as expected)"; else detail="unexpected match: $(basename "${hit}")"; fi
      ;;
    sandbox-glob-contains)
      g=$(jq -r '.glob' <<<"${check_json}")
      pat=$(jq -r '.pattern' <<<"${check_json}")
      hit=""
      while IFS= read -r f; do
        [[ -z "${f}" ]] && continue
        if grep -qE "${pat}" "${f}"; then hit="${f}"; break; fi
      done < <(resolve_sandbox_glob "${g}")
      if [[ -n "${hit}" ]]; then result="PASS"; detail="$(basename "${hit}") matched"; else detail="no file matched ${g} + /${pat}/"; fi
      ;;
    usage-output-le)
      limit=$(jq -r '.limit' <<<"${check_json}")
      out=$(jq -r '.usage.output' "${SUMMARY}")
      if [[ "${out}" -le "${limit}" ]]; then result="PASS"; detail="output=${out} ≤ ${limit}"; else detail="output=${out} > ${limit}"; fi
      ;;
    raw-ndjson-contains)
      # Substring match against the raw NDJSON event stream. Use to verify
      # harness/extension events that don't surface in summary.json (e.g.
      # _drive_abort_scheduled, _drive_error, etc).
      pat=$(jq -r '.pattern' <<<"${check_json}")
      raw="${RUN_DIR}/raw.ndjson"
      if [[ -f "${raw}" ]] && grep -qE "${pat}" "${raw}"; then result="PASS"; detail="matched"; else detail="no match for /${pat}/ in raw.ndjson"; fi
      ;;
    *)
      detail="unknown kind: ${kind}"
      ;;
  esac

  if [[ "${result}" == "PASS" ]]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
  printf '| %d | %s | %s | %s | %s |\n' "${idx}" "${id}" "${desc//|/\\|}" "${result}" "${detail//|/\\|}" >> "${SCORE}"
done < <(jq -c '.[]' "${RUBRIC}")

{
  echo
  echo "**Pass: ${PASS} / ${TOTAL}**"
  if [[ "${TOTAL}" -gt 0 ]]; then
    rate=$(awk "BEGIN{printf \"%.0f\", 100*${PASS}/${TOTAL}}")
    echo "Rate: ${rate}%"
  fi
} >> "${SCORE}"

echo "Wrote ${SCORE}"
cat "${SCORE}"
exit 0
