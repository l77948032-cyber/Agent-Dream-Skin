import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import path from "node:path";

import { createMcpServer, isMcpEntrypoint } from "../src/mcp-server.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("packaged MCP helpers use an explicit entry marker instead of relying on an ASAR argv path", () => {
  assert.equal(isMcpEntrypoint({
    argv: ["electron", "/bundle/app.asar/src/mcp-server.mjs"],
    env: { DREAMSKIN_MCP_ENTRY: "1" },
    moduleUrl: "file:///different/app.asar/src/mcp-server.mjs",
  }), true);
  assert.equal(isMcpEntrypoint({
    argv: ["node", "/other/mcp-server.mjs"],
    env: {},
    moduleUrl: new URL("../src/mcp-server.mjs", import.meta.url).href,
  }), false);
});

test("MCP compatibility adapter exposes one DreamSkin Tool", async (t) => {
  const calls = [];
  const tool = {
    execute: async (input) => {
      calls.push(input);
      return input.action === "list" ? { themes: [] } : input;
    },
  };
  const server = createMcpServer({ tool });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((entry) => entry.name), ["dreamskin_theme"]);
  const called = await client.callTool({ name: "dreamskin_theme", arguments: { action: "list" } });
  assert.deepEqual(called.structuredContent, { themes: [] });
  assert.deepEqual(calls, [{ action: "list" }]);
});

test("scoped MCP compatibility sessions expose only the selected theme", async (t) => {
  const tool = {
    execute: async (input) => input.action === "inspect" ? {
      repository: {
        themesRoot: "/private/themes",
        count: 2,
        themes: [{ id: "selected" }, { id: "other" }],
      },
    } : input,
  };
  const server = createMcpServer({
    tool,
    scope: { pluginId: "dreamskin.trae", themeId: "selected" },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const crossTheme = await client.callTool({
    name: "dreamskin_theme",
    arguments: { action: "read", themeId: "other" },
  });
  const create = await client.callTool({
    name: "dreamskin_theme",
    arguments: { action: "create", themeId: "new", themePatch: {} },
  });
  const list = await client.callTool({
    name: "dreamskin_theme",
    arguments: { action: "list" },
  });
  const inspected = await client.callTool({
    name: "dreamskin_theme",
    arguments: { action: "inspect" },
  });
  assert.equal(crossTheme.isError, true);
  assert.equal(crossTheme.structuredContent.error.code, "TOOL_SCOPE_VIOLATION");
  assert.equal(create.isError, true);
  assert.equal(list.isError, true);
  assert.deepEqual(inspected.structuredContent.repository, {
    count: 1,
    themes: [{ id: "selected" }],
  });
  assert.equal(JSON.stringify(inspected.structuredContent).includes("/private/themes"), false);
});

test("scoped MCP updates enforce and advance the Studio-selected revision", async (t) => {
  const calls = [];
  const scope = {
    pluginId: "dreamskin.trae",
    themeId: "selected",
    expectedRevision: "revision-1",
  };
  const tool = {
    execute: async (input) => {
      calls.push(input);
      if (input.dryRun) return { afterRevision: "dry-run-revision" };
      return {
        afterRevision: input.expectedRevision === "revision-1" ? "revision-2" : "revision-3",
      };
    },
  };
  const server = createMcpServer({ tool, scope });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const update = (expectedRevision, dryRun = false) => client.callTool({
    name: "dreamskin_theme",
    arguments: {
      action: "update",
      themeId: "selected",
      themePatch: { colors: { accent: "#123456" } },
      expectedRevision,
      ...(dryRun ? { dryRun: true } : {}),
    },
  });

  const initialMismatch = await update("revision-stale");
  assert.equal(initialMismatch.isError, true);
  assert.equal(initialMismatch.structuredContent.error.code, "TOOL_SCOPE_VIOLATION");
  assert.equal(calls.length, 0);

  const first = await update("revision-1");
  assert.deepEqual(first.structuredContent, { afterRevision: "revision-2" });
  assert.deepEqual(calls[0], {
    action: "update",
    pluginId: "dreamskin.trae",
    themeId: "selected",
    themePatch: { colors: { accent: "#123456" } },
    expectedRevision: "revision-1",
  });
  assert.equal(scope.expectedRevision, "revision-2");

  const staleAfterAdvance = await update("revision-1");
  assert.equal(staleAfterAdvance.isError, true);
  assert.equal(staleAfterAdvance.structuredContent.error.code, "TOOL_SCOPE_VIOLATION");
  assert.equal(calls.length, 1);

  const dryRun = await update("revision-2", true);
  assert.deepEqual(dryRun.structuredContent, { afterRevision: "dry-run-revision" });
  assert.equal(scope.expectedRevision, "revision-2");

  const second = await update("revision-2");
  assert.deepEqual(second.structuredContent, { afterRevision: "revision-3" });
  assert.equal(scope.expectedRevision, "revision-3");

  const staleAfterSecondAdvance = await update("revision-2");
  assert.equal(staleAfterSecondAdvance.isError, true);
  assert.equal(calls.length, 3);
});

test("scoped MCP updates keep their revision pinned after an invalid Tool result", async (t) => {
  const scope = {
    pluginId: "dreamskin.trae",
    themeId: "selected",
    expectedRevision: "revision-1",
  };
  let calls = 0;
  const tool = {
    execute: async () => {
      calls += 1;
      return { afterRevision: calls === 1 ? "" : "revision-2" };
    },
  };
  const server = createMcpServer({ tool, scope });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const update = () => client.callTool({
    name: "dreamskin_theme",
    arguments: {
      action: "update",
      themeId: "selected",
      themePatch: { colors: { accent: "#123456" } },
      expectedRevision: "revision-1",
    },
  });

  const invalid = await update();
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, "INVALID_TOOL_RESULT");
  assert.equal(scope.expectedRevision, "revision-1");

  const recovered = await update();
  assert.deepEqual(recovered.structuredContent, { afterRevision: "revision-2" });
  assert.equal(scope.expectedRevision, "revision-2");
});

test("legacy MCP profile preserves the nine-tool compatibility surface", async (t) => {
  const service = {
    inspect: async () => ({ product: "Trae-Dream-Skin" }),
    themeList: async () => ({ themes: [] }),
    themeRead: async () => ({}),
    themeWrite: async () => ({}),
    themeValidate: async () => ({ valid: true }),
    preview: async () => ({}),
    apply: async () => ({}),
    verify: async () => ({}),
    restore: async () => ({}),
  };
  const server = createMcpServer({ service, profile: "legacy-v1" });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "apply", "inspect", "preview", "restore", "theme_list", "theme_read",
    "theme_validate", "theme_write", "verify",
  ]);
  const called = await client.callTool({ name: "theme_list", arguments: {} });
  assert.deepEqual(called.structuredContent, { themes: [] });
});

test("MCP server starts cleanly over real stdio", async (t) => {
  const client = new Client({ name: "stdio-test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "src", "mcp-server.mjs")],
    cwd: ROOT,
    stderr: "pipe",
  });
  t.after(async () => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((entry) => entry.name), ["dreamskin_theme"]);
});
