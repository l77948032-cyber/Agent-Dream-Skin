import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  DREAMSKIN_CLI_COMMAND,
  DREAMSKIN_CLI_MARKER,
  DreamSkinCliManager,
} from "../desktop/cli-manager.mjs";

const execFileAsync = promisify(execFile);

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-cli-manager-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appRoot = path.join(root, "Alvin's DreamSkin Studio.app");
  const executablePath = path.join(appRoot, "Contents", "MacOS", "DreamSkin Studio");
  const resourcesPath = path.join(appRoot, "Contents", "Resources");
  const userDataPath = path.join(root, "Library", "Application Support", "DreamSkin Studio");
  const installDirectory = path.join(root, "Local Commands");
  await fs.mkdir(path.dirname(executablePath), { recursive: true });
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.chmod(executablePath, 0o755);
  await fs.mkdir(path.join(resourcesPath, "app.asar", "bin"), { recursive: true });
  await fs.writeFile(path.join(resourcesPath, "app.asar", "bin", "dreamskin.mjs"), "// fixture\n");
  await fs.mkdir(path.join(resourcesPath, "dreamskin"), { recursive: true });
  await fs.writeFile(
    path.join(resourcesPath, "dreamskin", "resource-manifest.v1.json"),
    '{"schemaVersion":1}\n',
  );
  return {
    root,
    appRoot,
    executablePath,
    resourcesPath,
    userDataPath,
    installDirectory,
    manager: new DreamSkinCliManager({
      platform: "darwin",
      homeDir: path.join(root, "Home Folder"),
      executablePath,
      resourcesPath,
      userDataPath,
      pathValue: installDirectory,
      installDirectories: [installDirectory],
      ...overrides,
    }),
  };
}

test("launcher has a POSIX shebang and safely executes app paths containing spaces and quotes", async (t) => {
  const value = await fixture(t);
  await fs.mkdir(path.dirname(value.executablePath), { recursive: true });
  await fs.mkdir(value.userDataPath, { recursive: true });
  await fs.writeFile(value.executablePath, `#!/bin/sh
printf '%s\\n' \\
  "$DREAMSKIN_PACKAGED" \\
  "$DREAMSKIN_RESOURCE_ROOT" \\
  "$DREAMSKIN_USER_DATA_ROOT" \\
  "$DREAMSKIN_DATA_ROOT" \\
  "$DREAMSKIN_TRAE_RUNTIME_STATE_ROOT" \\
  "$DREAMSKIN_WORKBUDDY_RUNTIME_STATE_ROOT" \\
  "$ELECTRON_RUN_AS_NODE" \\
  "$@"
`, { mode: 0o755 });
  await fs.chmod(value.executablePath, 0o755);

  const contents = value.manager.launcherContents();
  assert.equal(contents.startsWith(`#!/bin/sh\n${DREAMSKIN_CLI_MARKER}\n`), true);
  assert.match(contents, /exec '.*DreamSkin Studio' '.*app\.asar\/bin\/dreamskin\.mjs' "\$@"/);

  const installed = await value.manager.install();
  const { stdout, stderr } = await execFileAsync(installed.path, ["argument with spaces", "quote'value"]);
  assert.equal(stderr, "");
  assert.deepEqual(stdout.trimEnd().split("\n"), [
    "1",
    path.join(value.resourcesPath, "dreamskin"),
    value.userDataPath,
    path.join(value.userDataPath, "dreamskin"),
    path.join(path.dirname(value.userDataPath), "TraeDreamSkin"),
    path.join(path.dirname(value.userDataPath), "WorkBuddyDreamSkin"),
    "1",
    path.join(value.resourcesPath, "app.asar", "bin", "dreamskin.mjs"),
    "argument with spaces",
    "quote'value",
  ]);
});

