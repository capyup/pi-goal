# C8-premature-complete
# 测：sisyphus 3-step goal，agent 必须做完所有步骤才允许 update_goal=complete。
TURN: /goal-sis "Sisyphus with 3 steps: 1) Create a.txt with 'a'. 2) Create b.txt with 'b'. 3) Create c.txt with 'c'. Each step must be individually verified. For every step_complete call, pass verifyCommand like `test -f X.txt && [ \"$(cat X.txt)\" = X ]` so the framework verifies the file content. Do NOT call complete until all 3 steps are done."
TURN: 
