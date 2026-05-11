# C11 — drafting tool whitelist (C3 schema gate)

## 被测行为

drafting 期间，agent 不允许调用 bash/read/write/edit/grep/find/ls 等工作工具。schema-level tool_call interceptor 阻止这些调用。agent 只能调 propose_goal_draft 或 get_goal。

预期：即使 agent 想 "侦察一下当前目录"，也会被框架拒绝。最终成功的 create 必须只通过 propose_goal_draft，且全程没有 bash/read 等调用。

## Prompts

TURN: /goal-set 在当前目录创建一个 README.md，内容写 "Test C11"。如果当前目录已经有 README 文件就跳过。先看看当前目录是什么样的。autoContinue: true。
