import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDreamSkinApplicationContext } from "../src/core/product-application-context.mjs";

test("first-party product context activates isolated Trae and WorkBuddy targets", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-product-context-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const themesRoot = path.join(root, "themes");
  const dataRoot = path.join(root, "data");
  const context = await createDreamSkinApplicationContext({ themesRoot, dataRoot });
  t.after(async () => {
    await Promise.allSettled(context.pluginManager.list({ state: "active" })
      .map((plugin) => context.pluginManager.deactivate(plugin.id)));
  });

  assert.equal(context.defaultPluginId, "dreamskin.trae");
  assert.deepEqual([...context.targets.keys()], ["dreamskin.trae", "dreamskin.workbuddy"]);
  assert.equal(context.target("dreamskin.trae").targetName, "Trae");
  assert.equal(context.target("dreamskin.workbuddy").targetName, "WorkBuddy");
  assert.equal(context.target("dreamskin.trae").themesRoot, path.resolve(themesRoot));
  assert.equal(
    context.target("dreamskin.workbuddy").themesRoot,
    path.join(path.resolve(themesRoot), "dreamskin.workbuddy"),
  );
  assert.equal(context.target("dreamskin.trae").dataRoot, path.resolve(dataRoot));
  assert.equal(
    context.target("dreamskin.workbuddy").dataRoot,
    path.join(path.resolve(dataRoot), "dreamskin.workbuddy"),
  );
  assert.notEqual(
    context.target("dreamskin.trae").repository.backupsRoot,
    context.target("dreamskin.workbuddy").repository.backupsRoot,
  );
  assert.equal((await context.tool.inspect("dreamskin.trae")).target.id, "trae");
  assert.equal((await context.tool.inspect("dreamskin.workbuddy")).target.id, "workbuddy");
});
