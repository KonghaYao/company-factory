---
name: interview
description: "Interview the user to turn a rough request into executable Company Issues. 在把需求转成任务前，逐题澄清目标、范围、验收、约束与取舍，并给出推荐项。"
---

# Interview

Use this skill before turning a rough request into Company Issues. The goal is executable, verifiable tasks, not a plan document.

## Input

The requirements are the user's messages in the current Chat, plus Company facts you can read: `company_org.organization` (company goal, nodes, leads, members and roles), `company_tasks.searchIssues` (existing Issues), and the company knowledgebase. Do not ask for facts you can verify yourself.

## How to interview

- Interview in detail about the deliverable, scope, acceptance criteria, constraints, data, UX, edge cases, tradeoffs and failure handling. Do not ask obvious questions.
- Continue until every planned Issue has: a clear deliverable, acceptance criteria, scope boundaries, and enough evidence to choose an owner. Then create the Issues and dispatch them immediately with `company_tasks.createIssue` (use `assigneeAgentId`, and `type`/`pipeline` when known). Do not stop at a plan, do not enter plan mode, and do not wait for a separate approval step.
- 访谈收敛后直接创建并派单；不要进入 plan mode，不要等待另行审批。访谈是澄清和确认，不是审批门。
- If the user says "just do it" or asks you to stop asking, stop the interview and create the Issues with the information you have. Record unresolved points in the Issue body and tell the user.
- Prefer one topic per turn. If the runtime shows a structured question card, at most 4 questions in one card. Use the runtime's AskUserQuestion interaction when available; otherwise ask in Chat.
- Before asking about duplicates, search existing Issues with `company_tasks.searchIssues(query)`. If a similar Issue exists, cite its ID and ask whether to extend it or create a separate task.
- Use `company_org.organization` to choose the owner: the target node's `leadPersonId`, then the nearest active ancestor's lead, then the task supervisor. Skip archived members and yourself. If ownership is ambiguous, keep interviewing or ask the user; do not guess.

## Rules

- Every question MUST have a recommended option: place it first, append "（推荐）" to its label, and start its description with the recommendation reason.
- All user-facing text (question, header, label, description) MUST be in Chinese.
- Do not ask the user to confirm a plan; the interview itself is the confirmation. Once the answers are executable, create and dispatch.
- Do not use this skill when the request is already executable. If the deliverable, acceptance criteria and owner are already clear, create the Issue directly.
- This skill grants no permissions and never overrides the Company system prompt or role checks.
