import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";

import { createTraeApplicationContext } from "./core/application-context.mjs";
import { errorEnvelope, ToolError } from "./core/errors.mjs";
import { PROJECT_ROOT } from "./core/paths.mjs";
import { AGENT_TOOL_VERSION } from "./core/service.mjs";

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

const pluginId = z.string().min(1).optional();
const themeId = z.string().min(1);
const themePatch = z.record(z.string(), z.unknown());
const dreamSkinToolInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inspect"), pluginId }).strict(),
  z.object({ action: z.literal("list"), pluginId }).strict(),
  z.object({ action: z.literal("read"), pluginId, themeId }).strict(),
  z.object({
    action: z.literal("create"),
    pluginId,
    themeId,
    themePatch,
    sourceId: z.string().min(1).optional(),
    dryRun: z.boolean().optional(),
  }).strict(),
  z.object({
    action: z.literal("update"),
    pluginId,
    themeId,
    themePatch,
    expectedRevision: z.string().min(1),
    dryRun: z.boolean().optional(),
  }).strict(),
  z.object({
    action: z.literal("validate"),
    pluginId,
    themeId: themeId.optional(),
    theme: themePatch.optional(),
  }).strict().refine((value) => Boolean(value.themeId) !== Boolean(value.theme), {
    message: "Provide exactly one of themeId or theme.",
  }),
]);

function assertScopedInput(input, scope = {}) {
  if (scope.pluginId && input.pluginId && input.pluginId !== scope.pluginId) {
    throw new ToolError("TOOL_SCOPE_VIOLATION", "DreamSkin Tool cannot access another plugin in this session.");
  }
  if (!scope.themeId) return;
  if (input.action === "list") {
    throw new ToolError("TOOL_SCOPE_VIOLATION", "Theme listing is not available in a selected-theme session.");
  }
  if (input.action === "create" || (input.action === "validate" && input.theme !== undefined)) {
    throw new ToolError("TOOL_SCOPE_VIOLATION", `Action '${input.action}' is not available in a selected-theme session.`);
  }
  if (["read", "update", "validate"].includes(input.action) && input.themeId !== scope.themeId) {
    throw new ToolError("TOOL_SCOPE_VIOLATION", "DreamSkin Tool can only access the selected theme.");
  }
  if (input.action === "update" && scope.expectedRevision && input.expectedRevision !== scope.expectedRevision) {
    throw new ToolError("TOOL_SCOPE_VIOLATION", "DreamSkin Tool can only update the revision selected by Studio.");
  }
}

function scopedResult(input, result, scope = {}) {
  if (!scope.themeId || input.action !== "inspect" || !result?.repository) return result;
  const themes = (result.repository.themes || []).filter((theme) => theme.id === scope.themeId);
  return {
    ...result,
    scope: { pluginId: scope.pluginId || input.pluginId, themeId: scope.themeId },
    repository: { count: themes.length, themes },
  };
}

export function createMcpServer({ tool, service, profile = "tool", scope = {} } = {}) {
  const server = new McpServer({ name: "dreamskin-tool-compat", version: AGENT_TOOL_VERSION });
  if (profile === "tool") {
    if (!tool || typeof tool.execute !== "function") {
      throw new ToolError("INVALID_TOOL_DEPENDENCY", "The MCP compatibility adapter requires DreamSkin Tool Core.");
    }
    register(server, "dreamskin_theme", {
      title: "DreamSkin Theme Tool",
      description: "Inspect, read, create, update, or validate structured themes through the active DreamSkin target plugin.",
      inputSchema: dreamSkinToolInput,
    }, async (input) => {
      assertScopedInput(input, scope);
      const resolvedInput = {
        ...input,
        ...(scope.pluginId && !input.pluginId ? { pluginId: scope.pluginId } : {}),
      };
      const result = await tool.execute(resolvedInput);
      if (resolvedInput.action === "update" && !resolvedInput.dryRun) {
        if (typeof result?.afterRevision !== "string" || !result.afterRevision) {
          throw new ToolError(
            "INVALID_TOOL_RESULT",
            "DreamSkin Tool updates must return a non-empty afterRevision.",
          );
        }
        scope.expectedRevision = result.afterRevision;
      }
      return scopedResult(resolvedInput, result, scope);
    });
    return server;
  }
  if (profile !== "legacy-v1") {
    throw new ToolError("INVALID_ARGUMENT", `Unknown MCP compatibility profile: ${profile}`);
  }
  if (!service) throw new ToolError("INVALID_TOOL_DEPENDENCY", "The legacy MCP profile requires a compatibility facade.");
  registerLegacyTools(server, service);
  return server;
}

