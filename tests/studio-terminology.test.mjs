import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("Studio presents a local theme library instead of an embedded Agent connection", async () => {
  const sources = await Promise.all([
    "studio/src/App.tsx",
    "studio/src/api.ts",
  ].map((file) => fs.readFile(path.join(ROOT, file), "utf8")));
  const userInterfaceSource = sources.join("\n");

  for (const forbidden of [
    "Agent 连接",
    "DreamSkin Tool 已就绪",
    "通过 DreamSkin Tool 应用到",
  ]) {
    assert.equal(
      userInterfaceSource.includes(forbidden),
      false,
      `Studio must not expose protocol terminology: ${forbidden}`,
    );
  }

  assert.match(userInterfaceSource, /DreamSkin CLI/);
  assert.match(userInterfaceSource, /本地主题库/);
  assert.match(userInterfaceSource, /getCliStatus/);
});
