# Interface contracts and normal concurrency

Company is a local, single-owner application. Agent identity is **never** supplied by model parameters. The HTTP edge validates each Agent's private bearer credential and constructs `{type: 'agent', id, companyId}`. UI mutations require a same-origin, HttpOnly, SameSite=Strict local-owner session. Company/team target identifiers are separate from callers. No CORS, no cross-site mutations, no DNS-rebinding hosts.

Three custom protocol endpoints only: `/company_org/mcp`, `/company_tasks/mcp`, `/company_im/mcp`. They use `@peri-code/mcpp`'s current mono gateway and MCP 2026-07-28 transport; no hand-rolled JSON-RPC success responses. Resources are authenticated views (`company://current/<module>`), with native `subscriptions/listen` invalidations. Runtime and default Workspace are internal adapters, not more Company MCPs.

## Services

- **OrganizationService**: company creation scaffolds Company Git repository, HQ, HR and supervisor, then creates actual Peri Sessions via injected runtime provisioning. People are flat identities; `organization.yaml` owns the node tree and placements, while `roster.yaml` is a v2 index of `{agentId,status,joinedAt}`. `organization()`/`members()` derive `groupId`/`orgPath` from placements. Public snapshots redact authentication credentials. HR or the user may create tree nodes, move members, archive/restore members, and archive/delete nodes. A move writes only `organization.yaml`; a legacy company without it is projected in memory and upgraded to `organization.yaml` + roster v2 on the first organization write. Archiving keeps the Agent directory, fixed Session, token file, IM and Issues but rejects further authentication.
- **IssueService**: user and roles with `issue.create` may create; new Issue has `triage` and supervisor ownership. Current owner edits business content/status; supervisor classifies and assigns. Versions and stable request IDs protect normal concurrent writes. Comments have server author/time; only the author edits.
- **DecisionService**: stable explicit Issue/question IDs; owner asks or withdraws, user answers, owner processes answer. `needs_user` derives from remaining pending questions. Late answers are historical only.
- **PreviewService**: independent Issues share a recorded preview environment. User acceptance and CI/Review each bind to exact code. Ready-to-merge requires both successful validation kinds for currently accepted code, never a runtime completion signal.
- **CompanyIM**: same-company participants; durable message precedes asynchronous delivery into the original target Session. `saved` is durable only, `delivered` is prompt admission into the target Session (not consumption or reply); admission covers the runtime's 750 ms acceptance window, so a failure observed after it can still surface as a chat `promptFailure` while the message stays `delivered`. `failed` is confirmed not sent (`not_sent`/`rejected`, safe to retry), and `unknown` is an attempted delivery whose outcome cannot be confirmed (never auto-resent). Repeated request IDs deduplicate, closed threads retain late replies without reopening. Agent callers may read only their own inbox; a cross-Agent `agentId` is `forbidden` and `thread(threadId)` is the participant-scoped read. Owner callers may query a specified Agent's inbox.
- **AgentRuntimePort / SessionStorePort**: only SDK handles and official transport lifecycle. Effective config persists independently of saved config. User restart applies saved config while keeping identity, directory and Session. No custom runtime or recovery coordinator.
- **WorkspaceViewAdapter**: maps supported UI reads/writes/search/Git operations to the official default Workspace tools. It rejects root escapes and Company business-data writes. File save compares a content version and reports conflicts rather than overwriting external edits.
- **PeriChatViewAdapter**: scoped real SDK Session/turn/activity history. Send acceptance is an input receipt only; the UI never equates it with Issue acceptance.
- **AgentWorkNotices**: committed Issue creation, assignment metadata and explicit decision answers can notify the target's fixed Session. The notification contains stable IDs and fact references, not a plan or stage command. An Agent's own operation does not echo back into its Session. Owner inspection and known-failure retry are separate from business mutation.
- **AgentContextView**: authenticated Agent MCP reads return bounded summaries and discovery indexes; the Agent chooses which full Issues, Previews and message threads to inspect. Owner workspace reads retain their existing full data contract.

