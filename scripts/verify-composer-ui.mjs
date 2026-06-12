import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:43115";
const outputDir = process.argv[3] ?? path.join(tmpdir(), "deepseek-forge-composer-ui");

await mkdir(outputDir, { recursive: true });
const uploadDir = await mkdtemp(path.join(tmpdir(), "deepseek-forge-upload-"));
const uploadFile = path.join(uploadDir, "composer-fixture.txt");
await writeFile(uploadFile, "DeepSeek-Forge composer upload fixture\n", "utf8");

const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});

const views = [
  { name: "desktop", viewport: { width: 1440, height: 980 } },
  { name: "mobile", viewport: { width: 390, height: 844 } },
];

const results = [];

async function ensureSession(page, title) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate(async (sessionTitle) => {
    const tokenKey = "forgeagent.web.token";
    const jsonFetch = async (url, init = {}) => {
      const response = await fetch(url, init);
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(data?.error ?? `${response.status} ${response.statusText}`);
      }
      return data;
    };
    let token = localStorage.getItem(tokenKey);
    if (!token) {
      const code = await jsonFetch("/auth/pairing-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: window.location.origin }),
      });
      const paired = await jsonFetch("/auth/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.code, name: "Composer UI verifier", kind: "web" }),
      });
      token = paired.token;
      localStorage.setItem(tokenKey, token);
    }
    const headers = {
      "Accept": "application/json",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-DeepSeek-Forge-API": "1",
    };
    const session = await jsonFetch("/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: sessionTitle }),
    });
    await jsonFetch("/device-state", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ selectedSessionId: session.id }),
    });
    return session.id;
  }, title);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".composer").waitFor({ state: "visible", timeout: 15_000 });
}

async function tooltipState(page, action) {
  const target = page.locator(`[data-composer-action="${action}"]`);
  await expectOne(target, `tooltip ${action}`);
  await target.hover();
  await page.waitForTimeout(180);
  return target.evaluate((node) => {
    const style = window.getComputedStyle(node, "::after");
    return {
      content: style.content.replace(/^"|"$/g, ""),
      opacity: Number(style.opacity),
      rect: node.getBoundingClientRect().toJSON(),
    };
  });
}

async function expectOne(locator, label) {
  const count = await locator.count();
  assert.equal(count, 1, `${label} should resolve to exactly one element, found ${count}`);
}

async function buttonFor(page, action) {
  const button = page.locator(`[data-composer-action="${action}"] button`);
  await expectOne(button, `button ${action}`);
  return button;
}

