import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const JSON_TARGETS = Object.freeze([
  { file: "package.json", paths: [["version"]] },
  { file: "package-lock.json", paths: [["version"], ["packages", "", "version"]] },
  { file: "studio/package.json", paths: [["version"]] },
  { file: "studio/package-lock.json", paths: [["version"], ["packages", "", "version"]] },
  { file: "plugins/trae/plugin.json", paths: [["version"]] },
  { file: "plugins/workbuddy/plugin.json", paths: [["version"]] },
]);

const SOURCE_TARGETS = Object.freeze([
  {
    file: "src/core/service.mjs",
    pattern: /(export const AGENT_TOOL_VERSION = ")([^"]+)(";)/,
  },
  {
    file: "scripts/common-macos.sh",
    pattern: /(SKIN_VERSION=")([^"]+)(")/,
  },
  {
    file: "scripts/injector.mjs",
    pattern: /(export const SKIN_VERSION = ")([^"]+)(";)/,
  },
  {
    file: "scripts/common-workbuddy-macos.sh",
    pattern: /(SKIN_VERSION=")([^"]+)(")/,
  },
  {
    file: "scripts/common-windows.ps1",
    pattern: /(\$Script:TraeSkinVersion = ')([^']+)(')/,
  },
  {
    file: "scripts/workbuddy-injector.mjs",
    pattern: /(export const WORKBUDDY_SKIN_VERSION = ")([^"]+)(";)/,
  },
]);

export function normalizeProductVersion(value) {
  if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) {
    throw new TypeError(`Product version must be valid SemVer: ${String(value)}`);
  }
  return value;
}

function readPath(value, segments, file) {
  let current = value;
  for (const segment of segments) current = current?.[segment];
  if (typeof current !== "string") {
    throw new Error(`Missing product version at ${file}:${segments.join(".")}`);
  }
  return current;
}

function writePath(value, segments, version, file) {
  let current = value;
  for (const segment of segments.slice(0, -1)) {
    current = current?.[segment];
    if (!current || typeof current !== "object") {
      throw new Error(`Missing product version at ${file}:${segments.join(".")}`);
    }
  }
  const leaf = segments.at(-1);
  if (typeof current?.[leaf] !== "string") {
    throw new Error(`Missing product version at ${file}:${segments.join(".")}`);
  }
  current[leaf] = version;
}

export async function inspectProductVersions({ projectRoot = PROJECT_ROOT } = {}) {
  const records = [];
  for (const target of JSON_TARGETS) {
    const absolute = path.join(projectRoot, target.file);
    const value = JSON.parse(await fs.readFile(absolute, "utf8"));
    for (const segments of target.paths) {
      records.push({ file: target.file, location: segments.join("."), version: readPath(value, segments, target.file) });
    }
  }
  for (const target of SOURCE_TARGETS) {
    const source = await fs.readFile(path.join(projectRoot, target.file), "utf8");
    const match = source.match(target.pattern);
    if (!match) throw new Error(`Missing product version declaration in ${target.file}`);
    records.push({ file: target.file, location: "source", version: match[2] });
  }
  const expected = records.find((record) => record.file === "package.json" && record.location === "version")?.version;
  const mismatches = records.filter((record) => record.version !== expected);
  return Object.freeze({
    ok: mismatches.length === 0,
    version: expected,
    records: Object.freeze(records.map(Object.freeze)),
    mismatches: Object.freeze(mismatches.map(Object.freeze)),
  });
}

export async function setProductVersion(version, { projectRoot = PROJECT_ROOT } = {}) {
  const normalized = normalizeProductVersion(version);
  for (const target of JSON_TARGETS) {
    const absolute = path.join(projectRoot, target.file);
    const value = JSON.parse(await fs.readFile(absolute, "utf8"));
    for (const segments of target.paths) writePath(value, segments, normalized, target.file);
    await fs.writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`);
  }
  for (const target of SOURCE_TARGETS) {
    const absolute = path.join(projectRoot, target.file);
    const source = await fs.readFile(absolute, "utf8");
    if (!target.pattern.test(source)) throw new Error(`Missing product version declaration in ${target.file}`);
    target.pattern.lastIndex = 0;
    await fs.writeFile(absolute, source.replace(target.pattern, `$1${normalized}$3`));
  }
  const result = await inspectProductVersions({ projectRoot });
  if (!result.ok) throw new Error(`Product version update is incomplete: ${JSON.stringify(result.mismatches)}`);
  return result;
}

export async function runProductVersionCommand(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--check") {
    const result = await inspectProductVersions();
    if (!result.ok) {
      const detail = result.mismatches.map((record) => `${record.file}:${record.location}=${record.version}`).join(", ");
      throw new Error(`Product version ${result.version} is not synchronized: ${detail}`);
    }
    return result;
  }
  if (argv.length === 2 && argv[0] === "--set") return setProductVersion(argv[1]);
  throw new Error("Usage: node scripts/product-version.mjs --check | --set <version>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  runProductVersionCommand()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
