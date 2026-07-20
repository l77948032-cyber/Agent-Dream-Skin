import fs from "node:fs/promises";
import path from "node:path";

export const DESKTOP_PRODUCT_NAME = "DreamSkin Studio";
export const LEGACY_USER_DATA_DIRECTORY = "trae-dream-skin";
export const LEGACY_STUDIO_DIRECTORY = ".dreamskin";
export const LEGACY_MIGRATION_MARKER = "legacy-migration.v1.json";
const TARGETS = Object.freeze(["dreamskin.trae", "dreamskin.workbuddy"]);
const EMPTY_COUNTS = Object.freeze({ themes: 0, backups: 0, libraryEntries: 0, previews: 0 });

function requireElectronApp(app) {
  if (
    !app
    || typeof app.getPath !== "function"
    || typeof app.setName !== "function"
    || typeof app.setPath !== "function"
  ) {
    throw new TypeError("Desktop product identity requires the Electron app API.");
  }
}

export function configureDesktopProductIdentity({ app } = {}) {
  requireElectronApp(app);
  app.setName(DESKTOP_PRODUCT_NAME);
  const appDataPath = path.resolve(app.getPath("appData"));
  const homePath = path.resolve(app.getPath("home"));
  const hasExplicitUserData = app.commandLine?.hasSwitch?.("user-data-dir") === true;
  const userDataPath = hasExplicitUserData
    ? path.resolve(app.getPath("userData"))
    : path.join(appDataPath, DESKTOP_PRODUCT_NAME);
  const legacyUserDataPath = path.join(appDataPath, LEGACY_USER_DATA_DIRECTORY);
  const legacyStudioPath = path.join(homePath, LEGACY_STUDIO_DIRECTORY);
  if (!hasExplicitUserData) app.setPath("userData", userDataPath);
  return Object.freeze({
    appDataPath,
    homePath,
    userDataPath,
    legacyUserDataPath,
    legacyStudioPath,
    migrationEnabled: !hasExplicitUserData,
  });
}

async function entryState(target) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) return "invalid";
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "invalid";
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
}