## Agent definition, model profiles and trust boundary

- **`updateMember`** is user-only and edits only `name`, `responsibilities` and the Agent-specific `systemPrompt`. Agent ID and access role are immutable; department is no longer stored on the person. It does not require a restart; it rewrites only the host-managed block in `CLAUDE.md`, using applied runtime instructions and preserving free memory. Unsafe links, non-regular files, oversized memory, invalid UTF-8 or invalid managed markers reject before member facts change. An existing fixed Session keeps its frozen system prompt; the new definition is not injected into each message.
- **`moveMember`** is user/HR-only and versioned against the organization document. It changes one placement (`nodeId`, optional display `title`/`order`) and records `previousNodeId`/`movedAt`/`movedBy`. It never writes `agent.yaml`, `CLAUDE.md`, `.mcp.json`, Agent Git, the fixed Session, binding, effective config, Workspace or IM/Issue ownership. Except for the one-time legacy upgrade, it does not write the roster; a legacy Company without `organization.yaml` is upgraded to `organization.yaml` + roster v2 on the first move. Before writing, it snapshots these facts; after writing it re-reads them and restores the original organization bytes with `integrity_violation` on any mismatch. Errors: `node_not_found`, `node_archived`, `member_not_found`, `member_archived`, `version_conflict`, `integrity_violation`, `forbidden`.
- **Tree and lifecycle** operations (`createOrgNode`, `updateOrgNode`, `deleteOrgNode`, `archiveOrgNode`, `archiveMember`, `restoreMember`) validate parent existence, self/cycle reparenting, sibling `order` uniqueness and max depth 16. `deleteOrgNode` rejects a non-empty node with `org_node_not_empty` unless an explicit `reassignTo` moves every placement in the subtree first. `archiveOrgNode` rejects with `org_node_not_empty` while any active descendant node or any placement remains anywhere in its subtree. `restoreMember` only accepts an archived member; a member that is already active must use `moveMember`. Archived members are rejected with `member_archived` as Issue assignees, collaborators and new IM recipients, while `members()` keeps them for organization/history display. Archiving a member removes its placement and its node lead flags and rejects later authentication but keeps its directory, Session, token file, IM and Issues; restoring without `nodeId` creates an active, unassigned member that the UI shows and can move.
- **Permission assumption (pending product confirmation)**: the user explicitly authorized `moveMember` for user+HR. The current tree/lifecycle operations (`createOrgNode`, `updateOrgNode`, `deleteOrgNode`, `archiveOrgNode`, `archiveMember`, `restoreMember`) also use the same user+HR check. This is deliberately unchanged in this phase; tighten delete/archive/restore to user-only if the product decision requires it.
- **`saveAgentConfiguration`** is user-only and versioned. It validates `modelProfile` (model-library profile id, `""` inherits the library default), `modelAlias` (one of `fable`/`opus`/`sonnet`/`haiku`) and `workspaceRoots`. Retired fields (`model`, `models`, `provider`, `baseUrl`, `apiKeyEnv`) are rejected with `invalid_input` and a hint to use `modelProfile`. Saving never mutates the effective snapshot; `markAgentConfigurationApplied` runs only after an explicit successful restart. HR may set `modelProfile` and `modelAlias` for a new member, but never provider, endpoint/credential selectors, `workspaceRoots`, MCP or `settings`.
- **Model resolution** is profile → provider → model. The library `activeProfile` is used unless `config.modelProfile` selects another profile; an explicit missing/disabled profile never falls back. The active tier is `config.modelAlias ?? profile.activeAlias ?? "sonnet"`. Bound tiers resolve their own `model`/`modelEnv`; an unavailable bound model does not silently fall back, and unbound tiers fall back to the active tier, then `sonnet`, then another bound tier. PeriConfig carries `active_alias` and per-tier `profiles` entries with `{provider, model}`. The library schema is v2: id-keyed `providers`/`profiles`, per-profile `tiers`, no top-level `models` or `bindings`; v1 input is rejected with `library_version_unsupported`.
- **Frozen boundary**: resolved provider settings (provider/baseUrl/apiKey/models) and MCP descriptors are written to host-only `runtime/effective-config/<agent>.json` (0600) only at provision or explicit restart; ordinary cold wake reuses that snapshot. Provider, base URL, API key and tier model environment values come only from the trusted host process environment (referenced by name from the host-owned `model-library.yaml`), never from the Agent-writable `<agent>/.env`, which is mounted read-only. `config.settings` is reserved and never spread into PeriConfig. Snapshots expose only `modelProfile`, `modelProvider`, `modelAlias`, the active model ID, `modelMissing`, `modelError`, `modelSource` and `modelLibraryRevision`, never apiKey/baseUrl; v2 snapshots also expose `modelTiers`, `modelTierProviders`, `modelTierSources` and `modelResolvedAt`, or `modelTierNotice` when an older snapshot must be restarted to show tier detail.
- **Read-only model library projection**: `GET /api/model-library` returns `status/error/issues/path/version/activeProfile/revision/profiles[]/providers[]`. Each profile expands to all four tiers (`bound/provider/providerType/model/modelEnv/missing/ready`) and each provider exposes `baseUrlEnv/apiKeyEnv` names plus `endpointConfigured/credentialConfigured`; there are no top-level `models`/`bindings` and no endpoint or credential values. The UI consumes it from a header “模型库” sheet and a per-Agent “模型” tab. The Agent configuration profile/alias picker only edits the JSON draft; save and restart keep the existing CAS semantics. No PUT/write-back exists, and a revision mismatch is shown as “restart required” rather than auto-applied.

