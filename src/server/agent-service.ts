import type { CompanyDomain, CallerContext, AgentRecord } from "../domain";
import { PeriRuntime } from "../runtime";

/** Fixed business IDs stay outside the SDK. Only this adapter owns live handles. */
export class AgentService {
  private locks = new Map<string, Promise<unknown>>();
  constructor(
    readonly domain: CompanyDomain,
    readonly runtime: PeriRuntime,
  ) {}
  private async serial<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(agentId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    this.locks.set(agentId, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(agentId) === current) this.locks.delete(agentId);
    }
  }
  async binding(caller: CallerContext, agentId: string) {
    const agent = await this.domain.getAgent(caller, { agentId });
    const binding = await this.runtime.sessionBinding(agent);
    return { ...agent, ...(binding ?? {}) };
  }
  input(agent: AgentRecord, saved = false) {
    return {
      agentId: agent.agentId,
      companyId: agent.companyId,
      directory: agent.directory,
      knowledgeDirectory: `${this.domain.store.company(agent.companyId)}/knowledgebase`,
      name: agent.name,
      role: agent.role,
      responsibilities: agent.responsibilities,
      systemPrompt: agent.systemPrompt,
      sessionId: agent.sessionId,
      config: saved ? agent.config : agent.effectiveConfig,
    };
  }
  async configuration(caller: CallerContext, agentId: string) {
    const a = await this.binding(caller, agentId);
    return {
      saved: a.config,
      applied: a.effectiveConfig,
      pendingRestart: a.configVersion !== a.appliedConfigVersion,
      version: a.version,
      configVersion: a.configVersion,
      appliedConfigVersion: a.appliedConfigVersion,
    };
  }
  async save(
    caller: CallerContext,
    agentId: string,
    input: Record<string, unknown>,
  ) {
    return this.serial(agentId, async () => {
      const a = await this.binding(caller, agentId);
      await this.domain.saveAgentConfiguration(caller, {
        ...input,
        agentId,
        requestId: input.requestId ?? crypto.randomUUID(),
        config: input.configuration ?? input.config,
        version: input.expectedVersion ?? input.version,
      });
      return this.configuration(caller, agentId);
    });
  }
  async restart(
    caller: CallerContext,
    agentId: string,
    options: { force?: boolean } = {},
  ) {
    return this.serial(agentId, async () => {
      const a = await this.binding(caller, agentId);
      await this.domain.validateAgentConfigurationApply(caller, {
        agentId,
        configVersion: a.configVersion,
      });
      const result = await this.runtime.restart(this.input(a, true), options);
      await this.domain.markAgentConfigurationApplied(caller, {
        agentId,
        configVersion: a.configVersion,
        configuration: a.config,
        requestId: crypto.randomUUID(),
      });
      return result;
    });
  }
  async snapshot(caller: CallerContext, agentId: string) {
    const a = await this.binding(caller, agentId);
    const runtime = await this.runtime.snapshot({
      companyId: a.companyId,
      agentId,
      sessionId: a.sessionId,
    });
    return {
      ...runtime,
      capabilities: {
        ...runtime.capabilities,
        // 用户输入走 direct prompt；queue 动作仅为 legacy/诊断保留。
        queue: false,
        queueTakeBack: false,
        queueForceSend: false,
      },
      replacesSessionId: runtime.replacesSessionId ?? a.replacesSessionId ?? null,
      agentId,
      companyId: a.companyId,
    };
  }
  async conversation(caller: CallerContext, agentId: string, cursor?: string) {
    const a = await this.binding(caller, agentId);
    return this.runtime.conversation(this.input(a), cursor);
  }
  async send(
    caller: CallerContext,
    agentId: string,
    input: Record<string, unknown>,
  ) {
    const a = await this.binding(caller, agentId);
    if (input.issueId)
      await this.domain.getIssue(caller, { issueId: input.issueId });
    return this.runtime.send(this.input(a), input as any);
  }
  async stop(caller: CallerContext, agentId: string) {
    const a = await this.binding(caller, agentId);
    return this.runtime.stop(this.input(a));
  }
  /** LEGACY：queue 操作保留供回滚/诊断；用户输入走 direct prompt。 */
  async queue(
    caller: CallerContext,
    agentId: string,
    inputId: string,
    operation: "takeBack" | "forceSend",
  ) {
    const a = await this.binding(caller, agentId);
    return this.runtime[operation](this.input(a), inputId);
  }
  async answer(
    caller: CallerContext,
    agentId: string,
    interactionId: string,
    answer: unknown,
  ) {
    const a = await this.binding(caller, agentId);
    return this.runtime.answer(this.input(a), interactionId, answer);
  }
  async deliver(input: {
    companyId: string;
    agentId: string;
    text: string;
    messageId: string;
    threadId: string;
  }) {
    const a = await this.domain.getAgentInternal(input.agentId);
    if (a.companyId !== input.companyId)
      throw new Error("Cross-company delivery is forbidden");
    return this.runtime.deliver(this.input(a), input);
  }
}
