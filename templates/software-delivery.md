---
id: software-delivery
name: 软件交付
task_types: [software-change, bugfix]
entry: plan
version: 1
stages:
  plan: { role: planner, deliverable: 方案与逐 Issue 验收清单, pass_when: 目标方案与验收条件具备, next: code, rework: [plan] }
  code: { role: developer, deliverable: 代码提交与必要自检, pass_when: 实现完成具备 Preview 条件, next: ready_preview, rework: [plan, code] }
  ready_preview: { role: preview, deliverable: 批次环境与验收入口, pass_when: 已集成且环境可用, next: preview, rework: [code] }
  preview: { role: preview, deliverable: 用户逐 Issue 验收记录, pass_when: 用户确认对应验收项通过, next: accepted, rework: [plan, code] }
  accepted: { role: reviewer, deliverable: 验收结论与待验证代码范围, pass_when: 验收记录齐备, next: verifying, rework: [preview] }
  verifying: { role: reviewer, deliverable: CI 与 Code Review 结论, pass_when: 两项针对拟交付代码通过, next: ready_merge, rework: [code] }
  ready_merge: { role: task-supervisor, deliverable: 可合入代码与完整记录, terminal: true }
---
## 工作指导
每个 Issue 独立 Plan、独立 Code、独立 worktree；多个 Issue 可进入一个本地 Preview 批次。
Preview Agent 使用默认 Workspace 进行真实 Git 集成、启动 Dev 环境、提供用户可访问入口。
逐 Issue 用户验收后执行正式 CI 与 Code Review，证据必须针对当前待交付代码。ready_merge 只表示待合入，不是已合入。
冲突、依赖、部分通过、返工、加入与移出批次、代码变化影响和重新验收范围由 Preview Agent 协调，不增加冻结审批。
