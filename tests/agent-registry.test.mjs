import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AgentRegistry,
  executableSearchPath,
  findExecutable,
} from "../src/core/agent-registry.mjs";

async function executable(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  await fs.chmod(filePath, 0o755);
}

test("findExecutable prefers an external CLI while adapters can prefer the project bin", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-agent-path-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const externalBin = path.join(root, "external", "bin");
  const projectBin = path.join(root, "project", "node_modules", ".bin");
  const externalCodex = path.join(externalBin, "codex");
  const bundledCodex = path.join(projectBin, "codex");
  await executable(externalCodex);
  await executable(bundledCodex);

  const envPath = [projectBin, externalBin].join(path.delimiter);
  assert.equal(await findExecutable("codex", {
    envPath,
    projectRoot: path.join(root, "project"),
    preferProject: false,
  }), externalCodex);
  assert.equal(await findExecutable("codex", {
    envPath,
    projectRoot: path.join(root, "project"),
    preferProject: true,
  }), bundledCodex);
});

test("macOS GUI search path augments an injected PATH without using a shell", () => {
  const searchPath = executableSearchPath({
    envPath: "/custom/gui/bin",
    platform: "darwin",
    homeDir: "/Users/dreamskin",
    executablePath: "/Applications/DreamSkin Studio.app/Contents/MacOS/DreamSkin Studio",
  }).split(path.delimiter);

  assert.equal(searchPath[0], "/custom/gui/bin");
  assert.ok(searchPath.includes("/opt/homebrew/bin"));
  assert.ok(searchPath.includes("/usr/local/bin"));
  assert.ok(searchPath.includes("/Users/dreamskin/.volta/bin"));
  assert.ok(searchPath.includes("/Users/dreamskin/Library/pnpm"));
});

test("AgentRegistry resolves the CLI externally and the ACP adapter from the project", async () => {
  const calls = [];
  let versionEnvironment;
  const definition = {
    id: "codex",
    name: "Codex CLI",
    command: "codex",
    versionArgs: ["--version"],
    adapter: "codex-acp",
    adapterArgs: [],
    initial: "C",
  };
  const registry = new AgentRegistry({
    definitions: [definition],
    projectRoot: "/Applications/DreamSkin/resources",
    platform: "darwin",
    homeDir: "/Users/dreamskin",
    executablePath: "/Applications/DreamSkin Studio.app/Contents/MacOS/DreamSkin Studio",
    env: { PATH: "/gui/bin" },
    find: async (command, options) => {
      calls.push({ command, options });
      return command === "codex" ? "/external/bin/codex" : "/Applications/DreamSkin/resources/node_modules/.bin/codex-acp";
    },
    version: async (_filePath, _args, options) => {
      versionEnvironment = options.env;
      return "codex-cli 1.0";
    },
  });

  const agent = await registry.resolve("codex");
  assert.equal(calls[0].command, "codex");
  assert.equal(calls[0].options.preferProject, false);
  assert.equal(calls[1].command, "codex-acp");
  assert.equal(calls[1].options.preferProject, true);
  assert.equal(agent.runtime.commandPath, "/external/bin/codex");
  assert.equal(agent.runtime.adapterPath, "/Applications/DreamSkin/resources/node_modules/.bin/codex-acp");
  assert.equal(versionEnvironment.PATH, agent.runtime.envPath);
  assert.equal(agent.state, "detected");
});

test("AgentRegistry accepts an explicit adapter executable", async () => {
  const calls = [];
  const registry = new AgentRegistry({
    definitions: [{
      id: "codex",
      name: "Codex CLI",
      command: "codex",
      versionArgs: [],
      adapter: "codex-acp",
      adapterArgs: [],
      initial: "C",
    }],
    adapterPaths: { "codex-acp": "/opt/dreamskin/helpers/codex-acp" },
    find: async (command, options) => {
      calls.push({ command, options });
      return command;
    },
    version: async () => "",
  });

  const agent = await registry.resolve("codex");
  assert.equal(calls[1].command, "/opt/dreamskin/helpers/codex-acp");
  assert.equal(calls[1].options.preferProject, false);
  assert.equal(agent.runtime.adapterPath, "/opt/dreamskin/helpers/codex-acp");
});
