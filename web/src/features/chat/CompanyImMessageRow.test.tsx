import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Entry } from "../../peri/chat/runtime";
import {
  UserMessagePresentationContext,
  UserMessageRow,
} from "../../peri/chat/timeline/rows/UserMessageRow";
import { CompanyImMessageRow, shortSenderId } from "./CompanyImMessageRow";
import { parseCompanyImMessage } from "./companyIm";

const sender = "c-77ac-supervisor";

function entry(text: string): Entry {
  return {
    entryId: "entry-1",
    id: "entry-1",
    kind: "message",
    turnId: "turn-1",
    role: "user",
    status: "completed",
    createdAt: null,
    createdAtSource: "local",
    completedAt: null,
    error: null,
    blocks: [{ blockId: "block-1", type: "text", text }],
  };
}

function envelope(text: string) {
  const message = parseCompanyImMessage(text);
  if (!message) throw new Error("expected a Company IM envelope");
  return message;
}

describe("CompanyImMessageRow", () => {
  test("渲染发送者、角色和话题，不显示“你”与机器头", () => {
    const message = envelope(
      `[Company IM T2/M2]
Company IM T2/M2 from ${sender}
Read the original via company_im.thread before replying.

请确认交付窗口。`,
    );
    const html = renderToStaticMarkup(
      <CompanyImMessageRow
        message={message}
        sender={{ name: "任务主管", role: "task-supervisor" }}
        thread={{ id: "T2", subject: "交付范围" }}
      />,
    );

    expect(html).toContain("来自 任务主管");
    expect(html).toContain("任务主管");
    expect(html).toContain("T2 · 交付范围");
    expect(html).toContain("请确认交付窗口。");
    expect(html).toContain('data-slot="peri-company-im-message"');
    expect(html).toContain('data-im-thread="T2"');
    expect(html).toContain('data-im-message="M2"');
    expect(html).toContain(`data-im-sender="${sender}"`);
    expect(html).toContain("max-w-[85%]");
    expect(html).not.toContain("items-end");
    expect(html).not.toContain("你");
    expect(html).not.toContain("[Company IM");
    expect(html).not.toContain("Read the original");
  });

  test("sender 无法解析时显示短 ID，而不是“你”", () => {
    const message = envelope(
      `[Company IM T2/M2 from ${sender}]
Read the original via company_im.thread before replying.

请确认。`,
    );
    const html = renderToStaticMarkup(<CompanyImMessageRow message={message} />);

    expect(html).toContain(`来自 ${sender}`);
    expect(html).toContain(`data-im-sender="${sender}"`);
    expect(html).not.toContain("你");
  });

  test("降级信封显示未知成员，保留可渲染正文", () => {
    const message = envelope(
      `[Company IM T2/M2
Read the original via company_im.thread before replying.

需要人工确认。`,
    );
    const html = renderToStaticMarkup(<CompanyImMessageRow message={message} />);

    expect(message.degraded).toBe(true);
    expect(html).toContain("来自 未知成员");
    expect(html).toContain("需要人工确认。");
    expect(html).toContain('data-im-degraded="true"');
    expect(html).not.toContain("你");
  });

  test("多行正文与代码块以纯文本保留，长文本可换行", () => {
    const text = "第一行\n第二行\n```ts\nconst answer = 42;\n```";
    const message = envelope(
      `[Company IM T2/M2 from ${sender}]
Read the original via company_im.thread before replying.

${text}`,
    );
    const html = renderToStaticMarkup(<CompanyImMessageRow message={message} />);

    expect(html).toContain("第一行\n第二行");
    expect(html).toContain("const answer = 42;");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("[overflow-wrap:anywhere]");
  });

  test("普通人类消息仍走 Peri 原用户气泡", () => {
    const html = renderToStaticMarkup(
      <UserMessagePresentationContext.Provider
        value={(value) => {
          const message = parseCompanyImMessage(
            value.blocks
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n"),
          );
          return message ? <CompanyImMessageRow message={message} /> : null;
        }}
      >
        <UserMessageRow entry={entry("帮我看看这个需求。")} />
      </UserMessagePresentationContext.Provider>,
    );

    expect(html).toContain('data-slot="peri-user-message"');
    expect(html).toContain("帮我看看这个需求。");
    expect(html).toContain("你");
    expect(html).not.toContain('data-slot="peri-company-im-message"');
  });

  test("短 ID 只截断超长 sender", () => {
    expect(shortSenderId("c-short-supervisor")).toBe("c-short-supervisor");
    expect(shortSenderId("c-1234567890abcdefghijklmnopqrstuvwxyz")).toBe(
      "c-1234567890abcd…stuvwxyz",
    );
  });
});
