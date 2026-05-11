# C17 — MAX_AUTOCONTINUE_TURNS hard cap (B5 runtime)

## 被测行为

Phase 4 的 `MAX_AUTOCONTINUE_TURNS` 硬上限在实战中触发：autoContinue 链超过上限时，goal 自动 paused，stopReason="agent"，pauseReason 含 "Auto-continue cap reached"。

`env.json` 把 cap 设为 3，所以 3 个 autoContinue turn 后就触发。Turn 1 是 drafting，turn 2 是 user clarification → propose_goal_draft，之后 autoContinue 接管。Agent 不会自然 update_goal=complete，所以走完 3 个 autoContinue turn 后触发 cap。

## Prompts

TURN: /goal-set 持续写一个关于幸福本质的开放性思考。每个 turn 写一段（不要超过 100 字），探讨一个新的角度。没有"完成"概念 — 一直写下去直到外部停止。完成标准: 写到第 100 段时才算完成。autoContinue: true。
TURN: Objective 就是「持续写关于幸福本质的开放性思考」，criteria 是「写到第 100 段」，autoContinue=true，sisyphus=false。请立刻 propose_goal_draft 提交，不需要再确认了。
