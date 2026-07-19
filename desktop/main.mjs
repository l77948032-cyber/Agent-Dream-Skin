import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, protocol, session } from "electron";

import { preferredCodexPath } from "./agent-paths.mjs";
import { createDesktopProcessTerminator } from "./process-lifecycle.mjs";
import { startDesktopApplication } from "./shell.mjs";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(desktopRoot, "..");
const processTerminator = createDesktopProcessTerminator({ app });

async function createDesktopBackend(config) {
  // Resolve path constants against the packaged resource root before loading the
  // backend graph. Spawned Tool/ACP processes inherit the same explicit roots.
  process.env.TRAE_DREAM_SKIN_PROJECT_ROOT = config.paths.resourceRoot;
  process.env.TRAE_DREAM_SKIN_THEMES_ROOT = config.paths.userThemesRoot;
  process.env.TRAE_DREAM_SKIN_TOOL_HOME = config.paths.stateRoot;
  process.env.DREAMSKIN_STUDIO_HOME = config.layout.dataRoot;
  process.env.DREAMSKIN_STUDIO_THEMES_ROOT = config.paths.userThemesRoot;
  const { createStudioBackend } = await import("../src/core/studio-backend.mjs");
  const appRoot = app.getAppPath();
  const mcpServerPath = path.join(appRoot, "src", "mcp-server.mjs");
  const nodeModeEnvironment = { ELECTRON_RUN_AS_NODE: "1", DREAMSKIN_DESKTOP: "1" };
  const mcpServerEnvironment = {
    ...nodeModeEnvironment,
    DREAMSKIN_MCP_ENTRY: "1",
    DREAMSKIN_TOOL_PLUGIN_ROOT: path.join(config.paths.resourceRoot, "plugins", "trae"),
  };
  const packagedAcpAdapter = path.join(config.paths.resourceRoot, "acp", "codex-acp.mjs");
  const codexPath = await preferredCodexPath();
  return createStudioBackend({
    ...config.backendOptions,
    agentRegistryOptions: {
      projectRoot: appRoot,
      executablePath: process.execPath,
      ...(codexPath ? { commandPaths: { codex: codexPath } } : {}),
      ...(app.isPackaged ? { adapterPaths: { codex: process.execPath } } : {}),
    },
    sessionOptions: {
      mcpServerPath,
      mcpServerCommand: process.execPath,
      mcpServerArgs: [mcpServerPath],
      mcpServerEnv: mcpServerEnvironment,
      ...(app.isPackaged ? {
        adapterLaunchers: {
          codex: {
            command: process.execPath,
            args: [packagedAcpAdapter],
            env: nodeModeEnvironment,
          },
        },
      } : {}),
    },
  });
}

void startDesktopApplication({
  electron: { app, BrowserWindow, ipcMain, protocol, session },
  createBackend: createDesktopBackend,
  developmentResourcesPath: projectRoot,
  resourcesPath: process.resourcesPath,
  preloadPath: path.join(desktopRoot, "preload.cjs"),
  development: !app.isPackaged,
  exitApplication: (code) => processTerminator.terminate(code),
})
  .then((controller) => {
    if (!controller.started) return;
    const shutdownFromSignal = () => {
      void controller.finalExit();
    };
    for (const signal of ["SIGINT", "SIGTERM"]) {
      processTerminator.listen(signal, shutdownFromSignal);
    }
  })
  .catch((error) => {
    console.error(error.stack || error.message);
    app.exit(1);
  });
