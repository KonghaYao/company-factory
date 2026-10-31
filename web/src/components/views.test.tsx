import { test, expect, spyOn } from "bun:test";
import * as React from "react";
import * as ReactQuery from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Run } from "./Run";
import { Chat } from "./Chat";
import { RuntimeInputs } from "./RuntimeInputs";
import { InputQueue } from "./InputQueue";
import { CreateCompany } from "./Organization";
import { AgentEditor } from "./AgentEditor";
import { ApiError } from "../lib/api";
import type { Company } from "../lib/types";
const scope = { companyId: "fixture-company", agentId: "fixture-agent" };
const wrap = (child: any) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      {child}
    </QueryClientProvider>,
  );
test("Company creation only renders business fields, never a Company ID input", () => {
  const html = wrap(<CreateCompany onClose={() => {}} onCreated={() => {}} />);
  expect(html).toContain("公司名称");
  expect(html).toContain("公司目标");
  expect(html).not.toContain("公司 ID");
  expect(html.match(/<input\b/g)).toHaveLength(1);
});
test("Company creation retries the same payload and selects only the backend-returned Company", async () => {
  const state = ["中文公司", ""];
  const submission = { current: null };
  const created: Company[] = [];
  const requests: any[] = [];
  const company = { id: "backend-generated-company", name: state[0] } as Company;
  let stateIndex = 0;
  let mutation: any;
  const useState = spyOn(React, "useState").mockImplementation(
    (() => [state[stateIndex++], () => {}]) as any,
  );
  const useRef = spyOn(React, "useRef").mockReturnValue(submission as any);
  const useMutation = spyOn(ReactQuery, "useMutation").mockImplementation(
    ((options: any) => {
      mutation = options;
      return { mutate() {}, isPending: false, error: null };
    }) as any,
  );
  const original = globalThis.fetch;
  let fail = true;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    expect(url).toBe("/api/action");
    requests.push(JSON.parse(init.body as string));
    if (fail) {
      fail = false;
      throw new Error("创建响应丢失");
    }
    return new Response(JSON.stringify({ company, groups: [], agents: [] }));
  }) as any;
  const render = () => {
    stateIndex = 0;
    return CreateCompany({ onClose() {}, onCreated: (value) => created.push(value) });
  };
  try {
    const form = render().props.children;
    const submit = form.props.children.at(-1).props.children.at(-1);
    expect(submit.props.disabled).toBe(false);
    await expect(mutation.mutationFn()).rejects.toThrow("创建响应丢失");
    render();
    const result = await mutation.mutationFn();
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0].input).toEqual({
      name: state[0],
      goal: state[1],
      requestId: expect.any(String),
    });
    expect(requests[0].input).not.toHaveProperty("id");
    expect(requests[0]).not.toHaveProperty("companyId");
    expect(requests[0]).toMatchObject({
      module: "company_org",
      operation: "createCompany",
    });
    mutation.onSuccess(result);
    expect(created).toEqual([company]);
    expect(created[0]!.id).toBe("backend-generated-company");
    state[1] = "修改后的目标";
    render();
    await mutation.mutationFn();
    expect(requests[2].input.requestId).not.toBe(requests[1].input.requestId);
    expect(requests[2].input.goal).toBe(state[1]);
    state[0] = "另一家公司";
    render();
    await mutation.mutationFn();
    expect(requests[3].input.requestId).not.toBe(requests[2].input.requestId);
    state[0] = " ";
    const emptyForm = render().props.children;
    expect(emptyForm.props.children.at(-1).props.children.at(-1).props.disabled).toBe(true);
  } finally {
    globalThis.fetch = original;
    useState.mockRestore();
    useRef.mockRestore();
    useMutation.mockRestore();
  }
});
test("Agent editor exposes a dedicated system prompt and fixed identity", () => {
  const html = wrap(
    <AgentEditor
      companyId="fixture-company"
      agent={{
        id: "fixture-agent",
        name: "Fixture",
        role: "developer",
        groupId: "engineering",
        responsibilities: "Deliver software",
        systemPrompt: "Verify before reporting completion.",
        version: 3,
      }}
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
  expect(html).toContain("系统提示词");
  expect(html).toContain("Verify before reporting completion.");
  expect(html).toContain("Deliver software");
  expect(html).toContain("Agent ID");
  expect(html).not.toContain("公司 ID");
});
test("read-only runtime status does not call an unfinished Issue busy", () => {
  const html = wrap(
    <Run
      agent={{
        agentId: "fixture-agent",
        name: "Fixture",
        role: "developer",
        sessionId: "session",
      }}
      runtime={{ busy: false }}
      issues={[
        {
          id: "1",
          title: "unfinished",
          status: "code",
          agent_id: "fixture-agent",
        },
      ]}
      previews={[]}
      onIssue={() => {}}
    />,
  );
  expect(html).toContain("等待新的输入");
  expect(html).not.toContain("正在执行工作");
  expect(html).toContain("unfinished");
});
test("permission and Company decision remain distinct, no approval button without pending fact", () => {
  const html = wrap(
    <RuntimeInputs
      scope={scope}
      interactions={[
        {
          id: "approval",
          kind: "permission",
          sessionId: "session",
          status: "pending",
          createdAt: null,
          resolvedAt: null,
          title: "Bash permission",
        },
      ]}
    />,
  );
  expect(html).toContain("仅允许本次");
  expect(html).toContain("本次拒绝");
  expect(html).toContain("不会代替 Company Issue");
  expect(wrap(<RuntimeInputs scope={scope} interactions={[]} />)).not.toContain(
    "仅允许本次",
  );
});
test("native queue controls render only for advertised capabilities", () => {
  const q = [{ inputId: "real-contract-id", state: "queued" }];
  expect(
    wrap(
      <InputQueue
        scope={scope}
        runtime={{ queue: q, capabilities: { queue: true } }}
      />,
    ),
  ).not.toContain("立即投递");
  expect(
    wrap(
      <InputQueue
        scope={scope}
        runtime={{
          queue: q,
          capabilities: { queue: true, queueForceSend: true },
        }}
      />,
    ),
  ).toContain("立即投递");
});
test("expired interaction hint is visible on the production error-sink path", () => {
  const useMutation = spyOn(ReactQuery, "useMutation").mockImplementation(
    (() => ({
      mutate() {},
      isPending: false,
      error: new ApiError(
        "Interaction is no longer pending",
        "answer_failed",
        {
          requestId: "req",
          disposition: "unknown",
          causeCode: "unknown_interaction",
        },
        500,
      ),
    })) as any,
  );
  try {
    const html = wrap(
      <RuntimeInputs
        scope={scope}
        interactions={[
          {
            id: "expired",
            kind: "permission",
            sessionId: "session",
            status: "pending",
            createdAt: null,
            resolvedAt: null,
            title: "Bash permission",
          },
        ]}
        onInputError={() => {}}
      />,
    );
    expect(html).toContain("该交互已结束或已处理");
  } finally {
    useMutation.mockRestore();
  }
});
test("runtime contract facts expose an explicit session-preserving recovery", () => {
  const agent = { name: "Fixture", role: "developer" };
  const blocked = wrap(
    <Chat
      scope={scope}
      agent={agent}
      runtime={{
        status: "error",
        executionBlocked: true,
        activeTurn: {
          turnId: "turn-1",
          status: "error",
          stopReason: "error",
          error: { code: "execution_failed", message: "执行失败" },
        },
      }}
      issues={[]}
      onFile={() => {}}
    />,
  );
  expect(blocked).toContain("运行时需要恢复");
  expect(blocked).toContain("重启 Agent（保留会话）");
  expect(blocked).toContain("不会替换 Session");
  expect(blocked).toContain("最近一轮停止原因：error");
  const healthy = wrap(
    <Chat
      scope={scope}
      agent={agent}
      runtime={{ status: "idle", busy: false }}
      issues={[]}
      onFile={() => {}}
    />,
  );
  expect(healthy).not.toContain("重启 Agent（保留会话）");
});
