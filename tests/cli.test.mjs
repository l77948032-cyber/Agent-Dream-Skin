import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DREAMSKIN_CLI_PROTOCOL_VERSION,
  MAX_CLI_INPUT_BYTES,
  runCli,
} from "../src/cli.mjs";
import { ToolError } from "../src/core/errors.mjs";
import { MAX_ART_BYTES } from "../src/core/theme-model.mjs";

const TRAE = "dreamskin.trae";
const WORKBUDDY = "dreamskin.workbuddy";

function outputBuffer() {
  const writes = [];
  return {
    write(chunk) { writes.push(String(chunk)); },
    get value() { return writes.join(""); },
    get writes() { return [...writes]; },
  };
}

function runtimeFixture({ targets = [], execute } = {}) {
  const calls = [];
  return {
    calls,
    targets: () => structuredClone(targets),
    tool: {
      async execute(input) {
        calls.push(structuredClone(input));
        if (execute) return execute(input);
        return { action: input.action };
      },
    },
  };
}

async function invoke(argv, runtime = runtimeFixture(), { stdin = "" } = {}) {
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const code = await runCli(argv, runtime, {
    stdout,
    stderr,
    stdin: async () => stdin,
  });
  assert.equal(stdout.writes.length, 1, "the CLI must emit exactly one stdout document");
  assert.doesNotThrow(() => JSON.parse(stdout.value));
  assert.equal(stdout.value.endsWith("\n"), true);
  return { code, stdout, stderr, envelope: JSON.parse(stdout.value) };
}

test("targets emits the stable JSON v1 envelope without invoking the theme tool", async () => {
  const targets = [
    { pluginId: TRAE, targetId: "trae", name: "Trae", version: "1.0.0", active: true },
    { pluginId: WORKBUDDY, targetId: "workbuddy", name: "WorkBuddy", version: "1.0.0", active: true },
  ];
  const runtime = runtimeFixture({ targets });

  const result = await invoke(["targets"], runtime);

  assert.equal(result.code, 0);
  assert.equal(result.stderr.value, "");
  assert.deepEqual(result.envelope, {
    protocolVersion: DREAMSKIN_CLI_PROTOCOL_VERSION,
    ok: true,
    operation: "targets",
    scope: {},
    result: { targets },
  });
  assert.deepEqual(runtime.calls, []);
});

test("all structured theme actions require explicit target scope and dispatch exact ToolCore input", async () => {
  const literalPatch = { colors: { accent: "#2266aa" } };
  const stdinPatch = { typography: { uiFont: "Inter" } };
  const cases = [
    {
      argv: ["theme", "inspect", "--plugin", TRAE],
      expected: { action: "inspect", pluginId: TRAE },
    },
    {
      argv: ["theme", "list", "--plugin", WORKBUDDY],
      expected: { action: "list", pluginId: WORKBUDDY },
    },
    {
      argv: ["theme", "read", "focus", "--plugin", TRAE],
      expected: { action: "read", pluginId: TRAE, themeId: "focus" },
    },
    {
      argv: [
        "theme", "create", "focus", "--plugin", WORKBUDDY,
        "--input", JSON.stringify(literalPatch), "--source", "blank", "--dry-run",
      ],
      expected: {
        action: "create",
        pluginId: WORKBUDDY,
        themeId: "focus",
        themePatch: literalPatch,
        sourceId: "blank",
        dryRun: true,
      },
    },
    {
      argv: [
        "theme", "update", "focus", "--plugin", TRAE,
        "--expected-revision", "a".repeat(64), "--input", "-", "--dry-run",
      ],
      stdin: JSON.stringify(stdinPatch),
      expected: {
        action: "update",
        pluginId: TRAE,
        themeId: "focus",
        expectedRevision: "a".repeat(64),
        themePatch: stdinPatch,
        dryRun: true,
      },
    },
    {
      argv: ["theme", "validate", "focus", "--plugin", WORKBUDDY],
      expected: { action: "validate", pluginId: WORKBUDDY, themeId: "focus" },
    },
  ];

  for (const fixture of cases) {
    const runtime = runtimeFixture();
    const result = await invoke(fixture.argv, runtime, { stdin: fixture.stdin });
    assert.equal(result.code, 0, fixture.argv.join(" "));
    assert.equal(result.stderr.value, "", fixture.argv.join(" "));
    assert.deepEqual(runtime.calls, [fixture.expected], fixture.argv.join(" "));
    assert.deepEqual(result.envelope, {
      protocolVersion: 1,
      ok: true,
      operation: `theme.${fixture.expected.action}`,
      scope: {
        pluginId: fixture.expected.pluginId,
        ...(fixture.expected.themeId ? { themeId: fixture.expected.themeId } : {}),
      },
      result: { action: fixture.expected.action },
    });
  }
});

