# C2 — `/goal-set` 完整 spec 应该直接进入 create_goal（不再多绕弯）

## 被测行为

当用户在 `/goal-set` 后给出**已经清晰、可验证、有边界**的完整描述时，agent 不应该死板地走 3 轮反问；应该用一句确认 + 立即调 `create_goal`。

## Prompts

TURN: /goal-set 在 sandbox 当前目录创建一个新文件叫 hello.txt，文件内容是 "Hello, Goal!" 单独一行（不带额外空行）。完成标准：文件存在且内容完全等于这一行。不要修改其他文件。不需要交互式提问。autoContinue: true。
