import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { preferredCodexPath } from "../desktop/agent-paths.mjs";
import { AgentRegistry } from "../src/core/agent-registry.mjs";
import { createStudioBackend } from "../src/core/studio-backend.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENABLED = process.env.RUN_REAL_AGENT_E2E === "1";

test("real Codex ACP session updates and validates a Studio theme", {
  skip: ENABLED ? false : "set RUN_REAL_AGENT_E2E=1 to exercise the installed Codex CLI",
  timeout: 6 * 60_000,
}, async (t) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-real-agent-"));
  const themesRoot = path.join(dataRoot, "themes");
  const studioRoot = path.join(dataRoot, "studio");
  const codexPath = await preferredCodexPath();
  assert.ok(codexPath, "an explicit or official-app Codex executable is required");

  const registry = new AgentRegistry({
    projectRoot: PROJECT_ROOT,
    commandPaths: { codex: codexPath },
    adapterPaths: { codex: path.join(PROJECT_ROOT, "node_modules", ".bin", "codex-acp") },
  });
  const backend = await createStudioBackend({
    projectRoot: PROJECT_ROOT,
    userThemesRoot: themesRoot,
    dataRoot: studioRoot,
    manifestPath: path.join(studioRoot, "library.v1.json"),
    agentRegistry: registry,
  });
  t.after(async () => {
    await backend.close();
    await fs.rm(dataRoot, { recursive: true, force: true });
  });

  const created = await backend.createTheme({ kind: "blank" });
  await backend.connectAgent("codex");
  const result = await backend.message(created.localId, {
    agentId: "codex",
    expectedRevision: created.revisionHash,
    prompt: "把强调色和焦点色统一改为 #2F7CF6，其他内容保持不变。",
  });

  assert.notEqual(result.theme.revisionHash, created.revisionHash);
  assert.equal(result.theme.theme.colors.accent, "#2F7CF6");
  assert.equal(result.theme.theme.states.focus, "#2F7CF6");
  assert.match(result.message, /#2F7CF6|强调色|焦点色/);
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(result.changes, ["调色板", "交互状态"]);
});
