import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent } from "../../lib/types";
import { ChatHeader } from "./ChatHeader";

function render(agent: Agent): string {
  return renderToStaticMarkup(
    <ChatHeader
      agent={agent}
      needsUser={false}
      onRestart={() => {}}
      restarting={false}
    />,
  );
}

describe("ChatHeader", () => {
  test("uses the member color on the header avatar", () => {
    const html = render({
      agentId: "agent-1",
      name: "开发一号",
      role: "developer",
      avatarColor: "teal",
    });

    expect(html).toContain('data-avatar-color="teal"');
    expect(html).toContain("avatar-md");
    expect(html).toContain("开发一号");
  });

  test("legacy members without a color keep the default avatar", () => {
    const html = render({
      agentId: "agent-2",
      name: "旧成员",
      role: "developer",
    });

    expect(html).not.toContain("data-avatar-color");
    expect(html).toContain("avatar-agent avatar-md");
  });
});