test("theme asset import resolves a validated file and dispatches exact ToolCore input", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-cli-asset-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assetPath = path.join(root, "background.png");
  await fs.writeFile(assetPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const runtime = runtimeFixture();

  const result = await invoke([
    "theme", "asset", "import", "focus", "--plugin", TRAE,
    "--expected-revision", "b".repeat(64), "--file", assetPath, "--dry-run",
  ], runtime);

  assert.equal(result.code, 0);
  assert.deepEqual(runtime.calls, [{
    action: "importAsset",
    pluginId: TRAE,
    themeId: "focus",
    assetPath,
    expectedRevision: "b".repeat(64),
    dryRun: true,
  }]);
  assert.equal(result.envelope.operation, "theme.asset.import");
  assert.deepEqual(result.envelope.scope, { pluginId: TRAE, themeId: "focus" });
  assert.equal(result.stdout.value.includes(assetPath), false);
});

test("validate accepts an @file object without exposing the input path", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-cli-input-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputPath = path.join(root, "theme patch.json");
  const theme = { id: "focus", colors: { accent: "#2266aa" } };
  await fs.writeFile(inputPath, JSON.stringify(theme));
  const runtime = runtimeFixture();

  const result = await invoke([
    "theme", "validate", "--plugin", TRAE, "--input", `@${inputPath}`,
  ], runtime);

  assert.equal(result.code, 0);
  assert.deepEqual(runtime.calls, [{ action: "validate", pluginId: TRAE, theme }]);
  assert.equal(result.stdout.value.includes(inputPath), false);
});

test("missing and non-file @input paths return a stable error without exposing paths", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-cli-unavailable-input-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const missingPath = path.join(root, "private", "missing.json");

  for (const inputPath of [missingPath, root]) {
    const runtime = runtimeFixture();
    const result = await invoke([
      "theme", "validate", "--plugin", TRAE, "--input", `@${inputPath}`,
    ], runtime);

    assert.equal(result.code, 1);
    assert.equal(result.envelope.error.code, "INPUT_FILE_UNAVAILABLE");
    assert.equal(result.stdout.value.includes(inputPath), false);
    assert.equal(result.stdout.value.includes("ENOENT"), false);
    assert.deepEqual(runtime.calls, []);
  }
});

test("every theme action rejects omitted plugin scope before calling ToolCore", async () => {
  const commands = [
    ["theme", "inspect"],
    ["theme", "list"],
    ["theme", "read", "focus"],
    ["theme", "create", "focus", "--input", "{}"],
    ["theme", "update", "focus", "--expected-revision", "a".repeat(64), "--input", "{}"],
    ["theme", "validate", "focus"],
    ["theme", "asset", "import", "focus", "--expected-revision", "a".repeat(64), "--file", "image.png"],
  ];

  for (const argv of commands) {
    const runtime = runtimeFixture();
    const result = await invoke(argv, runtime);
    assert.equal(result.code, 1, argv.join(" "));
    assert.equal(result.envelope.error.code, "INVALID_ARGUMENT", argv.join(" "));
    assert.match(result.envelope.error.message, /requires --plugin/);
    assert.deepEqual(runtime.calls, []);
  }
});

test("the parser rejects unknown, duplicate, and extra arguments", async () => {
  const cases = [
    ["theme", "list", "--plugin", TRAE, "--unknown"],
    ["theme", "list", "--plugin", TRAE, "--plugin", WORKBUDDY],
    ["theme", "list", "--plugin", TRAE, "--target", WORKBUDDY],
    ["theme", "read", "one", "two", "--plugin", TRAE],
    ["targets", "extra"],
    ["theme", "asset", "export", "focus", "--plugin", TRAE],
  ];

  for (const argv of cases) {
    const runtime = runtimeFixture();
    const result = await invoke(argv, runtime);
    assert.equal(result.code, 1, argv.join(" "));
    assert.equal(result.envelope.error.code, "INVALID_ARGUMENT", argv.join(" "));
    assert.deepEqual(runtime.calls, []);
  }
});