async function verifyView(view) {
  const context = await browser.newContext({
    viewport: view.viewport,
    permissions: ["microphone"],
    colorScheme: "light",
  });
  const page = await context.newPage();
  const report = { view: view.name, tooltips: {}, states: [] };
  try {
    await ensureSession(page, `Composer UI ${view.name}`);

    for (const [action, expected] of [
      ["attach", "Attach local files"],
      ["danger-free", "Bypass approval prompts"],
      ["autopilot", "Grant workspace edits"],
      ["review-work", "Open the work review panel"],
      ["voice-input", "Record voice input"],
      ["send", "Type a message or attach a file"],
    ]) {
      const state = await tooltipState(page, action);
      assert(state.opacity > 0.8, `${view.name} ${action} tooltip should be visible on hover`);
      assert(state.content.includes(expected), `${view.name} ${action} tooltip should explain action`);
      report.tooltips[action] = state.content;
    }

    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      (await buttonFor(page, "attach")).click(),
    ]);
    await chooser.setFiles(uploadFile);
    await page.locator(".attachment-chip").filter({ hasText: "composer-fixture.txt" }).waitFor({ state: "visible" });
    report.states.push("attach chip visible");

    await (await buttonFor(page, "danger-free")).click();
    await page.getByText("Bypass approvals?", { exact: true }).waitFor({ state: "visible" });
    const confirmTooltip = await tooltipState(page, "danger-enable");
    assert(confirmTooltip.content.includes("Enable approval bypass"), `${view.name} danger enable tooltip should explain action`);
    await (await buttonFor(page, "danger-cancel")).click();
    await page.getByText("Bypass approvals?", { exact: true }).waitFor({ state: "hidden" });
    report.states.push("danger cancel hides confirmation");

    await (await buttonFor(page, "danger-free")).click();
    await (await buttonFor(page, "danger-enable")).click();
    await page.getByText("Danger free: on", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("Danger free is on for this session.", { exact: true }).waitFor({ state: "visible" });
    report.states.push("danger enable updates session state");

    await (await buttonFor(page, "autopilot")).click();
    await page.getByText("Autopilot: on", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("Workspace autopilot is on for edits and safe checks.", { exact: true }).waitFor({ state: "visible" });
    const autopilotOnTooltip = await tooltipState(page, "autopilot");
    assert(autopilotOnTooltip.content.includes("Turn off automatic approval"), `${view.name} autopilot tooltip should explain disable action`);
    assert.equal(
      await page.locator(".thread .note-line").filter({ hasText: "Permission:" }).count(),
      0,
      `${view.name} permission grants should stay out of the main thread`,
    );
    report.states.push("autopilot enables and main thread stays quiet");

    await (await buttonFor(page, "autopilot")).click();
    await page.waitForFunction(() =>
      document.querySelector('[data-composer-action="autopilot"] button')?.textContent?.trim() === "Autopilot",
    );
    await page.getByText("Workspace autopilot is off. Workspace edits and safe checks will ask for approval again.", { exact: true }).waitFor({ state: "visible" });
    const autopilotOffTooltip = await tooltipState(page, "autopilot");
    assert(autopilotOffTooltip.content.includes("Grant workspace edits"), `${view.name} autopilot tooltip should explain enable action after disabling`);
    report.states.push("autopilot disables and restores off state");

    await (await buttonFor(page, "review-work")).click();
    await page.locator(".status-drawer").waitFor({ state: "visible" });
    await page.getByLabel("Close status details").click();
    await page.locator(".status-drawer").waitFor({ state: "hidden" });
    report.states.push("review panel opens");

    await page.route(/\/sessions\/[^/]+\/messages$/, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Composer verifier blocked send before provider call." }),
      });
    });
    await page.getByPlaceholder("Ask DeepSeek-Forge anything…").fill("Composer UI send verification");
    await (await buttonFor(page, "send")).click();
    await page.waitForFunction(() => {
      const text = document.body.textContent ?? "";
      return text.includes("Configure DeepSeek before sending a message.") ||
        text.includes("Composer verifier blocked send before provider call.");
    });
    const sendReadyTooltip = await tooltipState(page, "send");
    assert(sendReadyTooltip.content.includes("Send the current message"), `${view.name} send tooltip should update when composer has content`);
    report.states.push("send surfaces provider configuration error without sending");

    const voiceButton = await buttonFor(page, "voice-input");
    await voiceButton.click();
    await page.locator(".voice-input-button.recording").waitFor({ state: "visible", timeout: 10_000 });
    const voiceStopTooltip = await tooltipState(page, "voice-input");
    assert(voiceStopTooltip.content.includes("Stop recording"), `${view.name} voice tooltip should update while recording`);
    report.states.push("voice recording state visible");

    await page.screenshot({ path: path.join(outputDir, `${view.name}-composer-after.png`), fullPage: false });
    await page.locator('[data-composer-action="send"]').hover();
    await page.waitForTimeout(180);
    await page.screenshot({ path: path.join(outputDir, `${view.name}-composer-send-tooltip.png`), fullPage: false });
    return report;
  } finally {
    await context.close();
  }
}

try {
  for (const view of views) {
    results.push(await verifyView(view));
  }
  console.log(JSON.stringify({ ok: true, outputDir, results }, null, 2));
} finally {
  await browser.close();
}
