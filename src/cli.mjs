import fs from "node:fs/promises";

import { errorEnvelope, ToolError } from "./core/errors.mjs";
import { TraeDreamSkinService } from "./core/service.mjs";

function optionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ToolError("INVALID_ARGUMENT", `${flag} requires a value.`);
  }
  return value;
}

function parseOptions(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") options.input = optionValue(argv, index++, arg);
    else if (arg === "--screenshot-path") options.screenshotPath = optionValue(argv, index++, arg);
    else if (arg === "--screenshot") options.screenshot = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--")) throw new ToolError("INVALID_ARGUMENT", `Unknown option: ${arg}`);
    else positional.push(arg);
  }
  return { positional, options };
}

async function readInput(value, stdin) {
  if (!value) throw new ToolError("INVALID_ARGUMENT", "--input is required.");
  let text;
  if (value === "-") text = await stdin();
  else if (value.startsWith("@")) text = await fs.readFile(value.slice(1), "utf8");
  else text = value;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ToolError("INVALID_JSON", `Could not parse --input JSON: ${error.message}`);
  }
}

function requireId(id, command) {
  if (!id) throw new ToolError("INVALID_ARGUMENT", `${command} requires a theme id.`);
  return id;
}

export async function dispatchCli(argv, service, io) {
  const [command, ...rest] = argv;
  if (!command) throw new ToolError("INVALID_ARGUMENT", "A command is required.");
  const { positional, options } = parseOptions(rest);
  if (command === "inspect") return service.inspect();
  if (command === "apply") return service.apply(requireId(positional[0], "apply"));
  if (command === "preview") {
    return service.preview(requireId(positional[0], "preview"), {
      screenshot: options.screenshot || Boolean(options.screenshotPath),
      screenshotPath: options.screenshotPath,
    });
  }
  if (command === "verify") {
    return service.verify({
      screenshot: options.screenshot || Boolean(options.screenshotPath),
      screenshotPath: options.screenshotPath,
    });
  }
  if (command === "restore") return service.restore();
  if (command !== "theme") throw new ToolError("INVALID_ARGUMENT", `Unknown command: ${command}`);

  const [themeCommand, ...themeArgs] = positional;
  if (themeCommand === "list") return service.themeList();
  if (themeCommand === "read") return service.themeRead(requireId(themeArgs[0], "theme read"));
  if (themeCommand === "write") {
    const input = await readInput(options.input, io.stdin);
    if (options.dryRun) input.dryRun = true;
    return service.themeWrite(input);
  }
  if (themeCommand === "validate") {
    if (options.input) return service.themeValidate({ theme: await readInput(options.input, io.stdin) });
    return service.themeValidate({ id: requireId(themeArgs[0], "theme validate") });
  }
  throw new ToolError("INVALID_ARGUMENT", `Unknown theme command: ${themeCommand || "missing"}`);
}

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

export async function runCli(
  argv = process.argv.slice(2),
  service = new TraeDreamSkinService(),
  io = { stdout: process.stdout, stderr: process.stderr, stdin: readStdin },
) {
  try {
    const result = await dispatchCli(argv, service, io);
    io.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stdout.write(`${JSON.stringify(errorEnvelope(error), null, 2)}\n`);
    return 1;
  }
}
