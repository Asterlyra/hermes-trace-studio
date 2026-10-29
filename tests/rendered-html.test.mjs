import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Hermes Trace Studio shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Hermes Trace Studio<\/title>/i);
  assert.match(html, /Hermes Trace/);
  assert.match(html, /看清 Hermes/);
  assert.match(html, /本地存储/);
  assert.match(html, /三步开始观察一条 Hermes 请求/);
  assert.match(html, /时间线与流程图/);
  assert.match(html, /Prompt 分层/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("removes the disposable starter and declares the local trace runtime", async () => {
  const [page, layout, packageJson, server] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(page, /TraceDashboard/);
  assert.match(layout, /Hermes Trace Studio/);
  assert.match(packageJson, /"name": "hermes-trace-studio"/);
  assert.match(packageJson, /server\/index\.mjs/);
  assert.match(server, /127\.0\.0\.1/);
  assert.match(server, /\/api\/hermes\/turns/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});

test("declares visual overview, call log, and structured event details", async () => {
  const [dashboard, analysisStyles] = await Promise.all([
    readFile(new URL("../app/trace-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/analysis-views.css", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /主流程摘要/);
  assert.match(dashboard, /事件类型分布/);
  assert.match(dashboard, /耗时最长的环节/);
  assert.match(dashboard, /工具与外部调用/);
  assert.match(dashboard, /function StructuredData/);
  assert.match(dashboard, /开发者原始 JSON/);
  assert.match(analysisStyles, /\.distribution-donut/);
  assert.match(analysisStyles, /\.calls-table/);
  assert.match(analysisStyles, /\.structured-fields/);
});

test("moves workspace actions into a collapsible sidebar and collapses trace summary", async () => {
  const [dashboard, shellStyles] = await Promise.all([
    readFile(new URL("../app/trace-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/shell-layout.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(dashboard, /<header className="topbar">/);
  assert.match(dashboard, /sidebar-runtime-card/);
  assert.match(dashboard, /sidebar-primary-actions/);
  assert.match(dashboard, /sidebarCollapsed/);
  assert.match(dashboard, /traceHeaderCollapsed/);
  assert.match(dashboard, /收起摘要/);
  assert.match(shellStyles, /\.workspace\.sidebar-collapsed/);
  assert.match(shellStyles, /\.trace-header-shell\.collapsed/);
});