## Mutation/error/event rules

Normal domain operations are serialized within Company write boundaries. YAML frontmatter is edited through the YAML Document API and changed fields are merged with the current document; stale `expectedVersion` rejects before commit. Request IDs belong to caller+Company+operation and retain the input digest. A prepared result is complete only when its exact request record appears in Company Git HEAD. An identical retry completes a failed commit without repeating the business mutation, then republishes resource invalidation; a different input conflicts. This does not promise a cross-file crash transaction or replay arbitrary partial business writes. Company initialization can repair a missing roster entry using the original verified Agent credential and Session, with no replacement Session.

Preview updates validate ownership of every affected Issue, including removed members, before writing. An Agent must explicitly revise an Issue whose current acceptance/verification still uses that Preview before removing it; the host does not choose a rollback workflow.

## Task todos and append-only progress

An Issue owns one ordered todo list (`Issue.todos`, at most 50) and one append-only progress log (`updates/<issueId>/<issueId>-U<n>.md`). `Issue.latest_update` is only a list/summary projection; the immutable update files are authoritative. Old Issues without either field read as `todos: []` and `latest_update: null`; malformed stored todos or unknown update schemas fail with `invalid_document` (500). `todo_seq` is an optional internal high-water mark so deleted todo IDs are never reused. `updateIssue.patch` rejects both `todos` and `latest_update`; only the dedicated operations below may write them.

`updateTodos` (`POST /api/action` with `{companyId, module:"company_tasks", operation:"updateTodos", input}` or MCP tool `company_tasks/updateTodos`):

```ts
{
  issueId: string;
  expectedVersion: number; // dispatch aliases this to the Issue version
  requestId: string;
  changes?: Array<
    | { op: "add"; text: string; status?: "pending" | "in_progress" | "done" }
    | { op: "update"; todoId: string; text?: string; status?: "pending" | "in_progress" | "done" }
    | { op: "remove"; todoId: string }
  >; // 1..20 when present
  order?: string[]; // complete permutation of the post-change todo IDs, 1..50
  note?: string; // 1..2000; required for Agent callers
  kind?: "progress" | "blocker" | "decision"; // default progress
}
// -> { issue: Issue; update: TaskUpdate | null }
```