test("theme commands reject recognized options that do not belong to that action", async () => {
  const cases = [
    ["theme", "inspect", "--plugin", TRAE, "--dry-run"],
    ["theme", "list", "--plugin", TRAE, "--input", "{}"],
    ["theme", "read", "focus", "--plugin", TRAE, "--source", "blank"],
    ["theme", "create", "focus", "--plugin", TRAE, "--input", "{}", "--expected-revision", "old"],
    ["theme", "update", "focus", "--plugin", TRAE, "--input", "{}", "--expected-revision", "old", "--source", "blank"],
    ["theme", "validate", "focus", "--plugin", TRAE, "--dry-run"],
    ["theme", "asset", "import", "focus", "--plugin", TRAE, "--expected-revision", "old", "--file", "image.png", "--input", "{}"],
  ];

  for (const argv of cases) {
    const runtime = runtimeFixture();
    const result = await invoke(argv, runtime);
    assert.equal(result.code, 1, argv.join(" "));
    assert.equal(result.envelope.error.code, "INVALID_ARGUMENT", argv.join(" "));
    assert.deepEqual(runtime.calls, []);
  }
});

test("update requires expectedRevision and validate requires exactly one input source", async () => {
  const cases = [
    ["theme", "update", "focus", "--plugin", TRAE, "--input", "{}"],
    ["theme", "validate", "--plugin", TRAE],
    ["theme", "validate", "focus", "--plugin", TRAE, "--input", "{}"],
    ["theme", "asset", "import", "focus", "--plugin", TRAE, "--file", "image.png"],
    ["theme", "asset", "import", "focus", "--plugin", TRAE, "--expected-revision", "a".repeat(64)],
  ];

  for (const argv of cases) {
    const runtime = runtimeFixture();
    const result = await invoke(argv, runtime);
    assert.equal(result.code, 1, argv.join(" "));
    assert.equal(result.envelope.error.code, "INVALID_ARGUMENT", argv.join(" "));
    assert.deepEqual(runtime.calls, []);
  }
});

test("theme asset import rejects unsafe paths, unsupported types, and oversized files", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-cli-unsafe-asset-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const image = path.join(root, "image.png");
  const link = path.join(root, "linked.png");
  const textFile = path.join(root, "image.txt");
  const oversized = path.join(root, "oversized.png");
  await fs.writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await fs.symlink(image, link);
  await fs.writeFile(textFile, "not an image");
  await fs.writeFile(oversized, "x");
  await fs.truncate(oversized, MAX_ART_BYTES + 1);

  for (const [assetPath, code] of [
    [path.join(root, "missing.png"), "ASSET_NOT_FOUND"],
    [root, "INVALID_ASSET_PATH"],
    [link, "INVALID_ASSET_PATH"],
    [textFile, "INVALID_IMAGE"],
    [oversized, "ASSET_TOO_LARGE"],
  ]) {
    const runtime = runtimeFixture();
    const result = await invoke([
      "theme", "asset", "import", "focus", "--plugin", TRAE,
      "--expected-revision", "a".repeat(64), "--file", assetPath,
    ], runtime);
    assert.equal(result.code, 1, assetPath);
    assert.equal(result.envelope.error.code, code, assetPath);
    assert.equal(result.stdout.value.includes(assetPath), false);
    assert.deepEqual(runtime.calls, []);
  }
});

test("input JSON must parse as an object", async () => {
  const cases = [
    { input: "{", code: "INVALID_JSON" },
    { input: "null", code: "INVALID_ARGUMENT" },
    { input: "[]", code: "INVALID_ARGUMENT" },
    { input: JSON.stringify("text"), code: "INVALID_ARGUMENT" },
  ];

  for (const fixture of cases) {
    const runtime = runtimeFixture();
    const result = await invoke([
      "theme", "create", "focus", "--plugin", TRAE, "--input", fixture.input,
    ], runtime);
    assert.equal(result.code, 1);
    assert.equal(result.envelope.error.code, fixture.code);
    assert.deepEqual(runtime.calls, []);
  }
});

