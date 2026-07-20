import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { errorEnvelope, ToolError } from "./core/errors.mjs";
import { PROJECT_ROOT } from "./core/paths.mjs";
import { createDreamSkinApplicationContext } from "./core/product-application-context.mjs";
import { createStudioBackend } from "./core/studio-backend.mjs";

const MAX_JSON_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

function statusFor(error) {
  const code = error?.code;
  if (code === "INVALID_ORIGIN") return 403;
  if (code === "INVALID_CONTENT_TYPE") return 415;
  if (
    code === "THEME_NOT_FOUND"
    || code === "TEMPLATE_NOT_FOUND"
    || code === "COMPONENT_NOT_FOUND"
    || code === "PLUGIN_NOT_FOUND"
  ) return 404;
  if (code === "REVISION_CONFLICT" || code === "THEME_ACTIVE") return 409;
  if (code === "CLI_PATH_OCCUPIED") return 409;
  if (code === "CLI_RUNTIME_UNAVAILABLE") return 503;
  if (code === "REPOSITORY_BUSY") return 423;
  if (code === "THEME_INVALID" || code === "INVALID_THEME_PATCH") return 422;
  if (code === "CLI_INSTALL_UNSUPPORTED") return 501;
  if (code?.startsWith("INVALID_") || code === "THEME_ID_MISMATCH") return 400;
  return 500;
}

function sendJson(response, statusCode, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendResult(response, result, statusCode = 200) {
  sendJson(response, statusCode, { ok: true, result });
}

async function readJson(request) {
  const declared = Number(request.headers["content-length"] || 0);
  if (declared > MAX_JSON_BYTES) throw new ToolError("INVALID_REQUEST", "Request body is too large.");
  let text = "";
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_JSON_BYTES) throw new ToolError("INVALID_REQUEST", "Request body is too large.");
    text += chunk;
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ToolError("INVALID_JSON", `Could not parse request JSON: ${error.message}`);
  }
}

function assertLoopbackRequest(request) {
  const header = String(request.headers.host || "");
  const host = header.startsWith("[") ? header.slice(0, header.indexOf("]") + 1) : header.replace(/:\d+$/, "");
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ToolError("INVALID_HOST", "DreamSkin Studio only accepts loopback requests.");
  }
}

function assertMutationRequest(request, method) {
  if (!MUTATION_METHODS.has(method)) return;

  const originHeader = request.headers.origin;
  const fetchSite = String(request.headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (originHeader === undefined) {
    if (fetchSite) {
      throw new ToolError("INVALID_ORIGIN", "Browser write requests must provide a same-origin Origin header.");
    }
  } else {
    let originUrl;
    let origin;
    let expected;
    try {
      originUrl = new URL(String(originHeader));
      origin = originUrl.origin;
      expected = new URL(`http://${request.headers.host}`).origin;
    } catch {
      throw new ToolError("INVALID_ORIGIN", "Write request Origin is malformed.");
    }
    const directSameOrigin = origin === expected;
    // Vite's development proxy rewrites Host to its target. Fetch Metadata still
    // records that the browser request reached Vite through the same origin.
    const proxiedSameOrigin = fetchSite === "same-origin"
      && originUrl.protocol === "http:"
      && LOOPBACK_HOSTS.has(originUrl.hostname);
    const acceptedFetchSite = !fetchSite
      || fetchSite === "same-origin"
      || (directSameOrigin && fetchSite === "none");
    if ((!directSameOrigin && !proxiedSameOrigin) || !acceptedFetchSite) {
      throw new ToolError("INVALID_ORIGIN", "DreamSkin Studio only accepts same-origin browser writes.");
    }
  }

  const contentType = String(request.headers["content-type"] || "").trim();
  const hasPayload = request.headers["transfer-encoding"] !== undefined
    || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0");
  if (!contentType) {
    if (hasPayload) {
      throw new ToolError("INVALID_CONTENT_TYPE", "Write request bodies must use application/json.");
    }
    return;
  }
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ToolError("INVALID_CONTENT_TYPE", "Write request bodies must use application/json.");
  }
}

function requestedAssetRevision(url) {
  const unsupported = [...url.searchParams.keys()].filter((key) => key !== "revision");
  if (unsupported.length) {
    throw new ToolError("INVALID_ARGUMENT", "Asset requests accept only the revision query parameter.", {
      parameters: [...new Set(unsupported)],
    });
  }
  const revisions = url.searchParams.getAll("revision");
  if (revisions.length > 1) {
    throw new ToolError("INVALID_ARGUMENT", "Asset requests accept exactly one revision value.");
  }
  if (revisions.length === 1 && !revisions[0]) {
    throw new ToolError("INVALID_ARGUMENT", "Asset revision cannot be empty.");
  }
  return revisions[0] || null;
}

