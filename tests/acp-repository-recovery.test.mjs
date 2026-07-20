import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDreamSkinApplicationContext } from "../src/core/product-application-context.mjs";
import { createStudioBackend } from "../src/core/studio-backend.mjs";
import { createMcpApplicationContext } from "../src/mcp-server.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKBUDDY_PLUGIN_ID = "dreamskin.workbuddy";

function environment(server) {
  return Object.fromEntries(server.env.map((entry) => [entry.name, entry.value]));
}

function fileSystemWithInterruptedInstall(targetPath) {
  return new Proxy(fs, {
    get(target, property) {
      if (property === "rename") {
        return async (source, destination) => {
          if (
            destination === targetPath
            && (/\.stage-/.test(path.basename(source)) || /\.retired-/.test(path.basename(source)))
          ) {
            const error = new Error(`Injected interrupted install: ${path.basename(source)}`);
            error.code = "EIO";
            throw error;
          }
          return target.rename(source, destination);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("Studio and its scoped ACP helper share one WorkBuddy backup journal and recover across surfaces", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-acp-recovery-"));
  const themesRoot = path.join(root, "themes", WORKBUDDY_PLUGIN_ID);
  const dataRoot = path.join(root, "state", WORKBUDDY_PLUGIN_ID);
  const backupsRoot = path.join(root, "backups", WORKBUDDY_PLUGIN_ID);
  let applicationContext;
  let backend;
  let acpContext;
  t.after(async () => {
    await backend?.close();
    if (applicationContext && !backend) {
      await Promise.allSettled(applicationContext.pluginManager.list({ state: "active" })
        .map((plugin) => applicationContext.pluginManager.deactivate(plugin.id)));
    }
    if (acpContext) {
      await Promise.allSettled(acpContext.pluginManager.list({ state: "active" })
        .map((plugin) => acpContext.pluginManager.deactivate(plugin.id)));
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  applicationContext = await createDreamSkinApplicationContext({
    projectRoot: PROJECT_ROOT,
    themesRoot: path.join(root, "themes"),
    dataRoot: path.join(root, "product-state"),
    workBuddyOptions: {
      themesRoot,
      dataRoot,
      backupsRoot,
      stateRoot: path.join(dataRoot, "runtime"),
    },
  });
  backend = await createStudioBackend({
    applicationContext,
    projectRoot: PROJECT_ROOT,
    dataRoot: path.join(root, "studio-state"),
    manifestPath: path.join(root, "studio-state", "library.json"),
  });

  const helperEnvironment = environment(
    backend.sessions.mcpServer("cross-surface", WORKBUDDY_PLUGIN_ID),
  );
  assert.equal(helperEnvironment.DREAMSKIN_TOOL_BACKUPS_ROOT, path.resolve(backupsRoot));
  acpContext = await createMcpApplicationContext({
    env: helperEnvironment,
    projectRoot: PROJECT_ROOT,
  });

  const studioRepository = backend.target(WORKBUDDY_PLUGIN_ID).library.userRepository;
  const acpRepository = acpContext.repository;
  assert.equal(studioRepository.themesRoot, acpRepository.themesRoot);
  assert.equal(studioRepository.dataRoot, acpRepository.dataRoot);
  assert.equal(studioRepository.backupsRoot, acpRepository.backupsRoot);

  const sourceRoot = path.join(PROJECT_ROOT, "plugins", "workbuddy", "catalog", "harbor-focus");
  const sourceTheme = JSON.parse(await fs.readFile(path.join(sourceRoot, "theme.json"), "utf8"));
  const themeId = "cross-surface";
  const stable = await studioRepository.write({
    id: themeId,
    imagePath: path.join(sourceRoot, sourceTheme.image),
    expectedRevision: null,
    themePatch: { ...sourceTheme, id: themeId, name: "Stable WorkBuddy Theme" },
  });

  studioRepository.fs = fileSystemWithInterruptedInstall(studioRepository.themePath(themeId));
  let interruptedTransactionId;
  await assert.rejects(
    () => studioRepository.write({
      id: themeId,
      expectedRevision: stable.afterRevision,
      themePatch: { name: "Interrupted WorkBuddy Theme" },
    }),
    (error) => {
      interruptedTransactionId = error.details.transactionId;
      return error.code === "THEME_WRITE_RECOVERY_REQUIRED";
    },
  );
  studioRepository.fs = fs;

  await acpRepository.ensureRoots();
  const recovered = await acpRepository.read(themeId);
  assert.equal(recovered.theme.name, "Stable WorkBuddy Theme");
  assert.equal(recovered.revision, stable.afterRevision);
  const recoveryManifest = JSON.parse(await fs.readFile(
    path.join(backupsRoot, interruptedTransactionId, "manifest.json"),
    "utf8",
  ));
  assert.equal(recoveryManifest.status, "recovered");
  assert.equal(recoveryManifest.recovery.action, "restored-prior-theme");
});
