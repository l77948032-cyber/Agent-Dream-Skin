import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli.mjs";

function outputBuffer() {
  let value = "";
  return { write: (chunk) => { value += chunk; }, get value() { return value; } };
}

test("JSON CLI dispatches commands and emits one success envelope", async () => {
  const stdout = outputBuffer();
  const service = { themeList: async () => ({ count: 2 }) };
  const code = await runCli(["theme", "list"], service, {
    stdout,
    stderr: outputBuffer(),
    stdin: async () => "",
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.value), { ok: true, result: { count: 2 } });
});

test("JSON CLI emits stable structured errors", async () => {
  const stdout = outputBuffer();
  const code = await runCli(["not-a-command"], {}, {
    stdout,
    stderr: outputBuffer(),
    stdin: async () => "",
  });
  assert.equal(code, 1);
  const result = JSON.parse(stdout.value);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENT");
});
