---
name: interview
description: "Interview the user only for real gaps, then turn the request into executable Company Issues. 先查事实和现有约定，只在缺少用户独有信息时集中澄清，收敛后直接创建并派单。"
---

# Interview

Use this skill when a user request is not yet executable. The goal is executable, verifiable Company Issues, not a plan document and not a questionnaire.

## Trigger

A request is already executable when it has a deliverable, a scope boundary, observable acceptance criteria and an owner. If those are clear, skip this skill and create the Issue directly.

Use this skill only for real gaps that remain after checking facts. Do not run a fixed interview loop for every request, and do not ask the user to confirm a plan that is already executable.

## Resolve gaps from facts first

Before asking the user, check what you can verify yourself:

- `company_org.organization` for the company goal, nodes, active leads, members and responsibilities.
- `company_tasks.searchIssues` for existing Issues on the same subject; cite IDs instead of duplicating.
- The company knowledgebase and existing Issue bodies/comments for established conventions.
- Colleagues who own the relevant area, and the target node's active `leadPersonId` (then the nearest active ancestor lead, then HR or a superior) for ownership. Skip archived members and yourself.

Reuse established conventions and make reversible defaults instead of asking. A colleague's answer or a repository convention is enough; the user is not the default source for ordinary technical choices.

## Ask only what the user uniquely owns

Ask the user only for information that facts cannot supply: their intent or priority, a commitment the company is not yet authorized to make, or an acceptance criterion they explicitly reserve.

- Ask one self-contained question at a time, in Chinese.
- Reuse the same unresolved question instead of asking it again; do not bundle unrelated choices.
- When options are enumerable, provide 2–6 concrete, mutually exclusive single-line options and mark the recommended one with "（推荐）" first, with the reason in its description.
- Do not ask for facts you can verify, and do not ask the user to pick every executor.

## Converge and dispatch

Once every planned Issue has a deliverable, scope boundary, observable acceptance and an owner, create and dispatch it immediately with `company_tasks.createIssue` (use `assigneeAgentId`, and `type`/`pipeline` when known). Do not stop at a plan, do not enter plan mode, and do not wait for a separate approval step. 访谈收敛后直接创建并派单；不要进入 plan mode，也不要等待另行审批。

- Record unresolved points and assumptions in the Issue body instead of blocking.
- If the user says "just do it" or asks you to stop asking, create the Issues with the information you have, fill the minimum acceptance criteria, and tell the user what remains open.
- Keep independent deliverables as separate flat Issues that reference each other; do not build a sub-Issue tree.
- Only the user accepts the result. Creating and dispatching an Issue is not acceptance.

## Rules

- All user-facing text (question, header, label, description) MUST be in Chinese.
- Use the runtime's AskUserQuestion interaction when a structured card is available; otherwise ask in Chat. At most one question per turn unless the runtime presents a card.
- This skill grants no permissions and never overrides the Company system prompt, the managed protocol or role checks.
