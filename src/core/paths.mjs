import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(
  process.env.TRAE_DREAM_SKIN_PROJECT_ROOT || path.join(here, "..", ".."),
);
export const THEMES_ROOT = path.resolve(
  process.env.TRAE_DREAM_SKIN_THEMES_ROOT || path.join(PROJECT_ROOT, "themes"),
);
export const TOOL_DATA_ROOT = path.resolve(
  process.env.TRAE_DREAM_SKIN_TOOL_HOME || path.join(PROJECT_ROOT, ".trae-dream-skin"),
);
export const STUDIO_HOME = path.resolve(
  process.env.DREAMSKIN_STUDIO_HOME || path.join(os.homedir(), ".dreamskin"),
);
export const STUDIO_THEMES_ROOT = path.resolve(
  process.env.DREAMSKIN_STUDIO_THEMES_ROOT || path.join(STUDIO_HOME, "themes"),
);
export const STUDIO_DATA_ROOT = path.join(STUDIO_HOME, "data");
export const STUDIO_LIBRARY_PATH = path.join(STUDIO_HOME, "library.json");
export const BACKUPS_ROOT = path.join(TOOL_DATA_ROOT, "backups");
export const REGISTRY_PATH = path.join(PROJECT_ROOT, "registry", "components.v1.json");
export const RUNTIME_MAPPING_PATH = path.join(PROJECT_ROOT, "registry", "theme-runtime.v1.json");
export const SCHEMA_PATH = path.join(PROJECT_ROOT, "schemas", "theme-v1.schema.json");
export const SCRIPTS_ROOT = path.join(PROJECT_ROOT, "scripts");

export function runtimeStateRoot(platform = process.platform) {
  if (process.env.TRAE_DREAM_SKIN_HOME) return path.resolve(process.env.TRAE_DREAM_SKIN_HOME);
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "TraeDreamSkin");
  }
  if (platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "TraeDreamSkin");
  }
  return path.join(os.homedir(), ".local", "state", "TraeDreamSkin");
}
