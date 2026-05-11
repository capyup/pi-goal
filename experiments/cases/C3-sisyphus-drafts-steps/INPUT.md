# C3 — `/goal-sis` 完整 spec 应该 create_goal 且 objective 包含编号步骤

## 被测行为

Sisyphus 模式下，drafting 必须产出明确的 numbered steps。给定一个清晰且可分解的任务，agent 应在 1-2 turn 内完成 drafting，调用 create_goal 时 objective 包含编号步骤（"1.", "2.", "3." 等）。

## Prompts

TURN: /goal-sis 我要在当前目录做三件事，按顺序：第一，创建文件 a.txt 内容是 "a"；第二，创建文件 b.txt 内容是 "b"；第三，把 a.txt 和 b.txt 合并到 c.txt，c.txt 内容应该是 "a\nb"（两行）。完成标准：a.txt, b.txt, c.txt 都存在且内容正确。每个 step_complete 调用都必须提供 verifyCommand 让框架自动验证文件内容是否正确（比如 `test -f a.txt && [ "$(cat a.txt)" = a ]`）。不要修改当前目录外的任何东西。autoContinue: true。
