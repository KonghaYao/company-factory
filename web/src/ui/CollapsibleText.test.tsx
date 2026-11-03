import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CollapsibleText } from "./CollapsibleText";

const tag = (html: string, testId: string) =>
  html.match(new RegExp(`<[^>]+data-testid="${testId}"[^>]*>`))?.[0] ?? "";

describe("CollapsibleText", () => {
  test("unmeasured collapsed state keeps content without clipping markers", () => {
    const html = renderToStaticMarkup(
      <CollapsibleText open={false} onOpenChange={() => {}} testId="c1">
        <p>未测量的正文</p>
      </CollapsibleText>,
    );
    const root = tag(html, "c1");
    const body = tag(html, "c1-body");

    expect(root).toContain('data-open="false"');
    expect(root).toContain("--collapsible-text-h:136px");
    expect(root).not.toContain("data-overflow");
    expect(body).toContain('data-state="collapsed"');
    expect(html).toContain("未测量的正文");
    expect(tag(html, "c1-toggle")).toBe("");
    expect(body).not.toContain("inert");
    expect(body).not.toContain("aria-hidden");
  });

  test("measured overflow collapsed exposes a full disclosure", () => {
    const html = renderToStaticMarkup(
      <CollapsibleText
        open={false}
        onOpenChange={() => {}}
        overflowing
        contextLabel="开发一号"
        testId="c1"
      >
        <a href="/docs">正文链接</a>
      </CollapsibleText>,
    );
    const toggle = tag(html, "c1-toggle");
    const body = tag(html, "c1-body");
    const controls = toggle.match(/aria-controls="([^"]+)"/)?.[1] ?? "";

    expect(toggle).toContain('aria-expanded="false"');
    expect(toggle).toContain("展开全文");
    expect(toggle).toContain("开发一号");
    expect(controls).not.toBe("");
    expect(body).toContain(`id="${controls}"`);
    expect(body).toContain("inert");
    expect(body).toContain('aria-hidden="true"');
    expect(html).toContain("正文链接");
  });

  test("measured overflow expanded keeps the body interactive", () => {
    const html = renderToStaticMarkup(
      <CollapsibleText
        open
        onOpenChange={() => {}}
        overflowing
        testId="c1"
      >
        <p>已展开的正文</p>
      </CollapsibleText>,
    );
    const toggle = tag(html, "c1-toggle");
    const body = tag(html, "c1-body");

    expect(toggle).toContain('aria-expanded="true"');
    expect(toggle).toContain("收起");
    expect(body).toContain('data-state="expanded"');
    expect(body).not.toContain("inert");
    expect(body).not.toContain("aria-hidden");
    expect(html).toContain("已展开的正文");
  });

  test("short content never renders a toggle and stays visible", () => {
    const html = renderToStaticMarkup(
      <CollapsibleText
        open={false}
        onOpenChange={() => {}}
        overflowing={false}
        testId="c1"
      >
        <p>短评论</p>
      </CollapsibleText>,
    );
    const body = tag(html, "c1-body");

    expect(tag(html, "c1-toggle")).toBe("");
    expect(tag(html, "c1")).toContain('data-overflow="false"');
    expect(body).toContain('data-state="expanded"');
    expect(body).not.toContain("inert");
    expect(body).not.toContain("aria-hidden");
    expect(html).toContain("短评论");
  });

  test("locked forces expansion and removes the toggle", () => {
    const html = renderToStaticMarkup(
      <CollapsibleText
        open={false}
        locked
        onOpenChange={() => {}}
        overflowing
        testId="c1"
      >
        <textarea defaultValue="编辑中" />
      </CollapsibleText>,
    );
    const root = tag(html, "c1");
    const body = tag(html, "c1-body");

    expect(root).toContain('data-locked="true"');
    expect(root).toContain('data-open="true"');
    expect(body).toContain('data-state="expanded"');
    expect(tag(html, "c1-toggle")).toBe("");
    expect(body).not.toContain("inert");
    expect(body).not.toContain("aria-hidden");
  });

  test("custom collapsed height is exposed as a CSS variable", () => {
    const html = renderToStaticMarkup(
      <CollapsibleText
        open={false}
        onOpenChange={() => {}}
        collapsedHeight={200}
        testId="c1"
      >
        <p>正文</p>
      </CollapsibleText>,
    );

    expect(tag(html, "c1")).toContain("--collapsible-text-h:200px");
  });

  test("test ids are derived for root, body and toggle", () => {
    const html = renderToStaticMarkup(
      <CollapsibleText
        open={false}
        onOpenChange={() => {}}
        overflowing
        testId="c1"
      >
        <p>正文</p>
      </CollapsibleText>,
    );

    expect(tag(html, "c1")).not.toBe("");
    expect(tag(html, "c1-body")).not.toBe("");
    expect(tag(html, "c1-toggle")).not.toBe("");
  });
});