At least one of `changes` or `order` must be nonempty. Server-generated IDs use `<issueId>-T<n>`; array order is display order. Agent writes without `note` return `invalid_input`. A note creates one immutable `TaskUpdate` with the post-change `status` and `todo_counts` snapshot inside the same Company lock and Git commit. The list is capped at 50 (`todo_limit`, 400); text is one line of at most 500 characters; a 21st change is `invalid_input`. Canceled Issues return `terminal_issue` (409).

`addUpdate`:

```ts
{
  issueId: string;
  expectedVersion: number;
  requestId: string;
  kind?: "progress" | "blocker" | "decision"; // default progress
  body: string; // Markdown, 1..4000
}
// -> { issue: Issue; update: TaskUpdate }
```

`addUpdate` only appends (never edits/deletes), increments the Issue version, and refreshes `latest_update`; it never changes status, todos or decisions. It is allowed on canceled Issues. More than 2000 records returns `update_limit` (409). The record shape is `{schema:"company-update/v1", id, issue_id, author_type, author_id, kind, created_at, version:1, status, todo_counts:{total,done,in_progress}, body}`. The 2000-record/file and Issue projection write is not a crash transaction: a failed Issue write can leave an authoritative log entry with a stale projection, corrected by the next append or repair script. No cross-process lock is claimed.

`updates` is read-only and returns `{items: TaskUpdate[]; nextCursor: string | null}` newest first. `limit` defaults to 20 and accepts 1–50; `cursor` is a non-negative offset string and `nextCursor` is the next offset when more rows remain. Invalid cursor/limit is `invalid_input` (400). Reads require the same participant/archived-member rules as `getIssue`; writes require the owner user or current owner Agent (`not_current_owner`, 403). Missing Issues are `not_found` (404), stale versions `version_conflict` (409), and replaying a request ID with different input is `idempotency_conflict` (409). Exact replays return the original result without adding another todo or update. Owner `getIssue` via `/api/action` returns the full normalized todos and latest projection; Agent `listIssues`/`workspace` summaries include only `todos:{total,done,in_progress}` and a short `latest_update` excerpt, never full todo text or update bodies.

## Agent reads and notification receipts

Agent `listIssues` defaults to current ownership/collaboration and excludes `cancel`/`ready_merge`. `includeHistory: true` includes former participation and terminal states; `status` explicitly filters stages. Pages default to 20 items, accept `limit` 1–50 and return `nextCursor`; summaries are clipped with `getIssue(issueId)` pointers. Agent `workspace` adds the current profile reference plus bounded thread/Preview indexes. Its complete response and each Issue page fit 32 KiB. Identity always comes from the bearer credential; an empty or different `agentId` cannot widen scope. Full detail remains available through `getIssue`, `getPreview`, `thread` and normal Workspace file reads.

Workspace cursors are independent: `cursor`/`nextCursor` for Issues, `threadCursor`/`nextThreadCursor` for threads, and `previewCursor`/`nextPreviewCursor` for Previews. `limit` applies to each index; `includeHistory`/`status` filter Issues only. Threads include both asking and receiving participation; historical Previews remain limited to the existing visibility rules. Pagination changes no task or collaboration state.

Mutation responses may contain `notification` (`answerDecision` also retains the `delivery` alias). States are `saved`, `accepted`, `failed`, `unknown`, `skipped`; accepted means admission only. A process interruption after possible admission is unknown and never automatically resent. Owner workspace exposes the latest 20 notices, and `/api/agents/:agentId/notices` plus `/:noticeId` provide authenticated inspection. `POST /api/agents/:agentId/notices/:noticeId/retry` retries only a known failed admission with the same notice ID; it does not repeat the business mutation. Unknown/skipped notices reject retry. All these routes require the normal Company scope and owner session. The running UI displays status and a retry button only for failed notices.

Explicit restart validates memory before activation and rereads it after activation, then records the exact applied configuration version. A later save or memory conflict is reported without falsely marking that revision applied. This is not a transaction spanning the external runtime and multiple files; post-activation conflicts require an explicit retry.

UI query keys, drafts, subscriptions and open file buffers include both Company and Agent. Sending captures its full scope and clears the original draft only if it has not changed while awaiting the receipt. Unsupported SDK queue editing/upload/runtime preferences are not advertised as working features.

