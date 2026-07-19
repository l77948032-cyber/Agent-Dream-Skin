import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("Studio presents DreamSkin as a Tool instead of an MCP product", async () => {
  const sources = await Promise.all([
    "studio/src/App.tsx",
    "studio/src/ThemeShowcase.tsx",
    "src/core/studio-backend.mjs",
  ].map((file) => fs.readFile(path.join(ROOT, file), "utf8")));
  const userInterfaceSource = sources.join("\n");

  for (const forbidden of [
    "DreamSkin MCP",
    "MCP 已连接",
    "MCP 已就绪",
    "MCP Runtime",
    "MCP 语义组件",
    "通过 MCP 应用",
    "使用 MCP 的运行时样式",
  ]) {
    assert.equal(
      userInterfaceSource.includes(forbidden),
      false,
      `Studio must not expose protocol terminology: ${forbidden}`,
    );
  }

  assert.match(userInterfaceSource, /DreamSkin Tool 已就绪/);
  assert.match(userInterfaceSource, /通过 DreamSkin Tool 应用到/);
});
