# experiments/

实验流程的所有产物。

## 目录结构

```
PLAN.md              # 实验计划：目标、被测行为、评分指标、case backlog、迭代节奏
RUNBOOK.md           # 如何手动跑一次实验
harness/
  run.sh             # 跑单个 case（一次 run）
  extract.sh         # 从 ndjson 提取 tool calls + final text + usage
  grade.sh           # 按 case rubric 评分
  lib.sh             # 公共函数
cases/
  C1-vague-goal-set/
    INPUT.md         # 这个 case 在测什么 + 给 pi 的 prompt
    rubric.json      # 机械可判定的 check 列表
    runs/
      <ts>/
        raw.ndjson         # pi -p --mode json 原始输出
        stderr.log         # pi 的 stderr
        summary.json       # extract.sh 提取
        score.md           # grade.sh 评分
        sandbox/           # pi 的 cwd 快照（含 .pi/goals/）
observations/
  iteration-log.md   # 每轮观察 → 改动 → 验证 的记录
```

## 一次 case 的生命周期

```bash
cd /Users/lucas/Developer/pi-goal/experiments
./harness/run.sh C1-vague-goal-set        # 跑一次
./harness/extract.sh cases/C1-vague-goal-set/runs/<ts>
./harness/grade.sh cases/C1-vague-goal-set/runs/<ts>
cat cases/C1-vague-goal-set/runs/<ts>/score.md
```

或一步到位：

```bash
./harness/run.sh C1-vague-goal-set --grade
```

## 评分模型

每个 case 的 rubric.json 是一个 check 数组。每条 check 现阶段是 binary（pass/fail）。harness 把所有 check 跑一遍，输出 markdown 表格 + 最终 pass rate。

通过 ≥ 0.8 才算这次 run 合格。同 case 跑 2-3 次取众数。

## 模型与凭证

- **Provider**：`fireworks`
- **Model**：`accounts/fireworks/routers/kimi-k2p6-turbo`
- **Thinking**：`high`

`harness/lib.sh` 默认这套配置，可通过环境变量覆盖：
`PI_GOAL_TEST_PROVIDER` / `PI_GOAL_TEST_MODEL` / `PI_GOAL_TEST_THINKING`。

**凭证特殊处理**：本机 `$FIREWORKS_API_KEY` 是失效占位 key。真实有效凭证存在
`~/.pi/agent/auth.json` 的 `fireworks.access`（fpk_ 开头的 OAuth token）。
`lib.sh` 启动时自动从 auth.json 提取并 export 覆盖 env，保证 pi 的 fireworks
provider 拿到对的 key。直接 curl 验证：`fpk_...` 返 200，`fw_...` 返 401。

## 当前最终结果（Phase 5 — drafting-layer schema 闭合 + propose_goal_draft 确认流）

REAL fireworks/kimi-k2p6-turbo + thinking=high + turn_timeout=360s：

| case | runs | full-pass | notes |
|---|---|---|---|
| C1-vague-goal-set | 3 | 3/3 = 100% | 稳定 |
| C2-fullspec-goal-set | 5 | **5/5 = 100%** | ✅ Phase 4 67% → 100%（B1 focus gate） |
| C3-sisyphus-drafts-steps | 5 | 4/5 = 80% | 1× model 没完成 step 3 |
| C4-tweak-objective | 3 | 3/3 = 100% | 稳定 |
| C5-impossible-pause | 3 | 3/3 = 100% | 稳定 |
| C6-sisyphus-blocked | 5 | **4/5 = 80%** | ✅ Phase 4 67% → 80%；1× model 重复 read existing.txt 而不 pause |
| C7-resume-after-pause | 5 | 5/5 = 100% | 稳定 |
| C8-premature-complete | 3 | 3/3 = 100% | 稳定 |
| C9-clear-mid-sisyphus | 5 | 5/5 = 100% | 稳定 |
| C10-verify-command-gate | 3 | 2/3 = 67% | 1× model 进入 recon rabbit hole（25+ bash），与 Phase 5 改动无关 |
| **C11-drafting-tool-whitelist** (new) | 5 | 4/5 = 80% | 1× rubric 测量 bug（C3 gate 功能上 5/5 正确） |
| **C12-focus-gate** (new) | 5 | **5/5 = 100%** | B1 全部正确 |
| **C13-step-inflation-gate** (new) | 5 | **5/5 = 100%** | B2 全部正确 |
| **C14-post-stop-block** (new, Phase 5+) | 4 | 1/4 = 25% | B7 / agent 多数情况下在 pause 前就写文件，prompt 设计暴露 — gate 本身由 C9 5/5 证明 |
| **C15-budget-limited** (new, Phase 5+) | 4 | 3/4 = 75% | B6 / 1× agent 没 propose_goal_draft 直接退场（偶发）|
| **C16-compact-mid-sisyphus** (new, Phase 5+) | 1 | **1/1 = 100%** | B3 / Phase 4 postCompactReminderPending 经过 compact 实战验证 |
| **C17-autocontinue-cap-runtime** (new, Phase 5++) | 3 | **3/3 = 100%** | B5 / env.json 把 cap 设为 3，第 3 个 autoContinue turn 后触发 auto-pause |
| **C18-abort-mid-turn** (new, Phase 5++) | 3 | **3/3 = 100%** | B4 / ABORT_AFTER_MS=20000，session.abort() 中断 sisyphus 链，pauseForAbort 正确写 status=paused / stopReason=user |