## Restart readiness

`GET /api/restart-readiness` is an owner-only, read-only gate for stopping the single Bun service process. It accepts an optional `?companyId=` filter. An owner session cookie is required; an Agent bearer credential, or no cookie, receives `401`. The route is not part of `MODULE_OPERATIONS` and is not exposed through any Company MCP. Responses use `Cache-Control: no-store` from the existing `/api/*` middleware.

```json
{
  "safeToRestart": false,
  "verified": true,
  "checkedAt": "2026-11-02T18:20:00.000Z",
  "serverVersion": "1.0.0",
  "busy": [
    {
      "companyId": "c-...",
      "companyName": "Company",
      "agentId": "c-...-developer",
      "name": "Developer",
      "status": "running",
      "reasons": ["active_turn", "im_delivery"],
      "sessionId": "01a19b...",
      "turnId": "turn:3",
      "threadId": "T2",
      "archived": false
    }
  ],
  "counts": {
    "companies": 1,
    "activeAgents": 6,
    "archivedAgents": 1,
    "busyAgents": 1,
    "idleAgents": 5,
    "offlineAgents": 2
  },
  "errors": []
}
```

- `safeToRestart = verified && busy.length === 0`.
- `verified` is true only when every Company, roster, runtime scope and in-flight source was read successfully. Any unreadable source or the 5-second timeout yields `verified=false`, `safeToRestart=false`, `503`, and an `errors[]` entry with a redacted message.
- HTTP status: `200` safe, `409` verified but busy, `503` unverified, `401` no owner session, `404` explicit `companyId` not found.
- `serverVersion` is `package.json.version`; `/health.version` reads the same field. There is no version-write API.
- Stable `reasons` are `active_turn`, `prompt_in_flight`, `prompt_admission`, `agent_operation`, `queued_input`, `awaiting_input`, `running_task`, `im_delivery`, `work_notice`.
- `status` prefers the runtime turn status (`accepting`/`running`/`cancelling`), then `awaiting_input`; an operation-only lock is `binding`, delivery-only is `delivering`, queue-only is `queued`, task-only is `task_running`, and mixed facts fall back to `busy`.

Busy means this process currently has at least one unfinished unit attributable to the Agent: an active Chat turn, `promptInFlight > 0` or a pending input admission, a runtime wake/bind/restart/provision operation lock, a non-empty legacy input queue, a pending interaction, a `running`/`in_progress` Session task, an in-flight Company IM delivery, or an in-flight Agent work-notice. The following are explicitly **not** busy: peri-loom `threads.agent_status=active`, existence of `session_bindings`, IM thread `open`, `delivered`/`accepted` admissions, Issue workflow stage (for example a stable `triage`), Preview URLs, `executionBlocked`/`closed`/`not-ready`, and pending `needs_user` decisions. Archived Agents are still reported and still block when they have live work. An Agent without a bound chat is counted as offline, not busy.

Companies whose `initialization_status` is not `complete` are not asked for a roster, so a historical failed initialization cannot block forever. Their runtime `activeScopes()` and `workState()` are still checked, so an active Provision lock or bound work is reported. Roster-external bound/orphan scopes and IM/notice recipients outside the roster are also included to avoid under-reporting. `counts.activeAgents`/`archivedAgents` count roster members; `busyAgents` counts every reported Agent; `idleAgents` is `max(0, activeAgents - busy active roster members)`; `offlineAgents` is active roster members without a bound chat.

`bun run check:restart` (implemented in `scripts/restart-check.ts`) logs in with the owner token, calls this endpoint, and maps the answer to exit `0` SAFE, `2` BUSY, `3` UNVERIFIED, or `1` usage/missing token. It never stops, starts, signals or spawns a process, and never prints the token or cookie. The check is advisory rather than a distributed lock: new input can arrive between a safe answer and the actual stop. External host processes, external Preview services and manual terminal work are outside the single-process scope.
