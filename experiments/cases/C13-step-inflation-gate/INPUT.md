# C13 — B2 step preservation gate (no agent step inflation)

## 被测行为

用户用 `/goal-sis` 给出明确的 2 步 plan。agent 可能想"贴心地"加 "step 0: 检查 X 是否存在" 这种 reconnaissance step。B2 schema gate REJECT，因为 proposed steps > user steps + 1。agent 必须保留 user 原本的 2 步。

这是 Phase 4 C6 1/3 失败的直接复现 + 修复验证。

## Prompts

TURN: /goal-sis 严格按顺序做两件事：1) 在当前目录创建 a.txt 内容 "alpha"。2) 在当前目录创建 b.txt 内容 "beta"。不允许添加任何额外步骤（包括"检查"、"验证"、"准备"之类的）。autoContinue: true。
