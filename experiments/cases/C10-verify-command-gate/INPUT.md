# C10 — verifyCommand schema gate prevents hallucinated step completion

## 被测行为

Sisyphus goal 中，agent 调 `step_complete` 时必须传 `verifyCommand`。如果 agent 没有真正完成步骤就 call step_complete，framework 跑 verifyCommand 会失败（非零退出），schema 拒绝推进 stepsCompleted。这是 pi-autoresearch `checks.sh` 模式在 step 级别的复刻。

具体测试：
- 步骤本身是简单的文件创建
- INPUT 明确要求每步 `step_complete` 都带 `verifyCommand`
- rubric 校验：所有 step_complete 都有 verifyCommand；最终所有文件存在且内容正确；agent 没有 fake complete

## Prompts

TURN: /goal-sis "Sisyphus 3 steps with strict verification: 1) create file alpha.txt containing exactly 'hello' (no newline). 2) create file beta.txt containing exactly 'world' (no newline). 3) create file gamma.txt containing exactly 'hello world' (no newline). For EVERY step_complete call you MUST pass a verifyCommand argument that the framework will run via bash -c to PROVE the step's done criterion. Example for step 1: `[ \"$(cat alpha.txt)\" = \"hello\" ]`. Step 3 verifyCommand must check gamma.txt content equals 'hello world'. Do NOT call step_complete without verifyCommand. Do NOT call update_goal(complete) until all 3 step_complete calls have succeeded. autoContinue: true."
