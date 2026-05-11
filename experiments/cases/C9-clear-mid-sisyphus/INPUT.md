# C9-clear-mid-sisyphus
# 测：sisyphus goal 执行中用户 /goal-clear，agent 应停止，无 active goal 残留。
TURN: /goal-sis "Step 1: create a.txt with 'a'. Step 2: append content of missing.txt to a.txt. missing.txt will be provided later by the user. For step 1 step_complete, pass verifyCommand `test -f a.txt && [ \"$(cat a.txt)\" = a ]`. After clear, do not try to recover or create missing files yourself."
TURN: 
TURN: /goal-clear
