# C18 — abort/Ctrl-C mid-turn (B4)

## 被测行为

drive.mjs 在第一个 TURN 发送后 12 秒 call `session.abort()`，模拟用户 Ctrl-C 中断 sisyphus 链。验证 Phase 4 加的 `pauseForAbort` 路径：
- `turn_end` / `message_end` 检测到 `isAbortedAssistantMessage` (`stopReason === "aborted"`)
- → `pauseActiveGoal(ctx)` → goal.status = "paused", stopReason = "user", autoContinue = false

/goal-sis 触发 drafting → agent 立刻 propose_goal_draft → goal 创建 → autoContinue 启动 → 12s 后 abort 触发 → pause。

最终: goal 在 disk 上是 paused 状态。autoContinue 应停（其值 false）。

## Prompts

ABORT_AFTER_MS: 20000
TURN: /goal-sis "Sisyphus: precisely 5 sequential steps, each requires `bash sleep 4` BEFORE the write. 1) sleep 4 + write a.txt='a'. 2) sleep 4 + write b.txt='b'. 3) sleep 4 + write c.txt='c'. 4) sleep 4 + write d.txt='d'. 5) sleep 4 + write e.txt='e'. autoContinue: true. The sleep is part of the done-when criterion; do not skip. If asked, propose this exact spec via propose_goal_draft immediately without further clarification."
