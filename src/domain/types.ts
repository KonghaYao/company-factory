/** Trusted adapter-created identity. Never populate this from a tool's input. */
export type CallerContext = Readonly<{
  type: "user" | "agent";
  id: string;
  companyId: string;
}>;
export type AgentModelTier = "fable" | "opus" | "sonnet" | "haiku";
export type AgentConfig = {
  /** Model library profile id; "" inherits the library default. */
  modelProfile?: string;
  modelAlias?: AgentModelTier;
  responsibilities?: string;
  instructions?: string;
  workspaceRoots?: string[];
  mcp?: Record<string, unknown>;
  /** Reserved: never spread into runtime settings. */
  settings?: Record<string, unknown>;
  [key: string]: unknown;
};
export type ProvisionInput = {
  agentId: string;
  companyId: string;
  groupId: string;
  role: string;
  name: string;
  responsibilities: string;
  systemPrompt?: string;
  directory: string;
  knowledgeDirectory: string;
  config: AgentConfig;
  authToken: string;
  baseUrl: string;
  /** Recovery verifies this already-confirmed binding; it must not be replaced. */
  sessionId?: string;
};
export type DeliveryInput = {
  companyId: string;
  agentId: string;
  threadId: string;
  messageId: string;
  text: string;
};
export type DomainOptions = {
  root: string;
  baseUrl?: string;
  provisionAgent(
    input: ProvisionInput,
  ): Promise<{ sessionId: string; mcpConfig?: unknown }>;
  deliver?(input: DeliveryInput): Promise<{
    status: "delivered" | "failed";
    receipt?: unknown;
    error?: string;
  }>;
  onChange?(event: {
    companyId: string;
    kind: string;
    id?: string;
    agentIds?: string[];
  }): void;
};
export type AgentRecord = {
  agentId: string;
  companyId: string;
  groupId: string;
  role: string;
  name: string;
  responsibilities: string;
  systemPrompt: string;
  directory: string;
  sessionId: string;
  config: AgentConfig;
  effectiveConfig: AgentConfig;
  configVersion: number;
  appliedConfigVersion: number;
  version: number;
};
export type Group = { id: string; name: string; responsibilities: string };
export type Company = {
  id: string;
  name: string;
  goal: string;
  roles: Record<string, { permissions: string[] }>;
  created_at: string;
  version: number;
};
export type Decision = {
  id: string;
  question: string;
  status: "pending" | "answered" | "withdrawn";
  answer: string | null;
  answers: { text: string; author_id: string; at: string; late: boolean }[];
  processed_at?: string;
  withdrawn_at?: string;
};
export type IssueStatus =
  | "triage"
  | "plan"
  | "code"
  | "ready_preview"
  | "preview"
  | "accepted"
  | "verifying"
  | "ready_merge"
  | "cancel";
export type Issue = {
  id: string;
  title: string;
  type: string | null;
  pipeline: string | null;
  status: IssueStatus;
  agent_id: string;
  summary: string;
  progress: string;
  needs_user: boolean;
  decisions: Decision[];
  preview_batch: string | null;
  collaborators: string[];
  history: {
    at: string;
    from: string;
    to: string;
    by: string;
    reason: string;
  }[];
  code_ref: string | null;
  plan_ref: string | null;
  worktree: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  body: string;
  cancel_reason?: string;
};
export type Comment = {
  id: string;
  issue_id: string;
  author_type: "user" | "agent";
  author_id: string;
  created_at: string;
  updated_at?: string;
  version: number;
  body: string;
};
export type Acceptance = {
  issue_id: string;
  code_ref: string;
  passed: boolean;
  checklist: string[];
  evidence: string;
  by: string;
  at: string;
};
export type Verification = {
  issue_id: string;
  code_ref: string;
  kind: "ci" | "review";
  passed: boolean;
  evidence: string;
  by: string;
  at: string;
};
export type Preview = {
  id: string;
  owner_id: string;
  issue_ids: string[];
  collaborators: string[];
  branch: string;
  code_refs: Record<string, string>;
  environment_url: string;
  checklist: Record<string, string[]>;
  acceptances: Acceptance[];
  verifications: Verification[];
  body: string;
  version: number;
  updated_at: string;
};
export type Thread = {
  id: string;
  asker_id: string;
  recipient_id: string;
  status: "open" | "resolved" | "withdrawn";
  subject: string;
  created_at: string;
  version: number;
  body: string;
};
export type Message = {
  id: string;
  thread_id: string;
  sender_id: string;
  recipient_id: string;
  reply_to: string | null;
  created_at: string;
  delivery_status: "saved" | "delivered" | "failed";
  delivered_at?: string;
  delivery_error?: string;
  receipt?: unknown;
  late: boolean;
  version: number;
  body: string;
};
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
export function requireValue(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new DomainError(code, message, status);
}
export const now = () => new Date().toISOString();
