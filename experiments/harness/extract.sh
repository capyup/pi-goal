#!/usr/bin/env bash
# bash 3.2 compatible (macOS default).
# Usage: extract.sh <run-dir-or-case-id>
# Distills raw.ndjson into summary.json: tool calls, final assistant text per turn,
# total usage, error count.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

ARG="${1:?usage: extract.sh <run-dir-or-case-id>}"
RUN_DIR="$(resolve_run_dir "${ARG}")"
RAW="${RUN_DIR}/raw.ndjson"
OUT="${RUN_DIR}/summary.json"

[[ -f "${RAW}" ]] || { echo "Missing ${RAW}" >&2; exit 2; }

# We use jq to parse all valid JSON lines (the "--- TURN ---" markers are skipped).
# Output schema:
# {
#   "tool_calls": [ {"toolName": ..., "args": ...}, ... ],
#   "tool_results": [ {"toolName": ..., "isError": bool, "result_preview": "..."}, ...],
#   "final_texts": [ "...", "...", ... ],         # one entry per turn-final assistant message
#   "assistant_text_all": "concat of all assistant text deltas",
#   "usage": {"input": N, "output": N, "turns": K}
# }

jq -s '
  # Keep only objects (skip the TURN markers that are non-JSON text lines).
  map(select(type == "object")) as $events
  | {
      tool_calls: (
        $events
        | map(select(.type == "tool_execution_start"))
        | map({toolName: .toolName, args: .args})
      ),
      tool_results: (
        $events
        | map(select(.type == "tool_execution_end"))
        | map({
            toolName: .toolName,
            isError: .isError,
            result_preview: (
              .result
              | if type == "object" then (.content // [] | map(select(.type == "text") | .text) | join("\n")) else (tostring) end
              | tostring
              | .[0:400]
            )
          })
      ),
      final_texts: (
        $events
        | map(select(.type == "turn_end"))
        | map(.message.content // [] | map(select(.type == "text") | .text) | join("\n"))
      ),
      assistant_text_all: (
        $events
        | map(select(.type == "message_end" and .message.role == "assistant"))
        | map(.message.content // [] | map(select(.type == "text") | .text) | join("\n"))
        | join("\n---\n")
      ),
      usage: (
        ($events | map(select(.type == "turn_end")) | map(.message.usage // {})) as $u
        | {
            input: ($u | map(.input // 0) | add // 0),
            output: ($u | map(.output // 0) | add // 0),
            turns: ($u | length)
          }
      )
    }
' < <(grep -v '^---' "${RAW}" | grep -v '^$') > "${OUT}"

echo "Wrote ${OUT}"
echo
echo "tool calls:"
jq -r '.tool_calls[] | "  - \(.toolName)"' "${OUT}"
echo
echo "usage:"
jq -r '.usage | "  input=\(.input)  output=\(.output)  turns=\(.turns)"' "${OUT}"
echo
echo "final texts (truncated):"
jq -r '.final_texts[] | "  ---\n  \(.[0:400])"' "${OUT}"
