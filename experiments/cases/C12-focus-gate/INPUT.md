# C12 — B1 focus consistency gate

## 被测行为

用户用 `/goal-set` (非-sisyphus drafting focus)，但在 topic 里描述了一个"按顺序的多步任务"，agent 可能想自作主张设 sisyphus=true。B1 schema gate REJECT 此提案，强制 agent 用 sisyphus=false。

预期：最终成功的 propose_goal_draft 一定是 sisyphus=false。如果 agent 第一次试图 sisyphus=true 会被 schema 拒绝，agent 必须重试。

## Prompts

TURN: /goal-set 我要做一个按部就班的工作：先在当前目录创建 file1.txt 写 'one'，然后创建 file2.txt 写 'two'。autoContinue: true。
