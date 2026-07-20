import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectProductVersions,
  normalizeProductVersion,
  setProductVersion,
} from "../scripts/product-version.mjs";

const SOURCE_FIXTURES = Object.freeze({
  "src/core/service.mjs": 'export const AGENT_TOOL_VERSION = "0.1.0";\n',
  "src/core/acp-session-manager.mjs": 'const value = { clientInfo: { name: "dreamskin-studio", version: "0.1.0" } };\n',
  "scripts/common-macos.sh": 'SKIN_VERSION="0.1.0"\n',
  "scripts/injector.mjs": 'export const SKIN_VERSION = "0.1.0";\n',
  "scripts/common-workbuddy-macos.sh": 'SKIN_VERSION="0.1.0"\n',
  "scripts/common-windows.ps1": "$Script:TraeSkinVersion = '0.1.0'\n",
  "scripts/workbuddy-injector.mjs": 'export const WORKBUDDY_SKIN_VERSION = "0.1.0";\n',
});

async function writeJson(root, file, value) {
  const absolute = path.join(root, file);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-product-version-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(root, "package.json", { version: "0.1.0" });
  await writeJson(root, "package-lock.json", { version: "0.1.0", packages: { "": { version: "0.1.0" } } });
  await writeJson(root, "studio/package.json", { version: "0.1.0" });
  await writeJson(root, "studio/package-lock.json", { version: "0.1.0", packages: { "": { version: "0.1.0" } } });
  await writeJson(root, "plugins/trae/plugin.json", { version: "0.1.0" });
  await writeJson(root, "plugins/workbuddy/plugin.json", { version: "0.1.0" });
  for (const [file, source] of Object.entries(SOURCE_FIXTURES)) {
    const absolute = path.join(root, file);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, source);
  }
  return root;
}

test("product versions accept stable and prerelease SemVer", () => {
  assert.equal(normalizeProductVersion("1.2.3"), "1.2.3");
  assert.equal(normalizeProductVersion("1.2.3-beta.1"), "1.2.3-beta.1");
  assert.throws(() => normalizeProductVersion("v1.2"), /valid SemVer/);
});

test("product version command updates every shipping version declaration", async (t) => {
  const root = await fixture(t);
  const result = await setProductVersion("0.3.0", { projectRoot: root });
  assert.equal(result.ok, true);
  assert.equal(result.version, "0.3.0");
  assert.equal(result.records.length, 15);
  assert.ok(result.records.every((record) => record.version === "0.3.0"));
});

test("product version inspection reports drift", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "scripts/injector.mjs"), 'export const SKIN_VERSION = "9.9.9";\n');
  const result = await inspectProductVersions({ projectRoot: root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches.map((record) => record.file), ["scripts/injector.mjs"]);
});