async function copyDirectoryOnce(source, destination, migrationId) {
  const state = await entryState(source);
  if (state === "missing") return false;
  if (state !== "directory") throw new Error(`Legacy DreamSkin data is not a regular directory: ${source}`);
  const destinationState = await entryState(destination);
  if (destinationState === "directory") return false;
  if (destinationState !== "missing") {
    throw new Error(`DreamSkin user data destination is not a regular directory: ${destination}`);
  }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const staging = `${destination}.migration-${migrationId}`;
  await fs.rm(staging, { recursive: true, force: true });
  try {
    await fs.cp(source, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    try {
      await fs.rename(staging, destination);
      return true;
    } catch (error) {
      if (error.code === "EEXIST" || error.code === "ENOTEMPTY") return false;
      throw error;
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function copyFilesOnce(sourceRoot, destinationRoot) {
  if (await entryState(sourceRoot) === "missing") return 0;
  if (await entryState(sourceRoot) !== "directory") {
    throw new Error(`Legacy DreamSkin data is not a regular directory: ${sourceRoot}`);
  }
  await fs.mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  let copied = 0;
  for (const entry of await fs.readdir(sourceRoot, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const destination = path.join(destinationRoot, entry.name);
    if (await entryState(destination) !== "missing") continue;
    try {
      await fs.copyFile(path.join(sourceRoot, entry.name), destination, fs.constants.COPYFILE_EXCL);
      copied += 1;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  return copied;
}

function validLibrary(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.schemaVersion === 1
    && value.settings
    && typeof value.settings === "object"
    && !Array.isArray(value.settings)
    && Array.isArray(value.entries);
}

async function readLibrary(file, { required = false } = {}) {
  const state = await entryState(file);
  if (state === "missing" && !required) return null;
  if (state !== "file") throw new Error(`DreamSkin library is not a regular file: ${file}`);
  let value;
  try {
    value = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`DreamSkin library is not valid JSON: ${file}`, { cause: error });
  }
  if (!validLibrary(value)) throw new Error(`DreamSkin library has an unsupported structure: ${file}`);
  return value;
}

async function mergeLibrary({ source, destination, pluginId }) {
  const incoming = await readLibrary(source);
  if (!incoming) return 0;
  const current = await readLibrary(destination);
  const existing = new Set((current?.entries || []).map((entry) => entry?.id).filter(Boolean));
  const additions = incoming.entries
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .filter((entry) => typeof entry.id === "string" && entry.id && !existing.has(entry.id))
    .map((entry) => ({ ...entry, pluginId }));
  if (current && additions.length === 0) return 0;
  const merged = {
    schemaVersion: 1,
    settings: current?.settings || incoming.settings,
    entries: [...(current?.entries || []), ...additions],
  };
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.migration-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return additions.length;
}

function migrationWarning(source, operation, error) {
  return Object.freeze({
    source,
    operation,
    code: typeof error?.code === "string" ? error.code : null,
    message: error instanceof Error ? error.message : String(error),
  });
}

function operationKey(source, operation) {
  return `${source}:${operation}`;
}

async function attemptMigration({
  source,
  operation,
  warnings,
  completedOperations,
  pendingOperations,
}, execute) {
  const key = operationKey(source, operation);
  if (pendingOperations && !pendingOperations.has(key)) return 0;
  try {
    const copied = await execute();
    completedOperations.add(key);
    return copied;
  } catch (error) {
    warnings.push(migrationWarning(source, operation, error));
    return 0;
  }
}

async function migrateDirectoryChildren({
  sourceRoot,
  destinationRoot,
  migrationId,
  source,
  operation,
  warnings,
  completedOperations,
  pendingOperations,
  excludeNames = [],
}) {
  const rootKey = operationKey(source, operation);
  const childPrefix = `${rootKey}/`;
  const pendingChildren = pendingOperations
    ? [...pendingOperations].filter((key) => key.startsWith(childPrefix))
    : [];
  const retryRoot = pendingOperations?.has(rootKey) === true;
  if (pendingOperations && !retryRoot && pendingChildren.length === 0) return 0;

  let entries;
  try {
    const state = await entryState(sourceRoot);
    if (state === "missing") {
      completedOperations.add(rootKey);
      for (const key of pendingChildren) completedOperations.add(key);
      return 0;
    }
    if (state !== "directory") {
      throw new Error(`Legacy DreamSkin data is not a regular directory: ${sourceRoot}`);
    }
    entries = await fs.readdir(sourceRoot, { withFileTypes: true });
    completedOperations.add(rootKey);
  } catch (error) {
    if (pendingChildren.length > 0 && !retryRoot) {
      for (const key of pendingChildren) {
        warnings.push(migrationWarning(source, key.slice(`${source}:`.length), error));
      }
    } else {
      warnings.push(migrationWarning(source, operation, error));
    }
    return 0;
  }

  const excluded = new Set(excludeNames);
  const directories = entries.filter((entry) => (
    entry.isDirectory() && !entry.isSymbolicLink() && !excluded.has(entry.name)
  ));
  const presentChildKeys = new Set(directories.map((entry) => `${childPrefix}${entry.name}`));
  let copied = 0;
  for (const entry of directories) {
    const childOperation = `${operation}/${entry.name}`;
    const childKey = operationKey(source, childOperation);
    if (pendingOperations && !retryRoot && !pendingOperations.has(childKey)) continue;
    try {
      if (await copyDirectoryOnce(
        path.join(sourceRoot, entry.name),
        path.join(destinationRoot, entry.name),
        `${migrationId}-${entry.name}`,
      )) copied += 1;
      completedOperations.add(childKey);
    } catch (error) {
      completedOperations.delete(childKey);
      warnings.push(migrationWarning(source, childOperation, error));
    }
  }

  for (const key of pendingChildren) {
    if (!presentChildKeys.has(key)) completedOperations.add(key);
  }
  return copied;
}

async function migrateNamespacedDesktopData({
  sourceRoot,
  destinationRoot,
  migrationId,
  warnings,
  completedOperations,
  pendingOperations,
}) {
  const sourceState = await entryState(sourceRoot);
  if (sourceState !== "missing" && sourceState !== "directory") {
    throw new Error(`Legacy DreamSkin data is not a regular directory: ${sourceRoot}`);
  }
  let themes = 0;
  let backups = 0;
  let libraryEntries = 0;
  for (const pluginId of TARGETS) {
    const context = {
      source: "legacy-electron",
      warnings,
      completedOperations,
      pendingOperations,
    };
    themes += await migrateDirectoryChildren({
      ...context,
      operation: `${pluginId}:themes`,
      sourceRoot: path.join(sourceRoot, "themes", pluginId),
      destinationRoot: path.join(destinationRoot, "themes", pluginId),
      migrationId: `${migrationId}-${pluginId}-theme`,
    });
    backups += await migrateDirectoryChildren({
      ...context,
      operation: `${pluginId}:backups`,
      sourceRoot: path.join(sourceRoot, "backups", pluginId),
      destinationRoot: path.join(destinationRoot, "backups", pluginId),
      migrationId: `${migrationId}-${pluginId}-backup`,
    });
    backups += await migrateDirectoryChildren({
      ...context,
      operation: `${pluginId}:state-backups`,
      sourceRoot: path.join(sourceRoot, "state", pluginId, "backups"),
      destinationRoot: path.join(destinationRoot, "backups", pluginId),
      migrationId: `${migrationId}-${pluginId}-state-backup`,
    });
    libraryEntries += await attemptMigration({ ...context, operation: `${pluginId}:library` }, () => (
      mergeLibrary({
        source: path.join(sourceRoot, "state", pluginId, "library.json"),
        destination: path.join(destinationRoot, "state", pluginId, "library.json"),
        pluginId,
      })
    ));
  }
  const previews = await attemptMigration({
    source: "legacy-electron",
    operation: "previews",
    warnings,
    completedOperations,
    pendingOperations,
  }, () => copyFilesOnce(
    path.join(sourceRoot, "previews"),
    path.join(destinationRoot, "previews"),
  ));
  return { themes, backups, libraryEntries, previews };
}

async function migrateWebStudioData({
  sourceRoot,
  destinationRoot,
  migrationId,
  warnings,
  completedOperations,
  pendingOperations,
}) {
  const sourceState = await entryState(sourceRoot);
  if (sourceState !== "missing" && sourceState !== "directory") {
    throw new Error(`Legacy Studio data is not a regular directory: ${sourceRoot}`);
  }
  let themes = 0;
  const context = {
    source: "legacy-web",
    warnings,
    completedOperations,
    pendingOperations,
  };
  themes += await migrateDirectoryChildren({
    ...context,
    operation: "dreamskin.trae:themes",
    sourceRoot: path.join(sourceRoot, "themes"),
    destinationRoot: path.join(destinationRoot, "themes", "dreamskin.trae"),
    migrationId: `${migrationId}-web-trae-theme`,
    excludeNames: TARGETS,
  });
  themes += await migrateDirectoryChildren({
    ...context,
    operation: "dreamskin.workbuddy:themes",
    sourceRoot: path.join(sourceRoot, "themes", "dreamskin.workbuddy"),
    destinationRoot: path.join(destinationRoot, "themes", "dreamskin.workbuddy"),
    migrationId: `${migrationId}-web-workbuddy-theme`,
  });
  const backups = await migrateDirectoryChildren({
    ...context,
    operation: "dreamskin.trae:backups",
    sourceRoot: path.join(sourceRoot, "data", "backups"),
    destinationRoot: path.join(destinationRoot, "backups", "dreamskin.trae"),
    migrationId: `${migrationId}-web-trae-backup`,
  }) + await migrateDirectoryChildren({
    ...context,
    operation: "dreamskin.workbuddy:backups",
    sourceRoot: path.join(sourceRoot, "data", "dreamskin.workbuddy", "backups"),
    destinationRoot: path.join(destinationRoot, "backups", "dreamskin.workbuddy"),
    migrationId: `${migrationId}-web-workbuddy-backup`,
  });
  const libraryEntries = await attemptMigration({ ...context, operation: "dreamskin.trae:library" }, () => mergeLibrary({
    source: path.join(sourceRoot, "library.json"),
    destination: path.join(destinationRoot, "state", "dreamskin.trae", "library.json"),
    pluginId: "dreamskin.trae",
  })) + await attemptMigration({ ...context, operation: "dreamskin.workbuddy:library" }, () => mergeLibrary({
    source: path.join(sourceRoot, "libraries", "dreamskin.workbuddy.json"),
    destination: path.join(destinationRoot, "state", "dreamskin.workbuddy", "library.json"),
    pluginId: "dreamskin.workbuddy",
  }));
  const previews = await attemptMigration({ ...context, operation: "previews" }, () => copyFilesOnce(
    path.join(sourceRoot, "data", "previews"),
    path.join(destinationRoot, "previews"),
  ));
  return { themes, backups, libraryEntries, previews };
}

function addCounts(left, right) {
  return Object.freeze({
    themes: left.themes + right.themes,
    backups: left.backups + right.backups,
    libraryEntries: left.libraryEntries + right.libraryEntries,
    previews: left.previews + right.previews,
  });
}

function markerOperations(marker) {
  return new Set(
    (Array.isArray(marker?.completedOperations) ? marker.completedOperations : [])
      .filter((operation) => typeof operation === "string" && operation),
  );
}

function pendingMarkerOperations(marker, markerPath) {
  const operations = new Set(
    (Array.isArray(marker?.warnings) ? marker.warnings : [])
      .filter((warning) => (
        typeof warning?.source === "string"
        && warning.source
        && typeof warning?.operation === "string"
        && warning.operation
      ))
      .map((warning) => operationKey(warning.source, warning.operation)),
  );
  if (operations.size === 0) {
    throw new Error(`DreamSkin partial legacy migration marker has no retryable operations: ${markerPath}`);
  }
  return operations;
}

function hasPendingSource(pendingOperations, source) {
  if (!pendingOperations) return true;
  const prefix = `${source}:`;
  return [...pendingOperations].some((operation) => operation.startsWith(prefix));
}

function pendingFilterForSource(pendingOperations, source) {
  if (!pendingOperations || pendingOperations.has(operationKey(source, "source"))) return null;
  return pendingOperations;
}

function recordSourceFailure({ source, error, warnings, pendingOperations }) {
  const sourceFailure = operationKey(source, "source");
  const prefix = `${source}:`;
  const pending = pendingOperations
    ? [...pendingOperations].filter((operation) => operation.startsWith(prefix))
    : [];
  if (pending.length > 0 && !pending.includes(sourceFailure)) {
    for (const operation of pending) {
      warnings.push(migrationWarning(source, operation.slice(prefix.length), error));
    }
    return;
  }
  warnings.push(migrationWarning(source, "source", error));
}

export async function migrateLegacyDreamSkinData({
  legacyUserDataPath,
  legacyStudioPath = null,
  userDataPath,
  migrationId = `${process.pid}-${Date.now()}`,
  now = () => new Date(),
} = {}) {
  if (!legacyUserDataPath || !userDataPath) {
    throw new TypeError("Legacy data migration requires source and destination user-data paths.");
  }
  const destinationRoot = path.join(path.resolve(userDataPath), "dreamskin");
  await fs.mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const markerPath = path.join(destinationRoot, LEGACY_MIGRATION_MARKER);
  const markerState = await entryState(markerPath);
  let previousMarker = null;
  if (markerState === "file") {
    previousMarker = JSON.parse(await fs.readFile(markerPath, "utf8"));
    if (previousMarker?.schemaVersion !== 1 || !["completed", "partial"].includes(previousMarker?.status)) {
      throw new Error(`DreamSkin legacy migration marker is invalid: ${markerPath}`);
    }
    if (previousMarker.status === "completed") {
      return Object.freeze({
        migrated: false,
        reason: "already-completed",
        destinationRoot,
        markerPath,
        status: previousMarker.status,
        copied: Object.freeze({ ...EMPTY_COUNTS, ...(previousMarker.copied || {}) }),
        warnings: Object.freeze(Array.isArray(previousMarker.warnings)
          ? previousMarker.warnings.map(Object.freeze)
          : []),
        completedOperations: Object.freeze([...markerOperations(previousMarker)].sort()),
      });
    }
  }
  if (markerState !== "missing") {
    if (markerState !== "file") {
      throw new Error(`DreamSkin legacy migration marker is not a regular file: ${markerPath}`);
    }
  }

  const previousCopied = Object.freeze({ ...EMPTY_COUNTS, ...(previousMarker?.copied || {}) });
  const pendingOperations = previousMarker
    ? pendingMarkerOperations(previousMarker, markerPath)
    : null;
  const completedOperations = markerOperations(previousMarker);
  for (const operation of pendingOperations || []) completedOperations.delete(operation);
  const warnings = [];
  const legacyElectronRoot = path.join(path.resolve(legacyUserDataPath), "dreamskin");
  let desktop = { ...EMPTY_COUNTS };
  if (hasPendingSource(pendingOperations, "legacy-electron")) {
    try {
      desktop = await migrateNamespacedDesktopData({
        sourceRoot: legacyElectronRoot,
        destinationRoot,
        migrationId,
        warnings,
        completedOperations,
        pendingOperations: pendingFilterForSource(pendingOperations, "legacy-electron"),
      });
    } catch (error) {
      recordSourceFailure({
        source: "legacy-electron",
        error,
        warnings,
        pendingOperations,
      });
    }
  }
  let web = { ...EMPTY_COUNTS };
  if (legacyStudioPath && hasPendingSource(pendingOperations, "legacy-web")) {
    try {
      web = await migrateWebStudioData({
        sourceRoot: path.resolve(legacyStudioPath),
        destinationRoot,
        migrationId,
        warnings,
        completedOperations,
        pendingOperations: pendingFilterForSource(pendingOperations, "legacy-web"),
      });
    } catch (error) {
      recordSourceFailure({
        source: "legacy-web",
        error,
        warnings,
        pendingOperations,
      });
    }
  }
  const attemptedCopied = addCounts(desktop, web);
  const copied = addCounts(previousCopied, attemptedCopied);
  const migrated = Object.values(attemptedCopied).some((count) => count > 0);
  const status = warnings.length ? "partial" : "completed";
  const serializedCompletedOperations = Object.freeze([...completedOperations].sort());
  const marker = {
    schemaVersion: 1,
    status,
    completedAt: now().toISOString(),
    sources: {
      legacyElectron: legacyElectronRoot,
      legacyWeb: legacyStudioPath ? path.resolve(legacyStudioPath) : null,
    },
    copied,
    warnings,
    completedOperations: serializedCompletedOperations,
  };
  const temporaryMarker = `${markerPath}.tmp-${migrationId}`;
  try {
    await fs.writeFile(temporaryMarker, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryMarker, markerPath);
  } finally {
    await fs.rm(temporaryMarker, { force: true });
  }
  return Object.freeze({
    migrated,
    reason: warnings.length ? "legacy-data-partially-copied" : (migrated ? "legacy-data-copied" : "nothing-to-migrate"),
    destinationRoot,
    markerPath,
    status,
    copied,
    warnings: Object.freeze(warnings.map(Object.freeze)),
    completedOperations: serializedCompletedOperations,
  });
}
