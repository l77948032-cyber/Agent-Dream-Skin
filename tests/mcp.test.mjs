import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import path from "node:path";

import { createMcpServer } from "../src/mcp-server.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("MCP server exposes the frozen nine-tool surface", async (t) => {
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
  const server = createMcpServer({ service });
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
  assert.equal(tools.tools.length, 9);
});
