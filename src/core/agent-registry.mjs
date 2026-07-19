import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { PROJECT_ROOT } from "./paths.mjs";

const execFile = promisify(execFileCallback);

const AGENTS = Object.freeze([
  {
    id: "codex",
    name: "Codex CLI",
    command: "codex",
    versionArgs: ["--version"],
    adapter: "codex-acp",
    adapterArgs: [],
    initial: "C",
  },
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    versionArgs: ["--version"],
    adapter: "claude-agent-acp",
    adapterArgs: [],
    initial: "A",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    command: "gemini",
    versionArgs: ["--version"],
    adapter: "gemini",
    adapterArgs: ["--acp"],
    initial: "G",
  },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    versionArgs: ["--version"],
    adapter: null,
    adapterArgs: [],
    initial: "O",
  },
]);

async function isExecutable(filePath) {
  try {
    await fs.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function uniqueDirectories(directories) {
  const seen = new Set();
  return directories.filter((directory) => {
    if (!directory) return false;
    const resolved = path.resolve(directory);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

export function executableSearchPath({
  envPath = process.env.PATH || "",
  platform = process.platform,
  homeDir = os.homedir(),
  executablePath = process.execPath,
  npmPrefix = process.env.npm_config_prefix || "",
} = {}) {
  const directories = envPath.split(path.delimiter).filter(Boolean);
  directories.push(path.dirname(executablePath));
  if (npmPrefix) directories.push(path.join(npmPrefix, "bin"));
  if (platform === "darwin") {
    directories.push(
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      path.join(homeDir, ".local", "bin"),
      path.join(homeDir, "bin"),
      path.join(homeDir, ".npm-global", "bin"),
      path.join(homeDir, ".volta", "bin"),
      path.join(homeDir, ".bun", "bin"),
      path.join(homeDir, ".asdf", "shims"),
      path.join(homeDir, ".local", "share", "mise", "shims"),
      path.join(homeDir, "Library", "pnpm"),
    );
  }
  return uniqueDirectories(directories).join(path.delimiter);
}

export async function findExecutable(command, {
  envPath = process.env.PATH || "",
  projectRoot = PROJECT_ROOT,
  platform = process.platform,
  preferProject = false,
  pathExt = process.env.PATHEXT || ".EXE;.CMD;.BAT",
} = {}) {
  if (!command) return null;
  if (path.isAbsolute(command)) return (await isExecutable(command)) ? command : null;
  if (command.includes(path.sep) || (path.sep === "\\" && command.includes("/"))) {
    const candidate = path.resolve(projectRoot, command);
    return (await isExecutable(candidate)) ? candidate : null;
  }
  const extensions = platform === "win32"
    ? pathExt.split(";")
    : [""];
  const projectBin = path.join(projectRoot, "node_modules", ".bin");
  const resolvedProjectBin = path.resolve(projectBin);
  const pathDirectories = envPath.split(path.delimiter)
    .filter(Boolean)
    .filter((directory) => path.resolve(directory) !== resolvedProjectBin);
  const directories = uniqueDirectories(preferProject
    ? [projectBin, ...pathDirectories]
    : [...pathDirectories, projectBin]);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

async function executableVersion(filePath, args, { env = process.env } = {}) {
  if (!filePath) return "";
  try {
    const { stdout, stderr } = await execFile(filePath, args, {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
      shell: false,
      env,
    });
    return String(stdout || stderr || "").trim().split(/\r?\n/, 1)[0].slice(0, 120);
  } catch {
    return "";
  }
}

function configuredPath(paths, definition) {
  if (paths instanceof Map) return paths.get(definition.id) || paths.get(definition.command) || null;
  return paths?.[definition.id] || paths?.[definition.command] || null;
}

export class AgentRegistry {
  constructor({
    definitions = AGENTS,
    find = findExecutable,
    version = executableVersion,
    env = process.env,
    envPath,
    projectRoot = PROJECT_ROOT,
    platform = process.platform,
    homeDir = os.homedir(),
    executablePath = process.execPath,
    commandPaths = {},
    adapterPaths = {},
  } = {}) {
    this.definitions = definitions;
    this.find = find;
    this.version = version;
    this.env = env;
    this.projectRoot = path.resolve(projectRoot);
    this.platform = platform;
    this.commandPaths = commandPaths;
    this.adapterPaths = adapterPaths;
    this.envPath = executableSearchPath({
      envPath: envPath ?? env.PATH ?? "",
      platform,
      homeDir,
      executablePath,
      npmPrefix: env.npm_config_prefix || "",
    });
  }

  async inspect(definition) {
    const configuredCommand = configuredPath(this.commandPaths, definition)
      || definition.commandPath
      || (definition.id === "codex" ? this.env.DREAMSKIN_CODEX_PATH || this.env.CODEX_PATH : null);
    const commandPath = await this.find(configuredCommand || definition.command, {
      envPath: this.envPath,
      projectRoot: this.projectRoot,
      platform: this.platform,
      preferProject: false,
      pathExt: this.env.PATHEXT,
    });
    const adapterDefinition = definition.adapter ? { ...definition, command: definition.adapter } : null;
    const configuredAdapter = adapterDefinition
      ? configuredPath(this.adapterPaths, adapterDefinition) || definition.adapterPath
      : null;
    const adapterPath = definition.adapter ? await this.find(configuredAdapter || definition.adapter, {
      envPath: this.envPath,
      projectRoot: this.projectRoot,
      platform: this.platform,
      preferProject: !configuredAdapter,
      pathExt: this.env.PATHEXT,
    }) : null;
    const version = await this.version(commandPath, definition.versionArgs, {
      env: { ...this.env, PATH: this.envPath },
    });
    const acpReady = Boolean(commandPath && adapterPath);
    return {
      id: definition.id,
      name: definition.name,
      command: definition.command,
      version,
      initial: definition.initial,
      state: !commandPath ? "missing" : acpReady ? "detected" : "unsupported",
      capabilities: {
        acp: acpReady,
        tool: acpReady,
        toolTransport: acpReady ? "stdio-compat" : null,
      },
      runtime: {
        commandPath,
        adapterPath,
        adapterArgs: [...definition.adapterArgs],
        envPath: this.envPath,
      },
    };
  }

  async scan() {
    return Promise.all(this.definitions.map((definition) => this.inspect(definition)));
  }

  async resolve(id) {
    const definition = this.definitions.find((candidate) => candidate.id === id);
    if (!definition) return null;
    return this.inspect(definition);
  }

  public(agent, connectedId = null) {
    const { runtime: _runtime, ...fields } = agent;
    return {
      ...fields,
      state: agent.id === connectedId ? "connected" : agent.state,
    };
  }
}
