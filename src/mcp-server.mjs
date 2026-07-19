import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import { errorEnvelope } from "./core/errors.mjs";
import { AGENT_TOOL_VERSION, TraeDreamSkinService } from "./core/service.mjs";

function toolResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function toolFailure(error) {
  const envelope = errorEnvelope(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
  };
}

function register(server, name, config, handler) {
  server.registerTool(name, config, async (input) => {
    try {
      return toolResult(await handler(input));
    } catch (error) {
      return toolFailure(error);
    }
  });
}

const emptyInput = z.object({}).strict();

export function createMcpServer({ service = new TraeDreamSkinService() } = {}) {
  const server = new McpServer({ name: "trae-dream-skin", version: AGENT_TOOL_VERSION });

  register(server, "inspect", {
    title: "Inspect Trae-Dream-Skin",
    description: "Inspect runtime state, theme repository, semantic component registry, schema, and safety capabilities before making changes.",
    inputSchema: emptyInput,
  }, () => service.inspect());

  register(server, "theme_list", {
    title: "List themes",
    description: "List all structured Trae themes with revisions and validation status.",
    inputSchema: emptyInput,
  }, () => service.themeList());

  register(server, "theme_read", {
    title: "Read theme",
    description: "Read raw and normalized structured theme data plus its optimistic-concurrency revision.",
    inputSchema: z.object({ id: z.string().min(1) }).strict(),
  }, ({ id }) => service.themeRead(id));

  register(server, "theme_write", {
    title: "Write or roll back theme",
    description: "Stage, validate, and atomically write a structured theme patch, or roll back a previous write transaction. Raw CSS is not accepted.",
    inputSchema: z.object({
      operation: z.enum(["write", "rollback"]).default("write"),
      id: z.string().optional(),
      themePatch: z.record(z.string(), z.unknown()).optional(),
      imagePath: z.string().optional(),
      expectedRevision: z.string().nullable().optional(),
      dryRun: z.boolean().default(false),
      transactionId: z.string().optional(),
    }).strict(),
  }, (input) => service.themeWrite(input));

  register(server, "theme_validate", {
    title: "Validate theme",
    description: "Validate an installed theme and its image, or normalize a complete theme object without writing it.",
    inputSchema: z.object({
      id: z.string().optional(),
      theme: z.record(z.string(), z.unknown()).optional(),
    }).strict().refine((value) => Boolean(value.id) !== Boolean(value.theme), {
      message: "Provide exactly one of id or theme.",
    }),
  }, (input) => service.themeValidate(input));

  register(server, "preview", {
    title: "Preview theme",
    description: "Temporarily apply and verify a theme, optionally capture a screenshot, then restore the exact previous theme or native state.",
    inputSchema: z.object({
      id: z.string().min(1),
      screenshot: z.boolean().default(true),
      screenshotPath: z.string().optional(),
    }).strict(),
  }, ({ id, ...options }) => service.preview(id, options));

  register(server, "apply", {
    title: "Apply theme",
    description: "Apply a validated theme to Trae through the loopback-only CDP runtime.",
    inputSchema: z.object({ id: z.string().min(1) }).strict(),
  }, ({ id }) => service.apply(id));

  register(server, "verify", {
    title: "Verify active theme",
    description: "Verify the active Trae skin, layout, renderer targets, and optional screenshot.",
    inputSchema: z.object({
      screenshot: z.boolean().default(false),
      screenshotPath: z.string().optional(),
    }).strict(),
  }, (input) => service.verify(input));

  register(server, "restore", {
    title: "Restore native Trae",
    description: "Idempotently remove the injected skin and owned CDP session, returning Trae to its native appearance.",
    inputSchema: emptyInput,
  }, () => service.restore());

  return server;
}

export async function startMcpServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  startMcpServer().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