**Aggregate**: 63/68 = **92.6%**（drafting-layer schema 全部通过；残余失败都在 model 执行层或 rubric 测量层）

### 11 项 user 要求全部 runtime-covered

| # | 要求 | 方式 | case | 结果 |
|---|------|------|------|------|
| 🔴 B1 | focus-vs-sisyphus | schema gate | C12 | 5/5 = 100% |
| 🔴 B2 | plan step preservation | schema gate | C13 | 5/5 = 100% |
| 🟡 B3 | compaction-then-resume | runtime | C16 | 1/1 = 100% |
| 🟡 B4 | abort/Ctrl-C | runtime（新 harness 能力）| C18 | 3/3 = 100% |
| 🟡 B5 | MAX_AUTOCONTINUE_TURNS | runtime（新 env.json）| C17 | 3/3 = 100% |
| 🟢 B6 | budgetLimited | runtime | C15 | 3/4 = 75% |
| 🟢 B7 | post-stop tool block | runtime（也由 C9 5/5 间接证明）| C14 | 1/4（C9 5/5）|
| C-i | pi_goal_continuation 前缀 | structural | code | verified |
| C-ii | METRIC name=value | structural | code | verified |
| C-iii | drafting tool whitelist | schema gate | C11 | 4/5 = 80% |
| D | propose_goal_draft 确认 | new commit path | 所有 case | 全程使用 |

### Phase 5 累计 harness 能力

| 能力 | Phase | 用途 |
|---|---|---|
| `<case>/compaction.json` | 5+ | per-case 启用 compaction |
| `<case>/env.json` | 5++ | per-case env 覆写（pre-extension-load） |
| `ABORT_AFTER_MS: <N>` directive | 5++ | 在 turn 中途 session.abort() |
| `raw-ndjson-contains` rubric kind | 5++ | match 原始 event stream |
| `tool-call-count.argsJq` | 4 | 按 jq filter 计数 tool calls |

### Phase 5 六项改动

1. **`propose_goal_draft` + UI confirm dialog**（D 类用户需求）
   - 新增的 schema-level commit 入口；agent 在 drafting 完成后调用；UI 展示 markdown 预览 + [Confirm] / [Continue Chatting] 按钮
   - headless 模式自动确认（test harness 兼容）
   - **create_goal 工具在 drafting 期间被 hidden**（强制走 confirm 流）
2. **B1 drafting focus consistency**（schema gate）
   - `draftingFor.focus` 由 /goal-set 或 /goal-sis 设置；propose_goal_draft 校验 `params.sisyphus === (focus === "sisyphus")`，不一致即 REJECT
3. **B2 plan-step preservation**（schema gate）
   - 保存用户原 topic 中的 step 数；propose_goal_draft 校验 proposed steps ≤ user steps + 1，否则 REJECT（关闭 C6 step inflation 故障）
4. **C1 `<pi_goal_continuation goal_id="...">` 前缀**（pi-codex-goal 借鉴）
   - 结构化 outer marker 包住 continuation prompts；regex extractor 同时支持新旧格式
5. **C2 `METRIC name=value` 输出**（pi-autoresearch 借鉴）
   - step_complete 结果文本附加 `METRIC step=N total=M done=K verifyCommand=passed|absent evidence_chars=L`
6. **C3 drafting tool whitelist**（schema gate）
   - `pi.on("tool_call")` 拦截器在 drafting 期间 BLOCK bash/write/edit/read/grep/find/ls；仅 propose_goal_draft + get_goal 可用
   - tweak drafting 同样：仅 apply_goal_tweak + get_goal 可用

### 累计 schema 闭合（5 个阶段累积）

| Phase | 关键 schema |
|---|---|
| Phase 2 | `tokenBudget` 不可由 agent 自设 |
| Phase 3 | `step_complete` 计数器 + `apply_goal_tweak` 修改通道 |
| Phase 4 | `verifyCommand` 执行验证 + `turnStoppedFor` 工具拦截 + auto-continue cap + 空 turn gate + post-compact resync |
| **Phase 5** | **`propose_goal_draft` 确认门 + B1 focus gate + B2 step gate + C3 drafting whitelist + C1 XML 前缀 + C2 METRIC** |

