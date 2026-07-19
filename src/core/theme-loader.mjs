import fs from "node:fs/promises";
import path from "node:path";

import { PROJECT_ROOT } from "./paths.mjs";
import {
  IMAGE_TYPES,
  MAX_ART_BYTES,
  MAX_CONFIG_BYTES,
  MAX_CSS_BYTES,
  matchesImageSignature,
  normalizeTheme,
} from "./theme-model.mjs";

export async function readSizedFile(filePath, maximum, label) {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link`);
  if (!stat.isFile() || stat.size < 1 || stat.size > maximum) {
    throw new Error(`${label} must be a non-empty file no larger than ${maximum} bytes`);
  }
  return fs.readFile(filePath);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function assertContainedPath(filePath, rootPath, label) {
  const [realFile, realRoot] = await Promise.all([fs.realpath(filePath), fs.realpath(rootPath)]);
  if (!isWithin(realRoot, realFile)) throw new Error(`${label} must stay inside ${rootPath}`);
}

export async function loadTheme(themeDir, { projectRoot = PROJECT_ROOT, allowedRoot } = {}) {
  const resolvedThemeDir = path.resolve(themeDir);
  const directoryStat = await fs.lstat(resolvedThemeDir);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("Theme directory must be a real directory, not a symbolic link");
  }
  if (allowedRoot) await assertContainedPath(resolvedThemeDir, allowedRoot, "Theme directory");
  const configPath = path.join(resolvedThemeDir, "theme.json");
  let configBuffer;
  try {
    configBuffer = await readSizedFile(configPath, MAX_CONFIG_BYTES, "Theme config");
    await assertContainedPath(configPath, resolvedThemeDir, "Theme config");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Theme directory is missing theme.json: ${configPath}`);
    throw error;
  }
  let raw;
  try {
    raw = JSON.parse(configBuffer.toString("utf8"));
  } catch (error) {
    throw new Error(`Could not parse ${configPath}: ${error.message}`);
  }
  const theme = normalizeTheme(raw, configPath);
  const extension = path.extname(theme.image).toLowerCase();
  const mime = IMAGE_TYPES.get(extension);
  if (!mime) throw new Error(`Unsupported theme image format: ${extension || "missing"}`);
  const imagePath = path.join(resolvedThemeDir, theme.image);
  const image = await readSizedFile(imagePath, MAX_ART_BYTES, "Theme image");
  await assertContainedPath(imagePath, resolvedThemeDir, "Theme image");
  if (!matchesImageSignature(image, extension)) {
    throw new Error(`Theme image content does not match its ${extension} extension`);
  }

  const customCssPath = path.join(resolvedThemeDir, "skin.css");
  let cssPath = customCssPath;
  try {
    const customCssStat = await fs.lstat(customCssPath);
    if (customCssStat.isSymbolicLink()) throw new Error("Skin CSS cannot be a symbolic link");
    await assertContainedPath(customCssPath, resolvedThemeDir, "Skin CSS");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    cssPath = path.join(projectRoot, "assets", "trae-skin.css");
    await assertContainedPath(cssPath, projectRoot, "Fallback skin CSS");
  }
  const cssBuffer = await readSizedFile(cssPath, MAX_CSS_BYTES, "Skin CSS");
  const css = cssBuffer.toString("utf8");
  return {
    themeDir: resolvedThemeDir,
    configPath,
    cssPath,
    imagePath,
    image,
    mime,
    css,
    cssBuffer,
    theme,
    raw,
  };
}
