import { z } from "zod";
import { AVATAR_COLORS } from "../domain/avatar";
export const MODULE_OPERATIONS = {
  company_org: [
    "organization",
    "createCompany",
    "createGroup",
    "createOrgNode",
    "updateOrgNode",
    "deleteOrgNode",
    "archiveOrgNode",
    "createMember",
    "updateMember",
    "moveMember",
    "archiveMember",
    "restoreMember",
    "setRolePermissions",
  ],
  company_tasks: [
    "listIssues",
    "searchIssues",
    "getIssue",
    "createIssue",
    "updateIssue",
    "assignIssue",
    "cancelIssue",
    "comments",
    "addComment",
    "updateComment",
    "updateTodos",
    "askDecision",
    "answerDecision",
    "resolveDecision",
    "withdrawDecision",
    "listPipelines",
    "savePreview",
    "getPreview",
    "acceptPreview",
    "recordVerification",
    "workspace",
  ],
  company_im: ["members", "ask", "reply", "inbox", "thread", "closeThread"],
} as const;
export type CompanyModule = keyof typeof MODULE_OPERATIONS;
const str = z.string();
const contextOptions = {
  agentId: str.min(1).optional(),
  cursor: str.min(1).max(1024).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  includeHistory: z.boolean().optional(),
  status: z
    .array(
      z.enum([
        "triage",
        "plan",
        "code",
        "ready_preview",
        "preview",
        "accepted",
        "verifying",
        "ready_merge",
        "cancel",
      ]),
    )
    .min(1)
    .max(9)
    .optional(),
};
/** Schemas describe application identifiers, never caller identity. Domain performs field/role/CAS checks. */
export const schemas: Record<string, z.ZodType> = {
  organization: z.object({}),
  createCompany: z.strictObject({
    name: str,
    goal: str.optional(),
    config: z.record(str, z.unknown()).optional(),
    requestId: str,
  }),
  createGroup: z.object({
    id: str,
    name: str,
    responsibilities: str.optional(),
    parentId: str.nullable().optional(),
    kind: z
      .enum(["company", "division", "department", "team", "squad", "committee"])
      .optional(),
    order: z.number().int().min(0).optional(),
    requestId: str,
  }),
  createOrgNode: z.object({
    id: str,
    name: str,
    responsibilities: str.optional(),
    parentId: str.nullable().optional(),
    kind: z
      .enum(["company", "division", "department", "team", "squad", "committee"])
      .optional(),
    order: z.number().int().min(0).optional(),
    leadPersonId: str.nullable().optional(),
    requestId: str,
  }),
  updateOrgNode: z.object({
    id: str,
    name: str.optional(),
    responsibilities: str.optional(),
    parentId: str.nullable().optional(),
    kind: z
      .enum(["company", "division", "department", "team", "squad", "committee"])
      .optional(),
    order: z.number().int().min(0).optional(),
    leadPersonId: str.nullable().optional(),
    expectedVersion: z.number(),
    requestId: str,
  }),
  deleteOrgNode: z.object({
    id: str,
    reassignTo: str.optional(),
    expectedVersion: z.number(),
    requestId: str,
  }),
  archiveOrgNode: z.object({
    id: str,
    expectedVersion: z.number(),
    requestId: str,
  }),
  createMember: z.looseObject({
    agentId: str,
    name: str,
    groupId: str.optional(),
    role: str,
    responsibilities: str,
    systemPrompt: str.optional(),
    config: z.record(str, z.unknown()).optional(),
    requestId: str,
  }),
  moveMember: z.object({
    agentId: str,
    nodeId: str,
    title: str.optional(),
    order: z.number().int().min(0).optional(),
    expectedVersion: z.number(),
    requestId: str,
  }),
  archiveMember: z.object({
    agentId: str,
    expectedVersion: z.number(),
    requestId: str,
  }),
  restoreMember: z.object({
    agentId: str,
    nodeId: str.optional(),
    expectedVersion: z.number(),
    requestId: str,
  }),
  updateMember: z.looseObject({
    agentId: str,
    name: str.optional(),
    responsibilities: str.optional(),
    systemPrompt: str.optional(),
    avatarColor: z.enum(AVATAR_COLORS).optional(),
    expectedVersion: z.number(),
    requestId: str,
  }),
  setRolePermissions: z.object({
    role: str,
    permissions: z.array(str),
    expectedVersion: z.number(),
    requestId: str,
  }),
  listIssues: z.object(contextOptions),
  searchIssues: z.object({
    query: str.min(1).max(200),
    status: z
      .array(
        z.enum([
          "triage",
          "plan",
          "code",
          "ready_preview",
          "preview",
          "accepted",
          "verifying",
          "ready_merge",
          "cancel",
        ]),
      )
      .min(1)
      .max(9)
      .optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  getIssue: z.object({ issueId: str }),
  createIssue: z.looseObject({
    title: str,
    body: str.optional(),
    summary: str.optional(),
    assigneeAgentId: str.optional(),
    type: str.optional(),
    pipeline: str.optional(),
    reason: str.optional(),
    requestId: str,
  }),
  updateIssue: z.looseObject({
    issueId: str,
    expectedVersion: z.number(),
    requestId: str,
    patch: z.record(str, z.unknown()).optional(),
    body: str.optional(),
  }),
  assignIssue: z.looseObject({
    issueId: str,
    agentId: str,
    expectedVersion: z.number(),
    reason: str.optional(),
    requestId: str,
  }),
  cancelIssue: z.object({
    issueId: str,
    expectedVersion: z.number(),
    reason: str,
    requestId: str,
  }),
  comments: z.object({ issueId: str, cursor: str.optional() }),
  addComment: z.object({ issueId: str, body: str, requestId: str }),
  updateComment: z.object({
    issueId: str,
    commentId: str,
    body: str,
    expectedVersion: z.number(),
    requestId: str,
  }),
  updateTodos: z.looseObject({
    issueId: str,
    expectedVersion: z.number(),
    requestId: str,
    changes: z
      .array(
        z.discriminatedUnion("op", [
          z.object({
            op: z.literal("add"),
            text: str.min(1).max(500),
            status: z.enum(["pending", "in_progress", "done"]).optional(),
          }),
          z.object({
            op: z.literal("update"),
            todoId: str,
            text: str.min(1).max(500).optional(),
            status: z.enum(["pending", "in_progress", "done"]).optional(),
          }),
          z.object({ op: z.literal("remove"), todoId: str }),
        ]),
      )
      .min(1)
      .max(20)
      .optional(),
    order: z.array(str).min(1).max(50).optional(),
    note: str.min(1).max(2000),
  }),
  askDecision: z.object({
    issueId: str,
    question: str,
    options: z.array(str.min(1).max(200)).min(2).max(6).optional(),
    expectedVersion: z.number(),
    requestId: str,
  }),
  answerDecision: z.object({
    issueId: str,
    questionId: str,
    answer: str,
    expectedVersion: z.number(),
    requestId: str,
  }),
  resolveDecision: z.object({
    issueId: str,
    questionId: str,
    expectedVersion: z.number(),
    requestId: str,
  }),
  withdrawDecision: z.object({
    issueId: str,
    questionId: str,
    expectedVersion: z.number(),
    reason: str.optional(),
    requestId: str,
  }),
  listPipelines: z.object({}),
  savePipeline: z.looseObject({
    id: str,
    expectedVersion: z.number().optional(),
    requestId: str,
  }),
  savePreview: z.looseObject({
    id: str,
    owner_id: str,
    issue_ids: z.array(str),
    branch: str,
    code_refs: z.record(str, str),
    environment_url: str,
    checklist: z.record(str, z.array(str)),
    expectedVersion: z.number().optional(),
    requestId: str,
  }),
  getPreview: z.object({ batchId: str.min(1) }),
  acceptPreview: z.looseObject({
    batchId: str,
    issueId: str,
    codeRef: str,
    expectedVersion: z.number(),
    passed: z.boolean(),
    evidence: str,
    requestId: str,
  }),
  recordVerification: z.looseObject({
    batchId: str,
    issueId: str,
    codeRef: str,
    expectedVersion: z.number(),
    kind: z.enum(["ci", "review"]),
    passed: z.boolean(),
    evidence: str,
    requestId: str,
  }),
  workspace: z.object({
    ...contextOptions,
    threadCursor: str.min(1).max(1024).optional(),
    previewCursor: str.min(1).max(1024).optional(),
  }),
  members: z.object({ query: str.optional() }),
  ask: z.looseObject({
    toAgentId: str,
    text: str,
    subject: str.optional(),
    threadId: str.optional(),
    requestId: str,
  }),
  reply: z.looseObject({
    threadId: str,
    messageId: str,
    text: str,
    requestId: str,
  }),
  inbox: z.object({
    agentId: str
      .optional()
      .describe(
        "Owner-only; Agent callers always read their own inbox. Use thread(threadId) for another Agent's thread.",
      ),
    cursor: str.optional(),
  }),
  thread: z.object({ threadId: str, cursor: str.optional() }),
  closeThread: z.object({
    threadId: str,
    status: z.enum(["resolved", "withdrawn"]),
    expectedVersion: z.number(),
    requestId: str,
  }),
};
export const READ_OPERATIONS = new Set([
  "organization",
  "listIssues",
  "searchIssues",
  "getIssue",
  "getPreview",
  "comments",
  "listPipelines",
  "workspace",
  "members",
  "inbox",
  "thread",
]);