test("literal input accepts exactly 1 MiB and rejects one byte more", async () => {
  const emptyEnvelopeBytes = Buffer.byteLength('{"payload":""}');
  const atLimit = JSON.stringify({ payload: "x".repeat(MAX_CLI_INPUT_BYTES - emptyEnvelopeBytes) });
  const overLimit = JSON.stringify({ payload: "x".repeat(MAX_CLI_INPUT_BYTES - emptyEnvelopeBytes + 1) });
  assert.equal(Buffer.byteLength(atLimit), MAX_CLI_INPUT_BYTES);
  assert.equal(Buffer.byteLength(overLimit), MAX_CLI_INPUT_BYTES + 1);

  const acceptedRuntime = runtimeFixture();
  const accepted = await invoke([
    "theme", "create", "focus", "--plugin", TRAE, "--input", atLimit,
  ], acceptedRuntime);
  assert.equal(accepted.code, 0);
  assert.equal(acceptedRuntime.calls[0].themePatch.payload.length, MAX_CLI_INPUT_BYTES - emptyEnvelopeBytes);

  const rejectedRuntime = runtimeFixture();
  const rejected = await invoke([
    "theme", "create", "focus", "--plugin", TRAE, "--input", overLimit,
  ], rejectedRuntime);
  assert.equal(rejected.code, 1);
  assert.equal(rejected.envelope.error.code, "INPUT_TOO_LARGE");
  assert.deepEqual(rejected.envelope.error.details, {
    bytes: MAX_CLI_INPUT_BYTES + 1,
    maximumBytes: MAX_CLI_INPUT_BYTES,
  });
  assert.deepEqual(rejectedRuntime.calls, []);
});

test("stdin and @file inputs enforce the 1 MiB limit", async (t) => {
  const overLimit = "x".repeat(MAX_CLI_INPUT_BYTES + 1);
  const stdinRuntime = runtimeFixture();
  const stdinResult = await invoke([
    "theme", "create", "focus", "--plugin", TRAE, "--input", "-",
  ], stdinRuntime, { stdin: overLimit });
  assert.equal(stdinResult.code, 1);
  assert.equal(stdinResult.envelope.error.code, "INPUT_TOO_LARGE");
  assert.deepEqual(stdinRuntime.calls, []);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-cli-large-input-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputPath = path.join(root, "large.json");
  await fs.writeFile(inputPath, overLimit);
  const fileRuntime = runtimeFixture();
  const fileResult = await invoke([
    "theme", "create", "focus", "--plugin", TRAE, "--input", `@${inputPath}`,
  ], fileRuntime);
  assert.equal(fileResult.code, 1);
  assert.equal(fileResult.envelope.error.code, "INPUT_TOO_LARGE");
  assert.deepEqual(fileResult.envelope.error.details, {
    bytes: MAX_CLI_INPUT_BYTES + 1,
    maximumBytes: MAX_CLI_INPUT_BYTES,
  });
  assert.deepEqual(fileRuntime.calls, []);
});

test("failure envelopes preserve stable domain details without leaking stack or cause", async () => {
  const cause = new Error("secret filesystem location");
  const runtime = runtimeFixture({
    execute() {
      throw new ToolError(
        "REVISION_CONFLICT",
        "The theme changed since it was read.",
        { expectedRevision: "old", actualRevision: "new" },
        { cause },
      );
    },
  });

  const result = await invoke(["theme", "read", "focus", "--plugin", TRAE], runtime);

  assert.equal(result.code, 1);
  assert.equal(result.stderr.value, "");
  assert.deepEqual(result.envelope, {
    protocolVersion: 1,
    ok: false,
    operation: "theme.read",
    scope: { pluginId: TRAE, themeId: "focus" },
    error: {
      code: "REVISION_CONFLICT",
      message: "The theme changed since it was read.",
      details: { expectedRevision: "old", actualRevision: "new" },
    },
  });
  assert.equal(result.stdout.value.includes("secret filesystem location"), false);
  assert.equal(result.stdout.value.includes("stack"), false);
  assert.equal(result.stdout.value.includes("cause"), false);
});

test("unexpected failures use INTERNAL_ERROR without serializing Error internals", async () => {
  const runtime = runtimeFixture({
    execute() {
      const error = new Error("Unexpected failure");
      error.secret = "do-not-serialize";
      throw error;
    },
  });

  const result = await invoke(["theme", "list", "--plugin", WORKBUDDY], runtime);

  assert.equal(result.code, 1);
  assert.deepEqual(result.envelope.error, {
    code: "INTERNAL_ERROR",
    message: "DreamSkin could not complete the operation.",
  });
  assert.equal(result.stdout.value.includes("Unexpected failure"), false);
  assert.equal(result.stdout.value.includes("do-not-serialize"), false);
});