test("managed install is executable, replaceable, and idempotently uninstallable", async (t) => {
  const value = await fixture(t);
  const expectedPath = path.join(value.installDirectory, DREAMSKIN_CLI_COMMAND);

  const installed = await value.manager.install();
  assert.deepEqual(installed, {
    supported: true,
    state: "ready",
    installed: true,
    current: true,
    available: true,
    command: DREAMSKIN_CLI_COMMAND,
    path: expectedPath,
    targetPath: expectedPath,
    pathAvailable: true,
    message: "DreamSkin CLI 已就绪。",
  });
  assert.equal(await value.manager.installedPath(), expectedPath);
  assert.equal((await fs.stat(expectedPath)).mode & 0o777, 0o755);
  assert.equal((await fs.readFile(expectedPath, "utf8")).startsWith(
    `#!/bin/sh\n${DREAMSKIN_CLI_MARKER}\n`,
  ), true);

  const reinstalled = await value.manager.install();
  assert.equal(reinstalled.installed, true);
  assert.equal(reinstalled.path, expectedPath);

  const removed = await value.manager.uninstall();
  assert.equal(removed.installed, false);
  assert.equal(removed.state, "not-installed");
  assert.equal(removed.current, false);
  assert.equal(removed.available, false);
  assert.equal(removed.path, null);
  assert.equal(removed.targetPath, expectedPath);
  await assert.rejects(fs.lstat(expectedPath), { code: "ENOENT" });

  const removedAgain = await value.manager.uninstall();
  assert.equal(removedAgain.installed, false);
  await assert.rejects(fs.lstat(expectedPath), { code: "ENOENT" });
});

test("install refuses occupied files, directories, and symlinks without modifying them", async (t) => {
  const value = await fixture(t);
  const cases = ["file", "directory", "symlink"];

  for (const state of cases) {
    const installDirectory = path.join(value.root, `occupied-${state}`);
    const target = path.join(installDirectory, DREAMSKIN_CLI_COMMAND);
    await fs.mkdir(installDirectory, { recursive: true });
    if (state === "file") await fs.writeFile(target, "owned by another tool\n");
    else if (state === "directory") await fs.mkdir(target);
    else {
      const destination = path.join(value.root, "symlink-destination");
      await fs.writeFile(destination, "do not replace\n");
      await fs.symlink(destination, target);
    }
    const manager = new DreamSkinCliManager({
      platform: "darwin",
      homeDir: path.join(value.root, "home"),
      executablePath: value.executablePath,
      resourcesPath: value.resourcesPath,
      userDataPath: value.userDataPath,
      pathValue: installDirectory,
      installDirectories: [installDirectory],
    });

    await assert.rejects(manager.install(), (error) => {
      assert.equal(error.code, "CLI_PATH_OCCUPIED");
      assert.deepEqual(error.details, { path: target });
      return true;
    });
    const stat = await fs.lstat(target);
    assert.equal(
      state === "file" ? stat.isFile() : state === "directory" ? stat.isDirectory() : stat.isSymbolicLink(),
      true,
    );
  }
});

test("uninstall leaves an unmanaged command untouched", async (t) => {
  const value = await fixture(t);
  const target = path.join(value.installDirectory, DREAMSKIN_CLI_COMMAND);
  await fs.mkdir(value.installDirectory, { recursive: true });
  await fs.writeFile(target, "#!/bin/sh\necho unrelated\n", { mode: 0o755 });

  const status = await value.manager.uninstall();

  assert.equal(status.installed, false);
  assert.equal(await fs.readFile(target, "utf8"), "#!/bin/sh\necho unrelated\n");
});

test("status distinguishes installed commands that are present or absent from PATH", async (t) => {
  const value = await fixture(t, { pathValue: "/usr/bin:/bin" });
  const before = await value.manager.status();
  assert.equal(before.installed, false);
  assert.equal(before.state, "not-installed");
  assert.equal(before.path, null);
  assert.equal(before.pathAvailable, false);
  assert.equal(before.message, "CLI 尚未安装。");

  await value.manager.install();
  const absent = await value.manager.status();
  assert.equal(absent.installed, true);
  assert.equal(absent.state, "ready");
  assert.equal(absent.current, true);
  assert.equal(absent.available, true);
  assert.equal(absent.pathAvailable, false);
  assert.equal(absent.message, "CLI 已安装；当前终端 PATH 尚未包含它的目录。");

  const availableManager = new DreamSkinCliManager({
    platform: "darwin",
    homeDir: path.join(value.root, "home"),
    executablePath: value.executablePath,
    resourcesPath: value.resourcesPath,
    userDataPath: value.userDataPath,
    pathValue: `/usr/bin:${value.installDirectory}:/bin`,
    installDirectories: [value.installDirectory],
  });
  const available = await availableManager.status();
  assert.equal(available.installed, true);
  assert.equal(available.state, "ready");
  assert.equal(available.pathAvailable, true);
  assert.equal(available.path, path.join(value.installDirectory, DREAMSKIN_CLI_COMMAND));
  assert.equal(available.message, "DreamSkin CLI 已就绪。");
});

