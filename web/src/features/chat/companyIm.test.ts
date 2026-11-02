import { describe, expect, test } from "bun:test";
import { parseCompanyImMessage } from "./companyIm";

const sender = "c-77ac-supervisor";

describe("parseCompanyImMessage", () => {
  test("解析新的单信封格式", () => {
    const message = parseCompanyImMessage(
      `[Company IM T2/M2 from ${sender}]
Read the original via company_im.thread before replying.

请确认交付窗口。`,
    );

    expect(message).toEqual({
      threadId: "T2",
      messageId: "M2",
      senderId: sender,
      body: "请确认交付窗口。",
      degraded: false,
    });
  });

  test("解析旧的双信封格式并剥离两层机器头", () => {
    const message = parseCompanyImMessage(
      `[Company IM T2/M2]
Company IM T2/M2 from ${sender}
Read the original via company_im.thread before replying.

请确认交付窗口。`,
    );

    expect(message).toEqual({
      threadId: "T2",
      messageId: "M2",
      senderId: sender,
      body: "请确认交付窗口。",
      degraded: false,
    });
  });

  test("解析没有方括号的旧 domain-only 格式", () => {
    const message = parseCompanyImMessage(
      `Company IM T2/M2 from ${sender}
Read the original via company_im.thread before replying.

请确认交付窗口。`,
    );

    expect(message).toEqual({
      threadId: "T2",
      messageId: "M2",
      senderId: sender,
      body: "请确认交付窗口。",
      degraded: false,
    });
  });

  test("半截标题仍返回可渲染的降级结果，sender 未知", () => {
    const message = parseCompanyImMessage(
      `[Company IM T2/M2
Read the original via company_im.thread before replying.

需要人工确认。`,
    );

    expect(message).toEqual({
      threadId: "T2",
      messageId: "M2",
      senderId: null,
      body: "需要人工确认。",
      degraded: true,
    });
  });

  test("正文中的 Company IM 引用原样保留", () => {
    const body = `请参考下面这条引用：

[Company IM T9/M9 from another-agent]
这是正文里的引用，不是新信封。`;
    const message = parseCompanyImMessage(
      `[Company IM T2/M2 from ${sender}]
Read the original via company_im.thread before replying.

${body}`,
    );

    expect(message?.body).toBe(body);
    expect(message?.threadId).toBe("T2");
    expect(message?.messageId).toBe("M2");
  });

  test("正文里的代码块完整保留", () => {
    const body = "请按这个片段处理：\n\n```ts\nconst answer = 42;\nif (answer) {\n  return \"ok\";\n}\n```";
    const message = parseCompanyImMessage(
      `[Company IM T2/M2 from ${sender}]
Read the original via company_im.thread before replying.

${body}`,
    );

    expect(message?.body).toBe(body);
  });

  test("普通人类文本不匹配", () => {
    expect(parseCompanyImMessage("你好，帮我确认下 T2/M2 的进度。")).toBeNull();
    expect(parseCompanyImMessage("Company IM is a product name.")).toBeNull();
  });

  test("Company IM 出现在正文中间不匹配", () => {
    expect(
      parseCompanyImMessage(
        `先看这一条：\n[Company IM T2/M2 from ${sender}]\nRead the original via company_im.thread before replying.`,
      ),
    ).toBeNull();
  });

  test("Company Issue context 不被当成 IM 信封", () => {
    expect(
      parseCompanyImMessage(
        "[Company Issue context: issue-1; same fixed Session]\n\n继续处理。",
      ),
    ).toBeNull();
  });

  test("重复的 domain 头也被剥离", () => {
    const message = parseCompanyImMessage(
      `[Company IM T2/M2]
Company IM T2/M2 from ${sender}
Company IM T2/M2 from ${sender}
Read the original via company_im.thread before replying.

请确认交付窗口。`,
    );

    expect(message?.senderId).toBe(sender);
    expect(message?.body).toBe("请确认交付窗口。");
  });

  test("没有机器指令时仍能从信封后提取正文", () => {
    const message = parseCompanyImMessage(
      `[Company IM T2/M2 from ${sender}]
直接开始的正文`,
    );

    expect(message?.body).toBe("直接开始的正文");
    expect(message?.degraded).toBe(false);
  });
});