function studioApiScope(pathname) {
  const prefix = "/api/v1/plugins/";
  if (!pathname.startsWith(prefix)) return { pathname, pluginId: undefined };
  const remainder = pathname.slice(prefix.length);
  const separator = remainder.indexOf("/");
  const pluginId = separator === -1 ? remainder : remainder.slice(0, separator);
  if (!PLUGIN_ID_PATTERN.test(pluginId) || pluginId.length > 128) {
    throw new ToolError("INVALID_ARGUMENT", "Studio pluginId is invalid.");
  }
  return {
    pluginId,
    pathname: `/api/v1${separator === -1 ? "" : remainder.slice(separator)}`,
  };
}

function routeScopedBody(input, pluginId) {
  if (!pluginId) return input;
  if (input.pluginId !== undefined && input.pluginId !== pluginId) {
    throw new ToolError("INVALID_ARGUMENT", "Body pluginId must match the target selected by the route.", {
      routePluginId: pluginId,
      bodyPluginId: input.pluginId,
    });
  }
  const { pluginId: _pluginId, ...body } = input;
  return body;
}

function sendAsset(response, asset, method, requestedRevision) {
  if (requestedRevision && requestedRevision !== asset.revision) {
    throw new ToolError("REVISION_CONFLICT", "The requested asset revision is no longer current.", {
      expectedRevision: requestedRevision,
      actualRevision: asset.revision,
    });
  }
  const headers = {
    "Cache-Control": requestedRevision
      ? "private, max-age=31536000, immutable"
      : "private, no-cache",
    "Content-Length": asset.bytes,
    "Content-Type": asset.mime,
    ETag: `"${asset.revision}"`,
    "X-Content-Type-Options": "nosniff",
  };
  response.writeHead(200, headers);
  if (method === "HEAD") response.end();
  else response.end(asset.buffer);
}

function isSpaRoute(pathname) {
  return pathname === "/" || path.posix.extname(pathname) === "";
}

