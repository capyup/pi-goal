# C4 — `/goal-tweak` 应该编辑当前 active goal 的 objective

## 被测行为

Turn 1 建一个 goal；Turn 2 用 `/goal-tweak` 让 agent 修改 objective 来扩大范围。Agent 应：

- 不再创建新 goal（不调 create_goal）
- 不开始新工作
- 通过 edit 工具修改 disk 上的 active_goal_*.md 来落地 tweak（这是 extension 设计：tweak drafting 引导 agent 编辑 active_goal_*.md 的 # Goal Prompt 段）

Turn 1 故意写成"已经 complete 的状态" — 给 agent 一个 already-done objective，避免 autoContinue 跑起来抢占。设 autoContinue=false。

## Prompts

TURN: /goal-set 你的目标只是占位 placeholder：在 sandbox 当前目录创建文件 base.txt 内容是 "base"。完成标准：文件存在且内容等于 "base"。autoContinue: false。我会用 /goal-tweak 来调整这个目标。
TURN: /goal-tweak 把目标改成：同时创建 base.txt（内容 "base"）和 extra.txt（内容 "extra"）。两个文件都要存在。改完后只更新 objective，不要立即执行。