test("an unsupported platform cannot generate or install a launcher", async (t) => {
  const value = await fixture(t, { platform: "linux" });
  assert.equal(value.manager.supported, false);
  assert.equal((await value.manager.status()).state, "unsupported");
  assert.throws(() => value.manager.launcherContents(), { code: "CLI_INSTALL_UNSUPPORTED" });
  await assert.rejects(value.manager.install(), { code: "CLI_INSTALL_UNSUPPORTED" });
});

test("default candidates prefer conventional PATH entries and include Apple silicon Homebrew", async (t) => {
  const value = await fixture(t, {
    installDirectories: undefined,
    pathValue: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  });

  assert.deepEqual(value.manager.candidatePaths(), [
    path.join("/opt/homebrew/bin", DREAMSKIN_CLI_COMMAND),
    path.join("/usr/local/bin", DREAMSKIN_CLI_COMMAND),
    path.join(value.manager.homeDir, ".local", "bin", DREAMSKIN_CLI_COMMAND),
  ]);
});

test("status detects a stale managed launcher and reinstall refreshes its exact contents", async (t) => {
  const value = await fixture(t);
  const target = path.join(value.installDirectory, DREAMSKIN_CLI_COMMAND);
  await value.manager.install();
  await fs.writeFile(target, `#!/bin/sh\n${DREAMSKIN_CLI_MARKER}\nexec '/Old DreamSkin.app/Contents/MacOS/DreamSkin' "$@"\n`, {
    mode: 0o755,
  });

  const stale = await value.manager.status();
  assert.equal(stale.state, "stale");
  assert.equal(stale.installed, true);
  assert.equal(stale.current, false);
  assert.equal(stale.available, false);
  assert.equal(stale.path, target);
  assert.equal(stale.message, "CLI 启动器已过期或不可执行，请重新安装。");

  const refreshed = await value.manager.install();
  assert.equal(refreshed.state, "ready");
  assert.equal(refreshed.current, true);
  assert.equal(refreshed.available, true);
  assert.equal(await fs.readFile(target, "utf8"), value.manager.launcherContents());
});

test("status treats an exact launcher without execute permission as stale", async (t) => {
  const value = await fixture(t);
  const installed = await value.manager.install();
  await fs.chmod(installed.path, 0o644);

  const status = await value.manager.status();
  assert.equal(status.state, "stale");
  assert.equal(status.current, true);
  assert.equal(status.available, false);
});

test("missing current app executable or resources make the CLI unavailable", async (t) => {
  const scenarios = [
    ["app-executable", (value) => value.executablePath],
    ["cli-entrypoint", (value) => path.join(value.resourcesPath, "app.asar", "bin", "dreamskin.mjs")],
    ["resource-manifest", (value) => path.join(value.resourcesPath, "dreamskin", "resource-manifest.v1.json")],
  ];

  for (const [kind, targetFor] of scenarios) {
    const value = await fixture(t);
    await value.manager.install();
    const target = targetFor(value);
    await fs.rm(target);

    const status = await value.manager.status();
    assert.equal(status.state, "unavailable", kind);
    assert.equal(status.installed, true, kind);
    assert.equal(status.available, false, kind);
    assert.equal(status.message, "当前 DreamSkin 应用或 CLI 资源不可用，请重新安装应用后再试。", kind);
    await assert.rejects(value.manager.install(), (error) => {
      assert.equal(error.code, "CLI_RUNTIME_UNAVAILABLE");
      assert.deepEqual(error.details.unavailableResources, [{ kind, path: target }]);
      return true;
    });
  }
});
