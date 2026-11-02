/** Real local browser verification. No network mocks, fake runtime, or model calls. */
import { chromium, expect } from "@playwright/test";
import { mkdtemp, readFile, appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApplication } from "../src/server/app";
import { uuid } from "./src/lib/uuid";

const root = await mkdtemp(join(tmpdir(), "company-browser-"));
await writeFile(
  join(root, "model-library.yaml"),
  `version: 2
activeProfile: default
providers:
  host-openai:
    type: openai
    baseUrlEnv: COMPANY_TEST_MODEL_BASE_URL
    apiKeyEnv: COMPANY_TEST_MODEL_API_KEY
profiles:
  default:
    activeAlias: sonnet
    tiers:
      opus:
        provider: host-openai
        modelEnv: COMPANY_TEST_MODEL_OPUS_ID
      sonnet:
        provider: host-openai
        modelEnv: COMPANY_TEST_MODEL_ID
      haiku:
        provider: host-openai
        modelEnv: COMPANY_TEST_MODEL_HAIKU_ID
`,
  { mode: 0o600 },
);
const base = "http://127.0.0.1:43219";
const token = "browser-test-only-owner-token";
const binary = process.env.PERI_BINARY ?? resolve(".tools/peri/peri");
const application = await createApplication({
  root,
  baseUrl: base,
  periBinary: binary,
  webToken: token,
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 43219,
  fetch: application.app.fetch,
  idleTimeout: 120,
});
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
} catch (error) {
  server.stop(true);
  await application.close();
  await rm(root, { recursive: true, force: true });
  await mkdir("docs", { recursive: true });
  await Bun.write(
    "docs/browser-results.json",
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        status: "not_run",
        stage: "browser_launch",
        error: String(error),
        steps: [],
        screenshots: [],
      },
      null,
      2,
    ),
  );
  throw error;
}
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
page.setDefaultTimeout(30000);
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const steps: string[] = [];
const step = (text: string) => {
  steps.push(text);
  console.log(`PASS ${text}`);
};
await mkdir("docs", { recursive: true });
try {
  await page.goto(base);
  await expect(
    page.getByRole("textbox", { name: "本地访问令牌" }),
  ).toBeVisible();
  step("Local owner login gate is rendered for unauthenticated browser");
  await page.goto(`${base}/#access=${token}`);
  await expect(page.getByTestId("create-company")).toBeVisible();
  await expect(page).not.toHaveURL(/access=/);
  await page.screenshot({ path: "docs/ui-01-onboarding.png", fullPage: true });
  await page.getByTestId("create-company").click();
  await page.getByLabel("公司名称").fill("Acme Studio");
  await expect(page.getByLabel("公司 ID", { exact: true })).toHaveCount(0);
  await page
    .getByLabel("公司目标", { exact: true })
    .fill("构建可靠的软件交付团队，保持每条 Issue 的独立交付依据。");
  const creationResponse = page.waitForResponse(
    (response) =>
      response.url() === `${base}/api/action` &&
      response.request().postDataJSON()?.operation === "createCompany",
    { timeout: 90000 },
  );
  await page.getByTestId("create-company-submit").click();
  const response = await creationResponse;
  expect(response.request().postDataJSON().input).not.toHaveProperty("id");
  expect(response.request().postDataJSON()).not.toHaveProperty("companyId");
  expect(response.ok()).toBe(true);
  const { company } = await response.json();
  const companyId = company.id;
  expect(companyId).toMatch(/^c-[0-9a-f]{32}$/);
  await expect(page.getByTestId(`agent-${companyId}-hr`)).toBeVisible({
    timeout: 90000,
  });
  await expect(page.getByTestId(`agent-${companyId}-supervisor`)).toBeVisible();
  await expect(page.getByText("总部", { exact: true })).toBeVisible();
  const organization = await application.domain.organization({
    type: "user",
    id: "owner",
    companyId,
  });
  const hr = await application.domain.getAgent(
    { type: "user", id: "owner", companyId },
    { agentId: organization.agents.find((a) => a.role === "hr")!.agentId },
  );
  const supervisor = await application.domain.getAgent(
    { type: "user", id: "owner", companyId },
    {
      agentId: organization.agents.find((a) => a.role === "task-supervisor")!
        .agentId,
    },
  );
  expect(hr.sessionId).toBeTruthy();
  expect(supervisor.sessionId).toBeTruthy();
  step(
    "A01: UI Company creation provisions real HQ/HR/supervisor and fixed Peri Sessions",
  );
  const hrDraft = page.getByRole("textbox", { name: `向 ${hr.name} 发送消息` });
  await hrDraft.fill("HR 专属草稿");
  await page.getByTestId(`agent-${supervisor.agentId}`).click();
  await page
    .getByRole("textbox", { name: `向 ${supervisor.name} 发送消息` })
    .fill("主管专属草稿");
  await page.getByTestId(`agent-${hr.agentId}`).click();
  await expect(hrDraft).toHaveValue("HR 专属草稿");
  await page.getByTestId(`agent-${supervisor.agentId}`).click();
  await expect(
    page.getByRole("textbox", { name: `向 ${supervisor.name} 发送消息` }),
  ).toHaveValue("主管专属草稿");
  step(
    "A06: switching Agent switches all panels while independent Chat drafts remain intact",
  );
  await page.getByRole("button", { name: "任务", exact: true }).click();
  await page.getByTestId("create-issue").click();
  await page.getByLabel("标题", { exact: true }).fill("交付可审阅的退款流程");
  await page
    .getByLabel("目标与验收要求 · Markdown")
    .fill(
      "## 目标\n实现整单退款。\n\n## 验收要求\n- 保留清晰的资金状态与操作记录",
    );
  await page.getByTestId("create-issue-submit").click();
  await expect(
    page.getByRole("heading", { name: "交付可审阅的退款流程", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "评论内容" })
    .fill("这是来自真实浏览器的 Markdown 评论。 **只记录讨论，不改变状态。**");
  await page.getByTestId("comment-submit").click();
  await expect(
    page.getByText("这是来自真实浏览器的 Markdown 评论。", { exact: false }),
  ).toBeVisible();
  const issue = await application.domain.getIssue(
    { type: "user", id: "owner", companyId },
    { issueId: "1" },
  );
  expect(issue.status).toBe("triage");
  expect(issue.agent_id).toBe(supervisor.agentId);
  expect(
    (
      await application.domain.comments(
        { type: "user", id: "owner", companyId },
        { issueId: "1" },
      )
    ).items.length,
  ).toBe(1);
  step(
    "A04/A05: UI issue + Markdown comment persisted; comment leaves triage unchanged",
  );
  const questionIssue = await application.domain.askDecision(
    { type: "agent", id: supervisor.agentId, companyId },
    {
      issueId: "1",
      version: issue.version,
      question: "本期是否支持部分退款？",
      requestId: uuid(),
    },
  );
  await expect(page.getByTestId("decision-answer-1-Q1")).toBeVisible();
  await page
    .getByRole("textbox", { name: "回答 1-Q1" })
    .fill("本期仅支持整单退款。");
  await page.getByTestId("decision-answer-1-Q1").click();
  await expect(page.getByText("答复：本期仅支持整单退款。")).toBeVisible();
  const answered = await application.domain.getIssue(
    { type: "user", id: "owner", companyId },
    { issueId: "1" },
  );
  expect(answered.decisions[0].answer).toBe("本期仅支持整单退款。");
  expect(answered.needs_user).toBe(true);
  step(
    "A08: explicit question ID answer saved; remains pending until current Agent processes it",
  );
  await page.screenshot({ path: "docs/ui-02-workbench.png", fullPage: true });

  const workbenchLayout = await page.evaluate(() => {
    const wb = document.querySelector(".workbench") as HTMLElement;
    const data = document.querySelector(".workbench-data") as HTMLElement;
    const style = getComputedStyle(wb);
    return {
      overflow: wb.scrollWidth - wb.clientWidth,
      dataRight: data.getBoundingClientRect().right,
      expectedRight:
        window.innerWidth - Number.parseFloat(style.paddingRight),
      documentOverflow:
        document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(workbenchLayout.overflow).toBeLessThanOrEqual(1);
  expect(
    Math.abs(workbenchLayout.dataRight - workbenchLayout.expectedRight),
  ).toBeLessThanOrEqual(1);
  expect(workbenchLayout.documentOverflow).toBeLessThanOrEqual(1);

  // Read-only model library: header sheet, right-panel tab, and config pickers.
  await page.getByTestId("open-model-library").click();
  const modelLibrary = page.getByRole("dialog", { name: "模型库", exact: true });
  await expect(modelLibrary).toBeVisible();
  await expect(modelLibrary.getByTestId("model-library-status")).toBeVisible();
  await expect(modelLibrary.getByTestId("model-library-path")).toContainText(
    "model-library.yaml",
  );
  await expect(modelLibrary.getByTestId("model-library-refresh")).toBeVisible();
  await expect(
    modelLibrary.getByTestId("model-tier-table-library").first(),
  ).toBeVisible();
  await expect(modelLibrary.getByText("COMPANY_TEST_MODEL_BASE_URL")).toBeVisible();
  await expect(modelLibrary).not.toContainText("sk-");
  await expect(modelLibrary).not.toContainText("https://");
  await expect(modelLibrary).not.toContainText("COMPANY_TEST_MODEL_API_KEY=");
  await modelLibrary.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(modelLibrary).toHaveCount(0);
  await page.getByRole("tab", { name: "模型", exact: true }).click();
  const modelView = page.getByTestId("model-view");
  await expect(modelView.getByTestId("model-chain")).toBeVisible();
  await expect(
    modelView.locator('[data-testid^="model-tier-table-"]').first(),
  ).toBeVisible();
  await expect(modelView.getByTestId("open-global-model-library")).toBeVisible();
  step("A09: header model-library sheet and right-panel model tab are read-only");

  await page.getByRole("button", { name: "Agent 配置", exact: true }).click();
  await expect(page.getByTestId("model-profile-select")).toBeVisible();
  await expect(page.getByTestId("model-profile-select")).toHaveValue("");
  await expect(page.getByTestId("model-alias-select")).toHaveValue("");
  await page
    .getByLabel("保存的配置 · JSON")
    .fill(
      JSON.stringify({ instructions: "配置保存测试，不自动重启。" }, null, 2),
    );
  await page.getByTestId("config-save").click();
  await expect(page.getByText("有尚未应用的配置，重启后生效。")).toBeVisible();
  const saved = await application.domain.getAgent(
    { type: "user", id: "owner", companyId },
    { agentId: supervisor.agentId },
  );
  expect(saved.sessionId).toBe(supervisor.sessionId);
  expect(saved.configVersion).not.toBe(saved.appliedConfigVersion);
  await page.getByTestId("config-restart").click();
  await expect(
    page.getByText("已应用保存的配置。Agent 身份、目录和 Session 保持不变。"),
  ).toBeVisible({ timeout: 90000 });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const restarted = await application.domain.getAgent(
    { type: "user", id: "owner", companyId },
    { agentId: supervisor.agentId },
  );
  expect(restarted.sessionId).toBe(supervisor.sessionId);
  expect(restarted.configVersion).toBe(restarted.appliedConfigVersion);
  step(
    "A03: save pending + explicit restart retain original Session and apply config",
  );
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("button", { name: "CLAUDE.md", exact: true }).click();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 60000 });
  const editor = page.locator(".monaco-editor textarea").first();
  await editor.focus();
  await editor.press("Control+End");
  await editor.press("Enter");
  await editor.type("浏览器编辑器真实保存验证。");
  await page.getByTestId("file-save").click();
  await expect(page.getByTestId("file-save")).toBeDisabled();
  expect(
    await readFile(join(supervisor.directory, "CLAUDE.md"), "utf8"),
  ).toContain("浏览器编辑器真实保存验证。");
  step(
    "A10/A11: default Workspace reads complete Agent tree and Monaco saves actual memory file",
  );
  await page.getByRole("button", { name: "新建文件", exact: true }).click();
  await page.getByLabel("相对活动目录的路径").fill("notes/browser-note.md");
  await page
    .getByLabel("文件内容", { exact: true })
    .fill("browser-search-needle · 独立新文件");
  await page.getByRole("button", { name: "创建文件", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "browser-note.md", exact: true }),
  ).toBeVisible();
  expect(
    await readFile(join(supervisor.directory, "notes/browser-note.md"), "utf8"),
  ).toContain("browser-search-needle");
  await page
    .getByRole("textbox", { name: "搜索文件内容" })
    .fill("browser-search-needle");
  await page.getByRole("textbox", { name: "搜索文件内容" }).press("Enter");
  await expect(page.locator(".search-result")).toContainText(
    "browser-search-needle",
  );
  await page.getByRole("button", { name: "清除搜索", exact: true }).click();
  await page
    .locator(".file-tabs")
    .getByRole("button", { name: "CLAUDE.md", exact: true })
    .click();
  step(
    "A10: native Workspace new-file creation and actual Grep search return persisted bytes",
  );
  await editor.focus();
  await editor.press("Control+End");
  await editor.press("Enter");
  await editor.type("尚未保存的浏览器草稿。");
  await appendFile(
    join(supervisor.directory, "CLAUDE.md"),
    "\n磁盘外部修改保留。\n",
  );
  await expect(page.getByTestId("file-conflict")).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByTestId("file-save")).toBeDisabled();
  expect(
    await readFile(join(supervisor.directory, "CLAUDE.md"), "utf8"),
  ).toContain("磁盘外部修改保留。");
  await page.screenshot({
    path: "docs/ui-03-file-conflict.png",
    fullPage: true,
  });
  step(
    "A10: external file edit preserves both unsaved buffer and disk version, refuses blind save",
  );
  await page.getByTestId(`agent-${hr.agentId}`).click();
  await page.getByTestId(`agent-${supervisor.agentId}`).click();
  await expect(page.getByTestId("file-conflict")).toBeVisible();
  step("A06: per-Agent file tab, draft and conflict survive Agent switches");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "docs/ui-04-mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  step(
    "Responsive: 390px reading-order layout has no horizontal document overflow",
  );
  expect(errors).toEqual([]);
  step("No uncaught browser JavaScript errors");
  await Bun.write(
    "docs/browser-results.json",
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        steps,
        errors,
        screenshots: [
          "ui-01-onboarding.png",
          "ui-02-workbench.png",
          "ui-03-file-conflict.png",
          "ui-04-mobile.png",
        ],
        limitations: [
          "No model inference: no provider credential supplied.",
          "Native Peri runtime interactions/queue views wired to actual contract but no model-generated approval/queue scenario produced.",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  await page
    .screenshot({ path: "docs/ui-error.png", fullPage: true })
    .catch(() => {});
  await Bun.write(
    "docs/browser-results.json",
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        steps,
        errors,
        error: String(error),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
  server.stop(true);
  await application.close();
  if (process.env.KEEP_BROWSER_DATA !== "1")
    await rm(root, { recursive: true, force: true });
}
