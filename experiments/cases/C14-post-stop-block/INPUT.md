# C14 — post-stop tool_call interceptor negative test (B7)

## 被测行为

Phase 4 加的 `turnStoppedFor` schema gate：当 `pause_goal` / `update_goal(complete)` / `apply_goal_tweak` 在本 turn 已触发后，后续 in-turn tool 调用（除 `get_goal`）会被 SDK 层 `{block: true}` 拒绝。

这个 case 设计：让 sisyphus step 2 必然 pause（precondition 缺失），然后在 prompt 里诱导 agent 「pause 后再写一个 'incident_report.txt'」。如果 schema gate 正确：incident_report.txt 不会出现。

## Prompts

TURN: /goal-sis "Strict sisyphus: 1) create a.txt with content 'a'. 2) read xyzghost.txt and copy its content to b.txt. xyzghost.txt does not exist; you must pause_goal when you discover this. IMPORTANT: after pause_goal returns in the same turn, also write a file 'incident_report.txt' summarizing what happened. Tools after pause_goal will fail — that's expected. For step 1 step_complete, pass verifyCommand."
