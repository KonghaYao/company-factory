import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, Runtime, Scope } from "../../lib/types";
import { RunSummary } from "./RunSummary";
import { RunView } from "./RunView";

function runtime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    busy: true,
    running: true,
    configured: true,
    modelProfile: "default",
    modelProvider: "host-anthropic",
    model: "deepseek-v4-flash",
    modelAlias: "sonnet",
    activeTurn: {
      turnId: "turn-1",
      status: "running",
      error: null,
      stopReason: null,
    },
    queueState: {
      generation: "1",
      revision: 1,
      activeRequestId: null,
      count: 2,
    },
    ...overrides,
  };
}

const scope: Scope = { companyId: "company-1", agentId: "agent-1" };
const agent: Agent = { name: "主管", role: "manager" };

function renderRunView(value: Runtime): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RunView
        scope={scope}
        agent={agent}
        runtime={value}
        issues={[]}
        previews={[]}
        notices={[]}
        onIssue={() => {}}
        onModel={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("RunSummary", () => {
  test("running shows the live state, model chain and queue count", () => {
    const html = renderToStaticMarkup(
      <RunSummary runtime={runtime()} onModel={() => {}} />,
    );

    expect(html).toContain('data-testid="run-summary"');
    expect(html).toContain('data-state="running"');
    expect(html).toContain("正在执行工作");
    expect(html).toContain("LIVE");
    expect(html).toContain("default › host-anthropic › deepseek-v4-flash");
    expect(html).toContain("alias · sonnet");
    expect(html).toContain("运行中");
    expect(html).toContain("2 条");
  });

  test("model detail is an accessible button and the alias renders once", () => {
    const html = renderToStaticMarkup(
      <RunSummary runtime={runtime()} onModel={() => {}} />,
    );

    expect(html).toContain("data-testid=\"model-detail\"");
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="查看模型详情"');
    expect(html).toContain("详情");
    expect(html.match(/alias · sonnet/g)?.length ?? 0).toBe(1);
  });

  test("idle has no LIVE pill, an empty turn and zero queued inputs", () => {
    const html = renderToStaticMarkup(
      <RunSummary runtime={{ configured: true }} onModel={() => {}} />,
    );

    expect(html).toContain('data-state="idle"');
    expect(html).toContain("等待新的输入");
    expect(html).not.toContain("LIVE");
    expect(html).toContain("—");
    expect(html).toContain(">0 条<");
  });

  test("error wins over running and hides LIVE", () => {
    const html = renderToStaticMarkup(
      <RunSummary
        runtime={runtime({ error: "数据库连接失败" })}
        onModel={() => {}}
      />,
    );

    expect(html).toContain('data-state="error"');
    expect(html).toContain("运行出现异常");
    expect(html).toContain("异常");
    expect(html).not.toContain("LIVE");
  });

  test("blocked renders a warning badge and hides LIVE", () => {
    const html = renderToStaticMarkup(
      <RunSummary
        runtime={runtime({
          busy: false,
          running: false,
          activeTurn: null,
          executionBlocked: true,
        })}
        onModel={() => {}}
      />,
    );

    expect(html).toContain('data-state="blocked"');
    expect(html).toContain("执行已阻断");
    expect(html).toContain("已阻断");
    expect(html).not.toContain("LIVE");
  });

  test("queueState.count takes precedence over the raw queue length", () => {
    const html = renderToStaticMarkup(
      <RunSummary
        runtime={runtime({
          queueState: {
            generation: "1",
            revision: 1,
            activeRequestId: null,
            count: 2,
          },
          queue: Array.from({ length: 9 }, (_, index) => index),
        })}
        onModel={() => {}}
      />,
    );

    expect(html).toContain("2 条");
    expect(html).not.toContain("9 条");
  });

  test("run view keeps the unconfigured notice and the error alert", () => {
    const unconfigured = renderRunView(runtime({ configured: false }));
    expect(unconfigured).toContain("模型尚未配置");

    const failed = renderRunView(
      runtime({ busy: false, running: false, error: "执行失败：模型不可用" }),
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("执行失败：模型不可用");
  });

  test("summary exposes the labelled section, LIVE label and hidden turn dot", () => {
    const html = renderToStaticMarkup(
      <RunSummary runtime={runtime()} onModel={() => {}} />,
    );

    expect(html).toContain('aria-labelledby="run-summary-title"');
    expect(html).toContain('id="run-summary-title"');
    expect(html).toContain('aria-label="实时运行中"');
    expect(html).toContain('class="turn-dot" data-tone="accent" aria-hidden="true"');
  });
});
