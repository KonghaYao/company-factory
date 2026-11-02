import type {
  InputQueueView,
  InteractionView,
  SessionViewReadiness,
  TurnView,
} from "@peri-code/sdk/view";
export type Scope = { companyId: string; agentId: string };
export type Company = {
  id: string;
  name: string;
  description?: string;
  goal?: string;
};
export type Group = { id: string; name: string; description?: string };
export type Agent = {
  id?: string;
  agentId?: string;
  agent_id?: string;
  name: string;
  groupId?: string;
  group_id?: string;
  role: string;
  responsibilities?: string;
  systemPrompt?: string;
  version?: number;
  sessionId?: string;
  session_id?: string;
  needs_user?: boolean;
  busy?: boolean;
};
export type Decision = {
  id: string;
  question: string;
  status: "pending" | "answered" | "withdrawn";
  answer?: string | null;
  responses?: { answer: string; created_at: string }[];
};
export type Issue = {
  id: string | number;
  title: string;
  status: string;
  agent_id: string;
  summary?: string;
  progress?: string;
  body?: string;
  description?: string;
  needs_user?: boolean;
  decisions?: Decision[];
  version?: number | string;
  preview_batch?: string;
  type?: string;
  pipeline?: string;
  code_ref?: string;
  collaborators?: string[];
};
export type Comment = {
  id: string;
  body: string;
  author_type: string;
  author_id: string;
  created_at: string;
  updated_at?: string;
  version?: number | string;
};
export type Preview = {
  id: string;
  title?: string;
  name?: string;
  owner_agent_id?: string;
  issues?: Array<string | number>;
  issue_ids?: Array<string | number>;
  url?: string;
  environment_url?: string;
  branch?: string;
  code_ref?: string;
  code_refs?: Record<string, string>;
  body?: string;
  checklist?: unknown;
  acceptance?: unknown;
  verification?: unknown;
  verifications?: unknown;
  acceptances?: unknown;
  version?: string | number;
};
export type Thread = {
  id: string;
  subject?: string;
  question?: string;
  status: string;
  participants?: string[];
  created_at?: string;
  body?: string;
};
export type IMMessage = {
  id: string;
  body: string;
  sender_id?: string;
  author_id?: string;
  created_at: string;
  delivery_status?: string;
  delivery?: { status?: string };
};
export type ModelTier = "fable" | "opus" | "sonnet" | "haiku";
export type RuntimePublicError = NonNullable<TurnView["error"]>;
/** `activeTurn` 是 SDK TurnView 的字段一一映射；stopReason 缺失时显式归一为 null。 */
export type RuntimeActiveTurn = Omit<
  Pick<TurnView, "turnId" | "status" | "stopReason" | "error">,
  "stopReason"
> & { stopReason: string | null };
/** `queueState` 是 SDK InputQueueView 的只读投影；items 只以 count 暴露。 */
export type RuntimeQueueState = Pick<
  InputQueueView,
  "generation" | "revision"
> & { activeRequestId: InputQueueView["activeRequestId"] | null; count: number };
export type Runtime = {
  state?: string;
  status?: string;
  busy?: boolean;
  running?: boolean;
  executionBlocked?: boolean;
  closed?: boolean;
  closedReason?: RuntimePublicError | null;
  readiness?: SessionViewReadiness;
  activeTurn?: RuntimeActiveTurn | null;
  queueState?: RuntimeQueueState | null;
  sessionId?: string;
  session_id?: string;
  pendingRestart?: boolean;
  configured?: boolean;
  model?: string;
  /** Applied model chain metadata; all fields are non-secret. */
  modelAlias?: ModelTier | null;
  modelProfile?: string | null;
  modelProvider?: string | null;
  modelMissing?: string[];
  modelError?: string | null;
  modelSource?: "profile" | null;
  modelLibraryRevision?: string | null;
  /** All four tiers when the applied snapshot carries v2 detail; null for older snapshots. */
  modelTiers?: Record<ModelTier, string> | null;
  modelTierProviders?: Record<ModelTier, string | null> | null;
  modelTierSources?: Record<ModelTier, "bound" | "fallback" | "unbound"> | null;
  modelResolvedAt?: string | null;
  /** Set when an older snapshot must be restarted to show per-tier detail. */
  modelTierNotice?: string | null;
  error?: string;
  activities?: any[];
  capabilities?: {
    stop?: boolean;
    commands?: string[];
    skills?: string[];
    queue?: boolean;
    queueTakeBack?: boolean;
    queueForceSend?: boolean;
    attachments?: boolean;
  };
  queue?: any[];
  interactions?: InteractionView[];
};
export type ModelLibraryTierView = {
  tier: ModelTier;
  bound: boolean;
  provider: string | null;
  providerType: "openai" | "anthropic" | null;
  label: string | null;
  model: string | null;
  modelEnv: string | null;
  modelConfigured: boolean;
  providerEnabled: boolean;
  endpointConfigured: boolean;
  credentialConfigured: boolean;
  missing: string[];
  ready: boolean;
};
export type ModelLibraryProfileView = {
  id: string;
  label: string | null;
  activeAlias: ModelTier;
  enabled: boolean;
  /** Always expands to all four tiers; absent bindings are `bound: false`. */
  tiers: ModelLibraryTierView[];
};
export type ModelLibraryProviderView = {
  id: string;
  type: "openai" | "anthropic";
  label: string | null;
  enabled: boolean;
  /** Environment variable *names* only; values never leave the host. */
  baseUrlEnv: string;
  apiKeyEnv: string;
  endpointConfigured: boolean;
  credentialConfigured: boolean;
};
/** Read-only v2 projection of `$COMPANY_HOME/model-library.yaml`. */
export type ModelLibraryView = {
  status: "ok" | "missing" | "insecure" | "invalid";
  error: string | null;
  issues: string[];
  path: string;
  version: number | null;
  activeProfile: string | null;
  revision: string | null;
  profiles: ModelLibraryProfileView[];
  providers: ModelLibraryProviderView[];
};
export type ChatMessage = {
  id: string;
  role: string;
  content?: string | any[];
  text?: string;
  created_at?: string;
  timestamp?: string;
  type?: string;
  references?: FileReference[];
  tools?: any[];
  status?: string;
  error?: RuntimePublicError | null;
};
export type FileReference = {
  path: string;
  startLine?: number;
  endLine?: number;
  content?: string;
  version?: string | number;
};
export type FileEntry = {
  path: string;
  name?: string;
  type?: string;
  isDirectory?: boolean;
  children?: FileEntry[];
};
export type FileBuffer = {
  path: string;
  original: string;
  content: string;
  version?: string | number;
  dirty: boolean;
  diskConflict?: string;
  conflictVersion?: string | number;
};
export type Workspace = {
  issues: Issue[];
  previews: Preview[];
  threads: Thread[];
  runtime?: Runtime;
};
export const scopeKey = (scope: Scope) => `${scope.companyId}:${scope.agentId}`;
export const agentId = (a: Agent) => a.id || a.agentId || a.agent_id || "";
export const agentGroup = (a: Agent) => a.groupId || a.group_id || "";
