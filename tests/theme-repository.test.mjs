import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ThemeRepository } from "../src/core/theme-repository.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

async function repositoryFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trae-agent-tool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new ThemeRepository({
    themesRoot: path.join(root, "themes"),
    dataRoot: path.join(root, "data"),
    backupsRoot: path.join(root, "data", "backups"),
    projectRoot: ROOT,
  });
}

test("theme repository stages, commits, revisions, and idempotent rollback", async (t) => {
  const repository = await repositoryFixture(t);
  const imagePath = path.join(ROOT, "themes", "violet-rift", "background.png");
  const dryRun = await repository.write({
    id: "agent-fixture",
    imagePath,
    expectedRevision: null,
    dryRun: true,
    themePatch: {
      name: "Agent Fixture",
      states: { tooltipBackground: "#19172F", tooltipText: "#F4F4FF" },
      appearance: { colorScheme: "dark", treatment: "violet-rift" },
    },
  });
  assert.equal(dryRun.dryRun, true);
  await assert.rejects(() => repository.read("agent-fixture"), (error) => error.code === "THEME_NOT_FOUND");

  const written = await repository.write({
    id: "agent-fixture",
    imagePath,
    expectedRevision: null,
    themePatch: {
      name: "Agent Fixture",
      states: { tooltipBackground: "#19172F", tooltipText: "#F4F4FF" },
      appearance: { colorScheme: "dark", treatment: "violet-rift" },
    },
  });
  assert.equal(written.beforeRevision, null);
  const read = await repository.read("agent-fixture");
  assert.equal(read.revision, written.afterRevision);
  assert.equal(read.theme.states.tooltipBackground, "#19172F");

  await assert.rejects(() => repository.write({
    id: "agent-fixture",
    expectedRevision: "stale",
    themePatch: { name: "Should Not Commit" },
  }), (error) => error.code === "REVISION_CONFLICT");

  const rolledBack = await repository.write({ operation: "rollback", transactionId: written.transactionId });
  assert.equal(rolledBack.rolledBack, true);
  await assert.rejects(() => repository.read("agent-fixture"), (error) => error.code === "THEME_NOT_FOUND");
  const repeated = await repository.write({ operation: "rollback", transactionId: written.transactionId });
  assert.equal(repeated.alreadyRolledBack, true);
});

test("theme repository rejects arbitrary fields and executable CSS values", async (t) => {
  const repository = await repositoryFixture(t);
  await assert.rejects(() => repository.write({
    id: "unsafe-theme",
    themePatch: { css: ":root { color: red }" },
  }), (error) => error.code === "INVALID_THEME_PATCH");

  await assert.rejects(() => repository.validate({
    theme: {
      schemaVersion: 1,
      id: "safe-theme",
      image: "background.png",
      states: { tooltipBackground: "url(file:///secret)" },
    },
  }), (error) => error.code === "THEME_INVALID" && error.details.fields.includes("theme.states.tooltipBackground"));
});
