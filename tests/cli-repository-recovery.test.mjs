import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDreamSkinCliContext } from "../src/core/cli-context.mjs";
import { createDreamSkinApplicationContext } from "../src/core/product-application-context.mjs";
import { createStudioBackend } from "../src/core/studio-backend.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKBUDDY_PLUGIN_ID = "dreamskin.workbuddy";

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

test("Studio and the installed CLI share one WorkBuddy backup journal and recover across surfaces", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-cli-recovery-"));
  const productDataRoot = path.join(root, "dreamskin");
  const themesRoot = path.join(productDataRoot, "themes", WORKBUDDY_PLUGIN_ID);
  const dataRoot = path.join(productDataRoot, "state", WORKBUDDY_PLUGIN_ID);
  const backupsRoot = path.join(productDataRoot, "backups", WORKBUDDY_PLUGIN_ID);
  let applicationContext;
  let backend;
  let cliContext;
  t.after(async () => {
    await backend?.close();
    if (applicationContext && !backend) {
      await Promise.allSettled(applicationContext.pluginManager.list({ state: "active" })
        .map((plugin) => applicationContext.pluginManager.deactivate(plugin.id)));
    }
    await cliContext?.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  applicationContext = await createDreamSkinApplicationContext({
    projectRoot: PROJECT_ROOT,
    themesRoot: path.join(productDataRoot, "themes"),
    dataRoot: productDataRoot,
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
    dataRoot: productDataRoot,
    targetOptions: {
      [WORKBUDDY_PLUGIN_ID]: {
        manifestPath: path.join(dataRoot, "library.json"),
      },
    },
  });

  cliContext = await createDreamSkinCliContext({
    homeDir: root,
    environment: {
      DREAMSKIN_RESOURCE_ROOT: PROJECT_ROOT,
      DREAMSKIN_USER_DATA_ROOT: path.join(root, "DreamSkin Studio"),
      DREAMSKIN_DATA_ROOT: productDataRoot,
      DREAMSKIN_TRAE_RUNTIME_STATE_ROOT: path.join(root, "TraeDreamSkin"),
      DREAMSKIN_WORKBUDDY_RUNTIME_STATE_ROOT: path.join(root, "WorkBuddyDreamSkin"),
    },
  });

  const studioRepository = backend.target(WORKBUDDY_PLUGIN_ID).library.userRepository;
  const cliRepository = cliContext.context.target(WORKBUDDY_PLUGIN_ID).repository;
  assert.equal(studioRepository.themesRoot, cliRepository.themesRoot);
  assert.equal(studioRepository.dataRoot, cliRepository.dataRoot);
  assert.equal(studioRepository.backupsRoot, cliRepository.backupsRoot);

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

  await cliRepository.ensureRoots();
  const recovered = await cliRepository.read(themeId);
  assert.equal(recovered.theme.name, "Stable WorkBuddy Theme");
  assert.equal(recovered.revision, stable.afterRevision);
  const recoveryManifest = JSON.parse(await fs.readFile(
    path.join(backupsRoot, interruptedTransactionId, "manifest.json"),
    "utf8",
  ));
  assert.equal(recoveryManifest.status, "recovered");
  assert.equal(recoveryManifest.recovery.action, "restored-prior-theme");
});