async function existingStaticFile(root, relativePath) {
  let rootRealPath;
  try {
    rootRealPath = await fs.realpath(root);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
  const lexicalTarget = path.resolve(rootRealPath, relativePath);
  if (lexicalTarget !== rootRealPath && !lexicalTarget.startsWith(`${rootRealPath}${path.sep}`)) return null;
  let targetRealPath;
  try {
    targetRealPath = await fs.realpath(lexicalTarget);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
  if (targetRealPath !== rootRealPath && !targetRealPath.startsWith(`${rootRealPath}${path.sep}`)) return null;
  const stat = await fs.stat(targetRealPath);
  return stat.isFile() ? { path: targetRealPath, stat } : null;
}

async function staticFile(response, requestPath, distRoot, method) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    throw new ToolError("INVALID_PATH", "Studio resource path is malformed.");
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    throw new ToolError("INVALID_PATH", "Studio resource path is invalid.");
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  let file = await existingStaticFile(distRoot, relative);
  if (!file && isSpaRoute(decoded)) file = await existingStaticFile(distRoot, "index.html");
  if (!file) return false;
  response.writeHead(200, {
    "Cache-Control": path.basename(file.path) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    "Content-Length": file.stat.size,
    "Content-Type": MIME_TYPES.get(path.extname(file.path).toLowerCase()) || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  if (method === "HEAD") response.end();
  else createReadStream(file.path).pipe(response);
  return true;
}

export function createStudioHttpServer({
  backend,
  distRoot = path.join(PROJECT_ROOT, "studio", "dist"),
} = {}) {
  if (!backend) throw new ToolError("INVALID_BACKEND", "createStudioHttpServer requires an initialized backend.");
  const resolvedDistRoot = path.resolve(distRoot);
  const server = http.createServer(async (request, response) => {
    try {
      assertLoopbackRequest(request);
      const method = request.method || "GET";
      const url = new URL(request.url || "/", `http://${request.headers.host}`);
      const pathname = url.pathname;
      if (pathname.startsWith("/api/")) assertMutationRequest(request, method);
      const apiScope = pathname.startsWith("/api/") ? studioApiScope(pathname) : null;
      const apiPathname = apiScope?.pathname || pathname;
      const pluginId = apiScope?.pluginId;

      if (!pluginId && apiPathname === "/api/v1/bootstrap" && method === "GET") return sendResult(response, await backend.bootstrap());
      if (apiPathname === "/api/v1/catalog" && method === "GET") return sendResult(response, await backend.catalog(pluginId));
      if (apiPathname === "/api/v1/themes" && method === "GET") return sendResult(response, await backend.themes(pluginId));
      if (apiPathname === "/api/v1/themes" && method === "POST") {
        return sendResult(response, await backend.createTheme(
          routeScopedBody(await readJson(request), pluginId),
          pluginId,
        ), 201);
      }
      if (!pluginId && apiPathname === "/api/v1/settings" && method === "GET") return sendResult(response, await backend.settings());
      if (!pluginId && apiPathname === "/api/v1/settings" && method === "PATCH") return sendResult(response, await backend.updateSettings(await readJson(request)));
      if (!pluginId && apiPathname === "/api/v1/cli" && method === "GET") return sendResult(response, await backend.cliStatus());
      if (!pluginId && apiPathname === "/api/v1/cli/install" && method === "POST") return sendResult(response, await backend.installCli());
      if (!pluginId && apiPathname === "/api/v1/cli/uninstall" && method === "POST") return sendResult(response, await backend.uninstallCli());
      if (apiPathname === "/api/v1/runtime/verify" && method === "POST") {
        return sendResult(response, await backend.verify(
          routeScopedBody(await readJson(request), pluginId),
          pluginId,
        ));
      }
      if (apiPathname === "/api/v1/runtime/restore" && method === "POST") {
        return sendResult(response, await backend.restore(pluginId));
      }

      let match = apiPathname.match(/^\/api\/v1\/catalog\/([a-z0-9][a-z0-9_-]{0,63})\/asset$/);
      if (match && (method === "GET" || method === "HEAD")) {
        const revision = requestedAssetRevision(url);
        return sendAsset(response, await backend.asset("catalog", match[1], pluginId), method, revision);
      }

      match = apiPathname.match(/^\/api\/v1\/themes\/([a-z0-9][a-z0-9_-]{0,63})\/asset$/);
      if (match && (method === "GET" || method === "HEAD")) {
        const revision = requestedAssetRevision(url);
        return sendAsset(response, await backend.asset("theme", match[1], pluginId), method, revision);
      }

      match = apiPathname.match(/^\/api\/v1\/themes\/([a-z0-9][a-z0-9_-]{0,63})$/);
      if (match && method === "GET") return sendResult(response, await backend.theme(match[1], pluginId));
      if (match && method === "PATCH") return sendResult(response, await backend.updateTheme(
        match[1],
        routeScopedBody(await readJson(request), pluginId),
        pluginId,
      ));
      if (match && method === "DELETE") return sendResult(response, await backend.deleteTheme(
        match[1],
        routeScopedBody(await readJson(request), pluginId),
        pluginId,
      ));

      match = apiPathname.match(/^\/api\/v1\/themes\/([a-z0-9][a-z0-9_-]{0,63})\/duplicate$/);
      if (match && method === "POST") return sendResult(response, await backend.duplicateTheme(match[1], pluginId), 201);

      match = apiPathname.match(/^\/api\/v1\/themes\/([a-z0-9][a-z0-9_-]{0,63})\/(apply|validate|preview)$/);
      if (match && method === "POST") {
        const [, id, operation] = match;
        const input = operation === "apply" || operation === "validate"
          ? {}
          : routeScopedBody(await readJson(request), pluginId);
        if (operation === "apply") return sendResult(response, await backend.applyTheme(id, pluginId));
        if (operation === "validate") return sendResult(response, await backend.validateTheme(id, pluginId));
        if (operation === "preview") return sendResult(response, await backend.previewTheme(id, input, pluginId));
      }

      if (pathname.startsWith("/api/")) {
        return sendJson(response, 404, errorEnvelope(new ToolError("NOT_FOUND", "API route not found.")));
      }
      if (method !== "GET" && method !== "HEAD") {
        return sendJson(response, 405, errorEnvelope(new ToolError("METHOD_NOT_ALLOWED", "Method not allowed.")));
      }
      if (await staticFile(response, pathname, resolvedDistRoot, method)) return;
      sendJson(response, 503, errorEnvelope(new ToolError("STUDIO_NOT_BUILT", "Build Studio before starting the standalone server.")));
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      sendJson(response, statusFor(error), errorEnvelope(error));
    }
  });
  server.on("close", () => { void backend.close(); });
  return server;
}

export async function startStudioServer({
  host = "127.0.0.1",
  port = 4242,
  firstPartyTargets = false,
  ...options
} = {}) {
  if (!LOOPBACK_HOSTS.has(host)) throw new ToolError("INVALID_HOST", "Studio must bind to a loopback address.");
  let backend = options.backend;
  if (!backend) {
    const applicationContext = options.applicationContext
      || (firstPartyTargets ? await createDreamSkinApplicationContext(options) : undefined);
    backend = await createStudioBackend({ ...options, applicationContext });
  }
  const server = createStudioHttpServer({ ...options, backend });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--port") options.port = Number(argv[++index]);
    else if (argv[index] === "--host") options.host = argv[++index];
    else throw new ToolError("INVALID_ARGUMENT", `Unknown Studio option: ${argv[index]}`);
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    throw new ToolError("INVALID_ARGUMENT", "Studio port must be between 1 and 65535.");
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let server;
  try {
    const options = parseArgs(process.argv.slice(2));
    server = await startStudioServer({ ...options, firstPartyTargets: true });
    const address = server.address();
    console.log(`DreamSkin Studio: http://${address.address}:${address.port}`);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
  const shutdown = () => server?.close();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
