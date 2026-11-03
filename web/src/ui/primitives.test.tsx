import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar } from "./primitives";

const tag = (html: string) =>
  html.match(/<span[^>]*class="avatar[^"]*"[^>]*>/)?.[0] ?? "";

describe("Avatar", () => {
  test("agent avatar exposes a valid palette id and keeps its base classes", () => {
    const html = renderToStaticMarkup(<Avatar name="开发一号" color="rose" />);
    const rendered = tag(html);

    expect(rendered).toContain('data-avatar-color="rose"');
    expect(rendered).toContain("avatar-agent");
    expect(rendered).toContain("avatar-sm");
    expect(rendered).toContain('aria-hidden="true"');
    expect(html).toContain("开");
  });

  test("unknown, empty or non-string colors are ignored", () => {
    for (const color of ["chartreuse", "#fff", "", null, undefined, 42, {}]) {
      const html = renderToStaticMarkup(
        <Avatar name="开发一号" color={color as never} />,
      );

      expect(tag(html)).not.toContain("data-avatar-color");
      expect(html).toContain("avatar-agent");
    }
  });

  test("legacy agents without a color render the default agent avatar", () => {
    const html = renderToStaticMarkup(<Avatar name="旧成员" />);

    expect(tag(html)).not.toContain("data-avatar-color");
    expect(tag(html)).toContain("avatar-agent avatar-sm");
    expect(html).toContain("旧");
  });

  test("user avatars never take a member color", () => {
    const html = renderToStaticMarkup(
      <Avatar name="开发一号" tone="user" color="rose" />,
    );

    expect(tag(html)).not.toContain("data-avatar-color");
    expect(tag(html)).toContain("avatar-user");
    expect(html).toContain("我");
    expect(html).not.toContain("开");
  });

  test("system avatars never take a member color", () => {
    const html = renderToStaticMarkup(
      <Avatar name="系统" tone="system" color="teal" size="xs" />,
    );

    expect(tag(html)).not.toContain("data-avatar-color");
    expect(tag(html)).toContain("avatar-system avatar-xs");
  });
});
