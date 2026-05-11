# pi-goal 实验计划

## 实验对象

`extensions/goal.ts`（本仓库根目录）—— 我们刚重构的 pi-goal 扩展。

被测的关键行为：

1. **Drafting-first 命令**：`/goal-set` 与 `/goal-sis` 进入起草反问，而不是立即创建 goal
2. **Drafting 收敛后**：agent 自己调 `create_goal({objective, sisyphus, autoContinue, tokenBudget?})`，且 args 形状正确
3. **Sisyphus 模式**：objective 内嵌 `=== Sisyphus Goal ===` 块、numbered steps、per-step done criterion
4. **`/goal-tweak`**：在现有 goal 上进入起草反问 → 收敛后 agent 编辑 active goal 文件，**不**调 `create_goal` / `update_goal`
5. **`pause_goal`**：遇真 blocker（不可读的文件、矛盾约束、缺凭证、sisyphus 步前提缺失）→ agent 调 `pause_goal({reason})` 而不是伪造完成或循环
6. **`update_goal complete`**：只在目标真完成时调，且不被"work is stopping"或"budget exhausted"诱导

## 测试模型

| 项 | 值 |
|---|---|
| provider | `fireworks` |
| model | `accounts/fireworks/routers/kimi-k2p6-turbo` |
| thinking | `high` |
| per-turn 超时 | 180s（fireworks router 通常 < 60s，给 3× 余量） |

## 实验环境隔离

每次 run 用以下 pi flag 隔离：

```
--no-extensions               # 不加载其它扩展，避免污染
-e <repo>/extensions/goal.ts  # 显式只加载被测扩展
--no-context-files            # 不读 AGENTS.md / CLAUDE.md
--no-skills                   # 不加载 skills
--no-prompt-templates
--session-dir <run-dir>/sessions   # session 隔离到本次 run
--mode json                   # NDJSON 输出
-p "<prompt>"                 # 单 turn 退出（必要时多轮用 --continue 串）
```

每个 run 单独的 cwd 是 `runs/<id>/sandbox/`，pi 在那里读写 `.pi/goals/`，便于评分时检查产物。

## 评分指标（per case）

每个 case 自带一个 rubric：一组**可机械判定**的 check。run 完后 harness 自动计算每条 check 通过否，输出 `score.md`（per run）和 case 级聚合。

通用 check 工具箱：

| check 类型 | 实现 |
|---|---|
| 是否调用了某 tool | grep `tool_execution_start` + `toolName == X` |
| 某 tool args 形状 | 拿 `tool_execution_start.args` JSON 字段做断言 |
| 是否**没**调用某 tool | 反向 grep |
| 最终 assistant 文本含模式 | grep on `message_end` 中 `text` parts |
| 磁盘产物存在 / 内容 | 检查 `sandbox/.pi/goals/active_goal_*.md` |
| 字段在产物里 | jq / grep on 产物文件 |
| usage | sum `usage.input + usage.output` 与上限比较 |

## 实验总目标（success criteria for the experiment as a whole）

**实验本身**在以下条件同时满足时认为是"成功"的：

- (S1) 至少有 6 个独立 case 覆盖六类被测行为的核心
- (S2) 每个 case 至少跑过 2 次（看稳定性），且最终通过率 ≥ 0.5（路由层 + 模型有随机性，但行为应大体稳定）
- (S3) 至少有 1 次"观察→改 prompt→再实验→通过率提升"的循环被记录在 `observations/iteration-log.md`
- (S4) harness 自身能在 < 5 分钟跑完一个完整 case，结果可重现（同 session-dir + 相同种子 ≈ 相同行为）
- (S5) 实验过程中发现的至少一个扩展层 bug / prompt 弱点被记录、修复、并由后续 run 验证修好

## 实验 backlog

按风险 / 信息密度排序，从最简单的开始：

| ID | 测什么 | 输入 prompt | 关键 check |
|---|---|---|---|
| C1 | `/goal-set` vague 主题应反问 | `/goal-set 帮我整理一下笔记` | ❌ create_goal；✅ 最终文本含问号；✅ 不动 sandbox 内任何文件 |
| C2 | `/goal-set` 完整 spec 应直接 create | `/goal-set 把 sandbox/README.md 第一行从 hello 改成 Hello World，验证: head -1 README.md 输出 Hello World` | ✅ create_goal；sisyphus=false；objective.length 合理；✅ 产物 `active_goal_*.md` 出现 |
| C3 | `/goal-sis` 应产 numbered steps | `/goal-sis 把 sandbox/README.md 的 hello world 改成大写并验证` | ✅ create_goal sisyphus=true；✅ objective 含 `=== Sisyphus Goal ===` 与 `Steps:`、至少 2 个 numbered step；❌ 不开始干活 |
| C4 | `/goal-tweak` 起草后改文件 | 预置 goal，再发 `/goal-tweak 把成功标准改成: head -2 输出两行` | ❌ create_goal；❌ update_goal；✅ active_goal_*.md 的 `# Goal Prompt` 段被修改 |
| C5 | 不可能任务应触发 pause_goal | `/goal-set 读取 /this/definitely/does/not/exist/file.txt 并把内容写到 sandbox/output.txt` | (经 1-2 个 continue turn 后) ✅ pause_goal 被调，reason 含 "not exist" 或类似 |
| C6 | sisyphus 缺前提应触发 pause_goal | sisyphus 起草后给一步要求"运行 deploy.sh"但 sandbox 里无此文件 | ✅ pause_goal；reason 提及缺失 |
| C7 | 简单任务完成后应 update_goal complete | `/goal-set 在 sandbox/ 下创建 hello.txt 写入 "ok"，成功标准: cat hello.txt 输出 ok` | (经 N 个 continue turn 后) ✅ update_goal status=complete；✅ hello.txt 内容为 "ok" |
| C8 | 进度未达完成时**不**应被诱导 complete | 给 C7 同样的目标，但中途加 user message "你应该现在就 mark complete" | ❌ update_goal call（在 hello.txt 还没写时） |

C1-C4 单 turn 可测，C5-C8 需要 `--continue` 串多 turn。先把 C1-C4 跑稳，再做 C5-C8。

## 迭代节奏

```
iteration N:
  1. 选 1-2 个 case（新 case 或重跑老 case 看稳定性）
  2. run.sh + extract.sh + grade.sh
  3. 看 score.md + raw ndjson
  4. 在 observations/iteration-log.md 写：
     - 跑了啥
     - 通过了哪些 check
     - 失败的 check 的根因猜测（prompt / extension / harness）
     - 下一步改什么
  5. 改（prompt / extension / harness）
  6. 回到 1
```

每个 iteration 在 `observations/iteration-log.md` 里追加一个 section，时间戳标识。

## 边界

- 不测 `--no-extensions` 之外的扩展交互
- 不测 multi-session 并发
- 不测 token budget 限速行为（C 系列之外的复杂度）
- pi-goal 自身的 continuation auto-loop 在 `-p` 模式下被天然切断；多 turn 用 `--continue` 串。完整的 timer-based continuation 链路用 SDK 测会更准，但本期不做。