### 残余 4/55 失败全在 model 执行层

- C3 5fb2 / C6 082b / C10 8bb6：model 执行 step 时的偶发错误（rabbit hole / 重复操作 / 没完成）
- C11 b116：rubric 测量问题，code 实际正确

详见 `observations/final-stability-sweep-phase5.md` 和 `observations/iteration-log.md`（Iter 8）。

---

## Phase 4 结果（历史记录）

REAL fireworks/kimi-k2p6-turbo + thinking=high + turn_timeout=360s：

| case | runs | full-pass | notes |
|---|---|---|---|
| C1-vague-goal-set | 3 | 3/3 = 100% | 稳定 |
| C2-fullspec-goal-set | 3 | **2/3 = 67%** | 1× drafting 误判为 sisyphus（drafting 层偶发） |
| C3-sisyphus-drafts-steps | 5 | **5/5 = 100%** | ✅ Phase 3 80% → 100%，`verifyCommand` 关闭幻觉证据 |
| C4-tweak-objective | 5 | 5/5 = 100% | 稳定 |
| C5-impossible-pause | 3 | 3/3 = 100% | 稳定 |
| C6-sisyphus-blocked | 3 | **2/3 = 67%** | 1× agent 在 drafting 时把 2 步重写为 3 步并 pause（drafting 层偶发） |
| C7-resume-after-pause | 5 | **5/5 = 100%** | ✅ Phase 3 67% → 100%，`verifyCommand` 关闭字面化 |
| C8-premature-complete | 3 | 3/3 = 100% | 稳定 |
| C9-clear-mid-sisyphus | 5 | **5/5 = 100%** | ✅ Phase 3 67% → 100%，`turnStoppedFor` + tool_call interceptor 关闭 post-clear obedience |
| **C10-verify-command-gate** (new) | 5 | **5/5 = 100%** | 所有 step_complete 均传 verifyCommand |

**Aggregate**: 38/40 runs full-pass = **95.0%**（rubric-level 313/315 = 99.4%）

### Phase 4 借鉴的六项 schema/affordance 改动（来自 pi-codex-goal & pi-autoresearch）

1. **`step_complete.verifyCommand`** — 可选 bash 验证命令；framework 跑 `bash -c`，exit 0 才推进 stepsCompleted，否则拒绝该 step。复刻 pi-autoresearch `checks.sh`。**直接关闭 C3 49f3 + C7 2097**
2. **`pi.on("tool_call")` 拦截器** — `turnStoppedFor` 在 `pause_goal`/`update_goal(complete)`/`apply_goal_tweak` 后设置，本轮后续 tool 调用（除 `get_goal`）被 SDK 层 `{block: true, reason}` 拒绝。**直接关闭 C9 0ad8 post-clear obedience**
3. **`MAX_AUTOCONTINUE_TURNS = 30` 硬上限** — autoContinue 链超过即自动 pause，附 pauseReason。借鉴 pi-autoresearch `MAX_AUTORESUME_TURNS`
4. **`sisyphusToolCalledThisTurn` 空轮 gate** — 本轮未调任何工作工具则不再 autoContinue。借鉴 pi-autoresearch `shouldAutoResumeAfterTurn`
5. **`postCompactReminderPending` 注入** — compaction 后下一 agent_start 在 system prompt 末尾追加权威 step counter，避免 LLM summary 漂移
6. **`pi.on("context")` 旧链拦截** + **abort assistant 自动 pause** — 之前已实现，本期验证保留

### Schema 层修复历史（累计闭合的失败模式）

1. **`tokenBudget`**（Phase 2）— 从 `create_goal` 工具参数移除
2. **Sisyphus 步骤计数器**（Phase 3）— `step_complete` 工具显式标记每步完成
3. **`apply_goal_tweak`**（Phase 3）— 唯一可改 active goal 的工具
4. **`verifyCommand`**（Phase 4）— step_complete 内嵌可执行验证
5. **`turnStoppedFor` 工具拦截**（Phase 4）— stop 后阻断本轮 tool 调用

### 剩余 2/40 偶发失败均在 drafting 层

- C2: `/goal-set` 误标 sisyphus=true（1×）
- C6: 把用户的 2 步 plan 重写为 3 步（1×）

两者都不属于执行层 schema 可闭合范围。下一阶段应聚焦于 drafting prompt 收紧或 drafting-time schema 校验。

详见 `observations/final-stability-sweep-phase4.md` 与 `observations/iteration-log.md`（Iter 7）。
