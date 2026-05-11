# C16 — compaction-then-resume mid sisyphus (B3)

## 被测行为

5-step sisyphus 跑过程中触发自动 compaction（compaction.json 启用 threshold=4000）。验证 Phase 4 加的 `postCompactReminderPending` 机制：
- compaction 后 next agent_start 注入「POST-COMPACTION RESYNC」block，告知权威 step counter
- agent 继续完成剩余 steps（不会因 compaction summary 漂移而失败）
- 最终所有 5 个 step 完成 + update_goal=complete

## Prompts

TURN: /goal-sis "Sisyphus 5 steps: 1) create f1.txt with 'one'. 2) create f2.txt with 'two'. 3) create f3.txt with 'three'. 4) create f4.txt with 'four'. 5) create f5.txt with 'five'. Each step_complete pass verifyCommand like test -f f1.txt && [ \"$(cat f1.txt)\" = one ]. autoContinue: true."
