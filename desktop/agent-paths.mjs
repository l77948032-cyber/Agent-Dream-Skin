import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function executable(filePath, access = fs.access) {
  if (!filePath) return false;
  try {
    await access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function preferredCodexPath({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  access = fs.access,
} = {}) {
  const configured = env.DREAMSKIN_CODEX_PATH || env.CODEX_PATH;
  const candidates = [configured];
  if (platform === "darwin") {
    candidates.push(
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      path.join(homeDir, "Applications", "Codex.app", "Contents", "Resources", "codex"),
      path.join(homeDir, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
    );
  }
  for (const candidate of candidates.filter(Boolean)) {
    if (await executable(candidate, access)) return candidate;
  }
  return null;
}