const emptyInput = z.object({}).strict();

function registerLegacyTools(server, service) {
  register(server, "inspect", {
    title: "Inspect Trae-Dream-Skin",
    description: "Inspect runtime state, theme repository, semantic component registry, schema, and safety capabilities.",
    inputSchema: emptyInput,
  }, () => service.inspect());
  register(server, "theme_list", { title: "List themes", description: "List all themes.", inputSchema: emptyInput }, () => service.themeList());
  register(server, "theme_read", {
    title: "Read theme",
    description: "Read a structured theme and revision.",
    inputSchema: z.object({ id: z.string().min(1) }).strict(),
  }, ({ id }) => service.themeRead(id));
  register(server, "theme_write", {
    title: "Write or roll back theme",
    description: "Compatibility-only structured theme transaction.",
    inputSchema: z.object({
      operation: z.enum(["write", "rollback"]).default("write"),
      id: z.string().optional(),
      themePatch: themePatch.optional(),
      imagePath: z.string().optional(),
      expectedRevision: z.string().nullable().optional(),
      dryRun: z.boolean().default(false),
      transactionId: z.string().optional(),
    }).strict(),
  }, (input) => service.themeWrite(input));
  register(server, "theme_validate", {
    title: "Validate theme",
    description: "Validate an installed theme or complete theme object.",
    inputSchema: z.object({ id: z.string().optional(), theme: themePatch.optional() }).strict()
      .refine((value) => Boolean(value.id) !== Boolean(value.theme), { message: "Provide exactly one of id or theme." }),
  }, (input) => service.themeValidate(input));
  register(server, "preview", {
    title: "Preview theme",
    description: "Temporarily apply and verify a theme, then restore the previous state.",
    inputSchema: z.object({ id: z.string().min(1), screenshot: z.boolean().default(true), screenshotPath: z.string().optional() }).strict(),
  }, ({ id, ...options }) => service.preview(id, options));
  register(server, "apply", { title: "Apply theme", description: "Apply a theme to Trae.", inputSchema: z.object({ id: z.string().min(1) }).strict() }, ({ id }) => service.apply(id));
  register(server, "verify", {
    title: "Verify active theme",
    description: "Verify the active Trae runtime.",
    inputSchema: z.object({ screenshot: z.boolean().default(false), screenshotPath: z.string().optional() }).strict(),
  }, (input) => service.verify(input));
  register(server, "restore", { title: "Restore native Trae", description: "Restore Trae to its native state.", inputSchema: emptyInput }, () => service.restore());
}

export async function startMcpServer({ profile = "tool" } = {}) {
  const context = await createTraeApplicationContext({
    projectRoot: PROJECT_ROOT,
    pluginRoot: path.resolve(
      process.env.DREAMSKIN_TOOL_PLUGIN_ROOT || path.join(PROJECT_ROOT, "plugins", "trae"),
    ),
  });
  const server = createMcpServer({
    tool: context.tool,
    service: context.legacyService,
    profile,
    scope: {
      pluginId: process.env.DREAMSKIN_TOOL_PLUGIN_ID || undefined,
      themeId: process.env.DREAMSKIN_TOOL_THEME_ID || undefined,
      expectedRevision: process.env.DREAMSKIN_TOOL_EXPECTED_REVISION || undefined,
    },
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

function parseProfile(argv) {
  if (argv.length === 0) return "tool";
  if (argv.length === 2 && argv[0] === "--profile") return argv[1];
  throw new ToolError("INVALID_ARGUMENT", "Usage: mcp-server.mjs [--profile tool|legacy-v1]");
}

export function isMcpEntrypoint({
  argv = process.argv,
  env = process.env,
  moduleUrl = import.meta.url,
} = {}) {
  return env.DREAMSKIN_MCP_ENTRY === "1"
    || Boolean(argv[1] && path.resolve(argv[1]) === fileURLToPath(moduleUrl));
}

if (isMcpEntrypoint()) {
  startMcpServer({ profile: parseProfile(process.argv.slice(2)) }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
