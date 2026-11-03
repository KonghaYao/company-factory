import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CompanyDomain,
  type CallerContext,
  type DeliveryInput,
} from "./index";

type Outcome = "failed" | "unknown" | "unknown-receipt" | "throw" | "deferred";

const roots: string[] = [];

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(outcome: () => Outcome) {
  const root = await mkdtemp(join(tmpdir(), "company-im-delivery-"));
  roots.push(root);
  const calls: DeliveryInput[] = [];
  let notifyDelivery: (() => void) | undefined;
  let releaseDeferred!: () => void;
  const deferred = new Promise<void>((resolve) => {
    releaseDeferred = resolve;
  });
  const domain = new CompanyDomain({
    root,
    provisionAgent: async (input) => ({
      sessionId: `unit-session-${input.agentId}`,
    }),
    onChange: (event) => {
      if (event.kind !== "imDelivery") return;
      notifyDelivery?.();
      notifyDelivery = undefined;
    },
    deliver: async (input) => {
      calls.push(input);
      const mode = outcome();
      if (mode === "throw")
        throw Object.assign(
          new Error("adapter failed at https://host.example/x"),
          { code: "adapter_boom" },
        );
      if (mode === "failed")
        return {
          status: "failed",
          error: "消息未发送",
          code: "prompt_not_admitted",
          disposition: "not_sent",
          uncertain: false,
        };
      if (mode === "deferred") {
        await deferred;
        return {
          status: "unknown",
          error: "结果不确定",
          code: "prompt_failed",
          disposition: "unknown",
          uncertain: true,
        };
      }
      if (mode === "unknown-receipt")
        return {
          status: "unknown",
          error: "结果不确定",
          code: "prompt_failed",
          disposition: "unknown",
          uncertain: true,
          receipt: { leaked: true },
        };
      return {
        status: "unknown",
        error: "结果不确定",
        code: "prompt_failed",
        disposition: "unknown",
        uncertain: true,
      };
    },
  });
  const commit = domain.store.commit.bind(domain.store);
  spyOn(domain.store, "commit").mockImplementation(async (dir, message) => {
    if (dir.startsWith(join(domain.store.root, "agents") + "/")) return;
    return commit(dir, message);
  });
  const user: CallerContext = {
    type: "user",
    id: "local-user",
    companyId: "",
  };
  const { company } = await domain.createCompany(user, {
    name: "Delivery",
    goal: "Verify IM delivery states",
    requestId: "create-delivery-company",
  });
  const hr: CallerContext = {
    type: "agent",
    id: `${company.id}-hr`,
    companyId: company.id,
  };
  await domain.createGroup(hr, {
    id: "eng",
    name: "Engineering",
    responsibilities: "Build",
    requestId: "create-group",
  });
  await domain.createMember(hr, {
    agentId: "dev-1",
    name: "Developer",
    groupId: "eng",
    role: "developer",
    responsibilities: "Code",
    requestId: "create-member",
  });
  return {
    domain,
    calls,
    releaseDelivery: releaseDeferred,
    nextDelivery: () =>
      new Promise<void>((resolve) => {
        notifyDelivery = resolve;
      }),
    dev: {
      type: "agent" as const,
      id: "dev-1",
      companyId: company.id,
    },
    secretary: {
      type: "agent" as const,
      id: `${company.id}-secretary`,
      companyId: company.id,
    },
  };
}

async function messageInThread(
  domain: CompanyDomain,
  ctx: CallerContext,
  threadId: string,
  messageId: string,
) {
  const { items } = await domain.thread(ctx, { threadId });
  const message = items.find((item) => item.id === messageId);
  if (!message) throw new Error("IM message not found");
  return message;
}

