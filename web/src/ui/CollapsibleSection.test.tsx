import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CollapsibleSection } from "./CollapsibleSection";

const tag = (html: string, testId: string) =>
  html.match(new RegExp(`<[^>]+data-testid="${testId}"[^>]*>`))?.[0] ?? "";

describe("CollapsibleSection", () => {
  test("collapsed by default keeps content in DOM", () => {
    const html = renderToStaticMarkup(
      <CollapsibleSection
        title="评论时间线"
        description="3 条讨论"
        collapsedHeight={240}
        testId="comments"
      >
        <p>内容仍在</p>
      </CollapsibleSection>,
    );
    const trigger = tag(html, "comments-trigger");
    const body = tag(html, "comments-body");

    expect(trigger).toContain('aria-expanded="false"');
    expect(trigger).toContain("aria-controls=");
    expect(body).toContain('data-state="closed"');
    expect(body).toContain("inert");
    expect(body).toContain('aria-hidden="true"');
    expect(html).toContain("内容仍在");
    expect(html).toContain("--collapsible-h:240px");
  });

  test("aria-controls points at the body id", () => {
    const html = renderToStaticMarkup(
      <CollapsibleSection title="描述" testId="description">
        <p>正文</p>
      </CollapsibleSection>,
    );
    const trigger = tag(html, "description-trigger");
    const controls = trigger.match(/aria-controls="([^"]+)"/)?.[1] ?? "";

    expect(controls).not.toBe("");
    expect(tag(html, "description-body")).toContain(`id="${controls}"`);
  });

  test("defaultOpen renders expanded", () => {
    const html = renderToStaticMarkup(
      <CollapsibleSection title="描述" defaultOpen testId="description">
        <p>正文</p>
      </CollapsibleSection>,
    );
    const body = tag(html, "description-body");

    expect(tag(html, "description-trigger")).toContain('aria-expanded="true"');
    expect(body).toContain('data-state="open"');
    expect(body).not.toContain("inert");
    expect(body).not.toContain("aria-hidden");
  });

  test("lockOpen forces open and disables the trigger", () => {
    const html = renderToStaticMarkup(
      <CollapsibleSection title="描述" lockOpen testId="description">
        <p>正文</p>
      </CollapsibleSection>,
    );
    const trigger = tag(html, "description-trigger");

    expect(trigger).toContain("disabled=");
    expect(trigger).toContain('aria-expanded="true"');
    expect(tag(html, "description-body")).not.toContain("inert");
  });

  test("controlled open state wins over the internal state", () => {
    const collapsed = renderToStaticMarkup(
      <CollapsibleSection title="描述" open={false} testId="description">
        <p>正文</p>
      </CollapsibleSection>,
    );
    const expanded = renderToStaticMarkup(
      <CollapsibleSection title="描述" open testId="description">
        <p>正文</p>
      </CollapsibleSection>,
    );

    expect(tag(collapsed, "description-trigger")).toContain(
      'aria-expanded="false"',
    );
    expect(tag(collapsed, "description-body")).toContain("inert");
    expect(tag(expanded, "description-trigger")).toContain(
      'aria-expanded="true"',
    );
    expect(tag(expanded, "description-body")).not.toContain("inert");
  });

  test("actions and footer stay outside the clipped body", () => {
    const html = renderToStaticMarkup(
      <CollapsibleSection
        title="评论时间线"
        testId="comments"
        actions={<button data-testid="edit-description">编辑</button>}
        footer={<span>评论表单</span>}
      >
        <p>正文</p>
      </CollapsibleSection>,
    );
    const actionsIndex = html.indexOf('data-testid="edit-description"');
    const bodyIndex = html.indexOf('data-testid="comments-body"');
    const footerIndex = html.indexOf('data-testid="comments-footer"');

    expect(actionsIndex).toBeGreaterThan(-1);
    expect(bodyIndex).toBeGreaterThan(actionsIndex);
    expect(footerIndex).toBeGreaterThan(bodyIndex);
    expect(tag(html, "comments-footer")).not.toContain("inert");
    expect(html).toContain("评论表单");
  });
});
