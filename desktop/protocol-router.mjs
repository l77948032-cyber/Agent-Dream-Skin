import fs from "node:fs/promises";
import path from "node:path";

import { errorEnvelope, ToolError } from "../src/core/errors.mjs";
import {
  DREAMSKIN_HOST,
  DREAMSKIN_ORIGIN,
  DREAMSKIN_SCHEME,
  MAX_DESKTOP_PAYLOAD_BYTES,
} from "./constants.mjs";

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
].join("; ");

const BASE_SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": CSP,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

function responseHeaders(extra = {}) {
  return { ...BASE_SECURITY_HEADERS, ...extra };
}

function statusFor(error) {
  const code = error?.code;
  if (code === "STUDIO_NOT_BUILT") return 503;
  if (
    code === "NOT_FOUND"
    || code === "THEME_NOT_FOUND"
    || code === "TEMPLATE_NOT_FOUND"
    || code === "COMPONENT_NOT_FOUND"
    || code === "PLUGIN_NOT_FOUND"
  ) return 404;
  if (code === "METHOD_NOT_ALLOWED") return 405;
  if (code === "INVALID_CONTENT_TYPE") return 415;
  if (code === "REVISION_CONFLICT" || code === "THEME_ACTIVE") return 409;
  if (code === "CLI_PATH_OCCUPIED") return 409;
  if (code === "CLI_RUNTIME_UNAVAILABLE") return 503;
  if (code === "REPOSITORY_BUSY") return 423;
  if (code === "THEME_INVALID" || code === "INVALID_THEME_PATCH") return 422;
  if (code === "CLI_INSTALL_UNSUPPORTED") return 501;
  if (code === "INVALID_ORIGIN" || code === "INVALID_HOST") return 403;
  if (code?.startsWith("INVALID_") || code === "THEME_ID_MISMATCH") return 400;
  return 500;
}

function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(`${JSON.stringify(payload)}\n`, {
    status,
    headers: responseHeaders({
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    }),
  });
}

function success(result, status = 200) {
  return jsonResponse({ ok: true, result }, { status });
}

function assertTrustedProtocolUrl(url) {
  if (url.protocol !== `${DREAMSKIN_SCHEME}:` || url.hostname !== DREAMSKIN_HOST || url.port) {
    throw new ToolError("INVALID_HOST", "The desktop protocol accepts only dreamskin://studio requests.");
  }
  if (url.username || url.password) {
    throw new ToolError("INVALID_HOST", "Credentials are not allowed in DreamSkin URLs.");
  }
}

function assertMutationRequest(request) {
  const origin = request.headers.get("origin");
  const fetchSite = (request.headers.get("sec-fetch-site") || "").trim().toLowerCase();
  if (origin !== DREAMSKIN_ORIGIN || fetchSite !== "same-origin") {
    throw new ToolError("INVALID_ORIGIN", "DreamSkin Studio accepts only same-origin desktop writes.");
  }
}

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (!Number.isFinite(declared) || declared > MAX_DESKTOP_PAYLOAD_BYTES) {
    throw new ToolError("INVALID_REQUEST", "Request body is too large.");
  }
  const contentType = request.headers.get("content-type") || "";
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ToolError("INVALID_CONTENT_TYPE", "Write request bodies must use application/json.");
  }
  const buffer = Buffer.from(await request.arrayBuffer());
  if (buffer.byteLength > MAX_DESKTOP_PAYLOAD_BYTES) {
    throw new ToolError("INVALID_REQUEST", "Request body is too large.");
  }
  if (!buffer.length || !buffer.toString("utf8").trim()) return {};
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new ToolError("INVALID_JSON", `Could not parse request JSON: ${error.message}`);
  }
}

function hasBody(request) {
  const length = request.headers.get("content-length");
  return request.body !== null || (length !== null && length !== "0");
}