describe("IM delivery state machine", () => {
  test("in-flight deliveries expose metadata only while the process is sending", async () => {
    const f = await fixture(() => "deferred");
    const ask = await f.domain.ask(f.dev, {
      recipientId: f.secretary.id,
      subject: "In flight",
      body: "Still sending",
      requestId: "ask-in-flight",
    });
    const inFlight = f.domain.inFlightDeliveries(f.dev.companyId);
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]).toMatchObject({
      companyId: f.dev.companyId,
      messageId: ask.messageId,
      threadId: ask.threadId,
      recipientId: f.secretary.id,
    });
    expect(typeof inFlight[0]!.startedAt).toBe("string");
    expect(f.domain.inFlightDeliveries("other-company")).toEqual([]);

    const delivered = f.nextDelivery();
    f.releaseDelivery();
    await delivered;
    for (
      let attempt = 0;
      attempt < 100 && f.domain.inFlightDeliveries(f.dev.companyId).length > 0;
      attempt++
    )
      await Bun.sleep(1);
    expect(f.domain.inFlightDeliveries(f.dev.companyId)).toEqual([]);
  });

  test("failed(not_sent) keeps disposition and never writes delivered_at", async () => {
    const f = await fixture(() => "failed");
    const delivered = f.nextDelivery();
    const ask = await f.domain.ask(f.dev, {
      recipientId: f.secretary.id,
      subject: "Failed",
      body: "Retryable",
      requestId: "ask-failed",
    });
    await delivered;
    const message = await messageInThread(
      f.domain,
      f.dev,
      ask.threadId,
      ask.messageId,
    );
    expect(message).toMatchObject({
      delivery_status: "failed",
      delivery_error: "消息未发送",
      delivery_error_code: "prompt_not_admitted",
      delivery_disposition: "not_sent",
      delivery_attempts: 1,
    });
    expect(message.delivered_at).toBeUndefined();
    expect(message.last_attempt_at).toBeTruthy();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({
      messageId: ask.messageId,
      requestId: ask.messageId,
      attempt: 1,
    });
  });

  test("unknown keeps disposition and never writes delivered_at", async () => {
    const f = await fixture(() => "unknown");
    const delivered = f.nextDelivery();
    const ask = await f.domain.ask(f.dev, {
      recipientId: f.secretary.id,
      subject: "Unknown",
      body: "Do not resend",
      requestId: "ask-unknown",
    });
    await delivered;
    const message = await messageInThread(
      f.domain,
      f.dev,
      ask.threadId,
      ask.messageId,
    );
    expect(message).toMatchObject({
      delivery_status: "unknown",
      delivery_error: "结果不确定",
      delivery_error_code: "prompt_failed",
      delivery_disposition: "unknown",
      delivery_attempts: 1,
    });
    expect(message.delivered_at).toBeUndefined();
    expect(message.receipt).toBeUndefined();
  });

  test("unknown never persists a receipt even when the adapter returns one", async () => {
    const f = await fixture(() => "unknown-receipt");
    const delivered = f.nextDelivery();
    const ask = await f.domain.ask(f.dev, {
      recipientId: f.secretary.id,
      subject: "Unknown receipt",
      body: "No proof of admission",
      requestId: "ask-unknown-receipt",
    });
    await delivered;
    const message = await messageInThread(
      f.domain,
      f.dev,
      ask.threadId,
      ask.messageId,
    );
    expect(message).toMatchObject({
      delivery_status: "unknown",
      delivery_disposition: "unknown",
    });
    expect(message.delivered_at).toBeUndefined();
    expect(message.receipt).toBeUndefined();
  });

  test("a thrown deliver call is unknown, not failed", async () => {
    const f = await fixture(() => "throw");
    const delivered = f.nextDelivery();
    const ask = await f.domain.ask(f.dev, {
      recipientId: f.secretary.id,
      subject: "Thrown",
      body: "Adapter crashed",
      requestId: "ask-throw",
    });
    await delivered;
    const message = await messageInThread(
      f.domain,
      f.dev,
      ask.threadId,
      ask.messageId,
    );
    expect(message).toMatchObject({
      delivery_status: "unknown",
      delivery_error: "adapter failed at https://host.example/x",
      delivery_error_code: "adapter_boom",
      delivery_disposition: "unknown",
      delivery_attempts: 1,
    });
    expect(message.delivered_at).toBeUndefined();
  });
});
