import path from "node:path";

import {
  createApplicationContext,
  createTraeTargetRegistration,
  DEFAULT_PLUGIN_ID,
} from "./application-context.mjs";
import {
  createWorkBuddyTargetRegistration,
  WORKBUDDY_PLUGIN_ID,
} from "./workbuddy-application-context.mjs";
import {
  PROJECT_ROOT,
  STUDIO_DATA_ROOT,
  STUDIO_THEMES_ROOT,
} from "./paths.mjs";

/**
 * Compose the first-party target plugins without making either plugin aware of
 * the other. Callers may replace every target-specific path for packaged use.
 */
export async function createDreamSkinApplicationContext({
  projectRoot = PROJECT_ROOT,
  dataRoot = STUDIO_DATA_ROOT,
  themesRoot = STUDIO_THEMES_ROOT,
  defaultPluginId = DEFAULT_PLUGIN_ID,
  traeOptions = {},
  workBuddyOptions = {},
} = {}) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedDataRoot = path.resolve(dataRoot);
  const resolvedThemesRoot = path.resolve(themesRoot);
  const [traeTarget, workBuddyTarget] = await Promise.all([
    createTraeTargetRegistration({
      projectRoot: resolvedProjectRoot,
      themesRoot: resolvedThemesRoot,
      dataRoot: resolvedDataRoot,
      backupsRoot: path.join(resolvedDataRoot, "backups"),
      ...traeOptions,
    }),
    createWorkBuddyTargetRegistration({
      projectRoot: resolvedProjectRoot,
      themesRoot: path.join(resolvedThemesRoot, WORKBUDDY_PLUGIN_ID),
      dataRoot: path.join(resolvedDataRoot, WORKBUDDY_PLUGIN_ID),
      ...workBuddyOptions,
    }),
  ]);

  return createApplicationContext({
    targets: [traeTarget, workBuddyTarget],
    defaultPluginId,
    dataRoot: resolvedDataRoot,
    projectRoot: resolvedProjectRoot,
  });
}