async function optionalJson(request) {
  return hasBody(request) ? readJson(request) : {};
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

function routeScopedInput(input, pluginId) {
  if (!pluginId) return input;
  if (input.pluginId !== undefined && input.pluginId !== pluginId) {
    throw new ToolError("INVALID_ARGUMENT", "Body pluginId must match the target selected by the route.", {
      routePluginId: pluginId,
      bodyPluginId: input.pluginId,
    });
  }
  const { pluginId: _pluginId, ...body } = input;
  return { ...body, pluginId };
}

function routeScopedBody(input, pluginId) {
  const scoped = routeScopedInput(input, pluginId);
  if (!pluginId) return scoped;
  const { pluginId: _pluginId, ...body } = scoped;
  return body;
}

async function apiRoute(request, url, router) {
  const scope = studioApiScope(url.pathname);
  const pathname = scope.pathname;
  const { pluginId } = scope;
  const method = request.method.toUpperCase();
  if (!["GET", "HEAD"].includes(method)) assertMutationRequest(request);

  if (!pluginId && pathname === "/api/v1/bootstrap" && method === "GET") return success(await router.invoke("bootstrap"));
  if (pathname === "/api/v1/catalog" && method === "GET") return success(await router.invoke("catalog.list", { pluginId }));
  if (pathname === "/api/v1/themes" && method === "GET") return success(await router.invoke("themes.list", { pluginId }));
  if (pathname === "/api/v1/themes" && method === "POST") {
    return success(await router.invoke(
      "themes.create",
      routeScopedInput(await readJson(request), pluginId),
    ), 201);
  }
  if (!pluginId && pathname === "/api/v1/settings" && method === "GET") return success(await router.invoke("settings.read"));
  if (!pluginId && pathname === "/api/v1/settings" && method === "PATCH") return success(await router.invoke("settings.update", await readJson(request)));
  if (!pluginId && pathname === "/api/v1/cli" && method === "GET") return success(await router.invoke("cli.status"));
  if (!pluginId && pathname === "/api/v1/cli/install" && method === "POST") return success(await router.invoke("cli.install"));
  if (!pluginId && pathname === "/api/v1/cli/uninstall" && method === "POST") return success(await router.invoke("cli.uninstall"));
  if (pathname === "/api/v1/runtime/verify" && method === "POST") {
    return success(await router.invoke(
      "runtime.verify",
      routeScopedInput(await optionalJson(request), pluginId),
    ));
  }
  if (pathname === "/api/v1/runtime/restore" && method === "POST") {
    return success(await router.invoke("runtime.restore", { pluginId }));
  }

  let match = pathname.match(/^\/api\/v1\/catalog\/([a-z0-9][a-z0-9_-]{0,63})\/asset$/);
  if (match && (method === "GET" || method === "HEAD")) {
    const revision = requestedAssetRevision(url);
    return assetResponse(await router.asset("catalog", match[1], pluginId), method, revision);
  }

  match = pathname.match(/^\/api\/v1\/themes\/([a-z0-9][a-z0-9_-]{0,63})\/asset$/);
  if (match && (method === "GET" || method === "HEAD")) {
    const revision = requestedAssetRevision(url);
    return assetResponse(await router.asset("theme", match[1], pluginId), method, revision);
  }

  match = pathname.match(/^\/api\/v1\/themes\/([a-z0-9][a-z0-9_-]{0,63})$/);
  if (match && method === "GET") return success(await router.invoke("themes.read", { themeId: match[1], pluginId }));
  if (match && method === "PATCH") {
    return success(await router.invoke("themes.update", {
      themeId: match[1],
      input: routeScopedBody(await readJson(request), pluginId),
      pluginId,
    }));
  }
  if (match && method === "DELETE") {
    return success(await router.invoke("themes.delete", {
      themeId: match[1],
      input: routeScopedBody(await readJson(request), pluginId),
      pluginId,
    }));
  }

  match = pathname.match(/^\/api\/v1\/themes\/([a-z0-9][a-z0-9_-]{0,63})\/duplicate$/);
  if (match && method === "POST") {
    return success(await router.invoke("themes.duplicate", { themeId: match[1], pluginId }), 201);
  }

  match = pathname.match(/^\/api\/v1\/themes\/([a-z0-9][a-z0-9_-]{0,63})\/(apply|validate|preview)$/);
  if (match && method === "POST") {
    const [, themeId, action] = match;
    if (action === "apply") return success(await router.invoke("themes.apply", { themeId, pluginId }));
    if (action === "validate") return success(await router.invoke("themes.validate", { themeId, pluginId }));
    const input = routeScopedBody(await readJson(request), pluginId);
    return success(await router.invoke("themes.preview", { themeId, input, pluginId }));
  }

  throw new ToolError("NOT_FOUND", "Desktop API route not found.");
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

function assetResponse(asset, method, requestedRevision) {
  if (requestedRevision && requestedRevision !== asset.revision) {
    throw new ToolError("REVISION_CONFLICT", "The requested asset revision is no longer current.", {
      expectedRevision: requestedRevision,
      actualRevision: asset.revision,
    });
  }
  const headers = responseHeaders({
    "Cache-Control": requestedRevision
      ? "private, max-age=31536000, immutable"
      : "private, no-cache",
    "Content-Length": String(asset.bytes),
    "Content-Type": asset.mime,
    ETag: `"${asset.revision}"`,
  });
  return new Response(method === "HEAD" ? null : asset.buffer, { status: 200, headers });
}

function isSpaRoute(pathname) {
  return pathname === "/" || path.posix.extname(pathname) === "";
}

async function existingFileWithinRoot(root, relativePath) {
  const rootRealPath = await fs.realpath(root).catch((error) => {
    if (error.code === "ENOENT") throw new ToolError("STUDIO_NOT_BUILT", "Build Studio before starting the desktop app.");
    throw error;
  });
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

async function staticResponse(pathname, distRoot, method) {
  if (method !== "GET" && method !== "HEAD") {
    throw new ToolError("METHOD_NOT_ALLOWED", "Static desktop resources support only GET and HEAD.");
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new ToolError("INVALID_PATH", "Desktop resource path is malformed.");
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    throw new ToolError("INVALID_PATH", "Desktop resource path is invalid.");
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  let file = await existingFileWithinRoot(distRoot, relative);
  if (!file && isSpaRoute(decoded)) file = await existingFileWithinRoot(distRoot, "index.html");
  if (!file) throw new ToolError("NOT_FOUND", "Desktop resource not found.");
  const body = method === "HEAD" ? null : await fs.readFile(file.path);
  const isIndex = path.basename(file.path) === "index.html";
  return new Response(body, {
    status: 200,
    headers: responseHeaders({
      "Cache-Control": isIndex ? "no-cache" : "public, max-age=31536000, immutable",
      "Content-Length": String(file.stat.size),
      "Content-Type": MIME_TYPES.get(path.extname(file.path).toLowerCase()) || "application/octet-stream",
    }),
  });
}

export function createDreamSkinProtocolHandler({ router, distRoot }) {
  if (!router) throw new ToolError("INVALID_BACKEND", "Desktop protocol routing requires an API router.");
  const resolvedDistRoot = path.resolve(distRoot);
  return async function handleDreamSkinRequest(request) {
    try {
      const url = new URL(request.url);
      assertTrustedProtocolUrl(url);
      if (url.pathname.startsWith("/api/")) return await apiRoute(request, url, router);
      return await staticResponse(url.pathname, resolvedDistRoot, request.method.toUpperCase());
    } catch (error) {
      return jsonResponse(errorEnvelope(error), { status: statusFor(error) });
    }
  };
}

export const DESKTOP_PROTOCOL_PRIVILEGES = Object.freeze({
  scheme: DREAMSKIN_SCHEME,
  privileges: Object.freeze({
    standard: true,
    secure: true,
    bypassCSP: false,
    allowServiceWorkers: false,
    supportFetchAPI: true,
    corsEnabled: false,
    stream: true,
    codeCache: true,
    allowExtensions: false,
  }),
});
