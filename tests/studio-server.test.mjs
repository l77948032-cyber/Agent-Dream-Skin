import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolError } from "../src/core/errors.mjs";
import { StudioBackend } from "../src/core/studio-backend.mjs";
import { createStudioHttpServer, startStudioServer } from "../src/studio-server.mjs";

async function serverFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-studio-http-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const distRoot = path.join(root, "dist");
  await fs.mkdir(distRoot, { recursive: true });
  await fs.writeFile(path.join(distRoot, "index.html"), "<!doctype html><title>Studio test</title>");
  const assetBody = Buffer.from("studio-asset");

  const calls = [];
  let closed = 0;
  const backend = {
    bootstrap: async () => ({ product: "DreamSkin Studio" }),
    catalog: async () => [{ id: "template-one" }],
    themes: async () => [{ localId: "theme-one" }],
    createTheme: async (input) => { calls.push(["createTheme", input]); return { localId: "created", input }; },
    duplicateTheme: async (id) => { calls.push(["duplicateTheme", id]); return { localId: `${id}-copy` }; },
    deleteTheme: async (id, input) => { calls.push(["deleteTheme", id, input]); return { deleted: true, themeId: id }; },
    theme: async (id) => ({ localId: id }),
    updateTheme: async (id, input) => { calls.push(["updateTheme", id, input]); return { localId: id, input }; },
    applyTheme: async (id) => ({ applied: id }),
    validateTheme: async (id) => ({ valid: true, id }),
    previewTheme: async (id, input) => ({ previewed: id, input }),
    message: async (id, input) => ({ messaged: id, input }),
    agents: async () => [],
    connectAgent: async (id) => ({ connected: id }),
    settings: async () => ({ autoVerify: true }),
    updateSettings: async (input) => input,
    verify: async (input) => ({ verified: input }),
    restore: async () => ({ restored: true }),
    asset: async (kind, id) => ({
      buffer: assetBody,
      mime: "image/png",
      bytes: assetBody.length,
      revision: `${kind}-${id}-revision`,
    }),
    close: async () => { closed += 1; },
  };
  const server = createStudioHttpServer({ backend, distRoot });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return {
    backend,
    calls,
    server,
    root,
    distRoot,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    assetBody,
    get closed() { return closed; },
  };
}

async function jsonResponse(response) {
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function rawRequest({ port, path: requestPath, method = "GET", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: requestPath,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

test("Studio HTTP routes return stable success envelopes and parsed request bodies", async (t) => {
  const fixture = await serverFixture(t);

  const catalog = await jsonResponse(await fetch(`${fixture.baseUrl}/api/v1/catalog`));
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body, { ok: true, result: [{ id: "template-one" }] });
  assert.equal(catalog.headers.get("cache-control"), "no-store");

  const created = await jsonResponse(await fetch(`${fixture.baseUrl}/api/v1/themes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "template", sourceId: "sunlit-spark" }),
  }));
  assert.equal(created.status, 201);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.result.localId, "created");
  assert.deepEqual(fixture.calls[0], ["createTheme", { kind: "template", sourceId: "sunlit-spark" }]);

  const patched = await jsonResponse(await fetch(`${fixture.baseUrl}/api/v1/themes/theme-one`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: "abc", theme: { name: "Changed" } }),
  }));
  assert.equal(patched.status, 200);
  assert.deepEqual(fixture.calls[1], ["updateTheme", "theme-one", {
    expectedRevision: "abc",
    theme: { name: "Changed" },
  }]);

  const duplicated = await jsonResponse(await fetch(`${fixture.baseUrl}/api/v1/themes/theme-one/duplicate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }));
  assert.equal(duplicated.status, 201);
  assert.equal(duplicated.body.result.localId, "theme-one-copy");

  const deleted = await jsonResponse(await fetch(`${fixture.baseUrl}/api/v1/themes/theme-one`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: "rev-two" }),
  }));
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.result, { deleted: true, themeId: "theme-one" });
  assert.deepEqual(fixture.calls.slice(2), [
    ["duplicateTheme", "theme-one"],
    ["deleteTheme", "theme-one", { expectedRevision: "rev-two" }],
  ]);
});

test("Studio HTTP plugin routes preserve the composite plugin and theme scope", async (t) => {
  const fixture = await serverFixture(t);
  const calls = [];
  const pluginId = "dreamskin.workbuddy";
  fixture.backend.catalog = async (scope) => {
    calls.push(["catalog", scope]);
    return [{ pluginId: scope }];
  };
  fixture.backend.themes = async (scope) => {
    calls.push(["themes", scope]);
    return [{ pluginId: scope, localId: "shared" }];
  };
  fixture.backend.createTheme = async (input, scope) => {
    calls.push(["create", scope, input]);
    return { pluginId: scope, localId: "created" };
  };
  fixture.backend.updateTheme = async (id, input, scope) => {
    calls.push(["update", scope, id, input]);
    return { pluginId: scope, localId: id };
  };
  fixture.backend.applyTheme = async (id, scope) => {
    calls.push(["apply", scope, id]);
    return { pluginId: scope, applied: id };
  };
  fixture.backend.message = async (id, input, scope) => {
    calls.push(["message", scope, id, input]);
    return { pluginId: scope, messaged: id };
  };
  fixture.backend.verify = async (input, scope) => {
    calls.push(["verify", scope, input]);
    return { pluginId: scope, verified: true };
  };
  fixture.backend.restore = async (scope) => {
    calls.push(["restore", scope]);
    return { pluginId: scope, restored: true };
  };
  const prefix = `${fixture.baseUrl}/api/v1/plugins/${pluginId}`;
  const jsonHeaders = { "Content-Type": "application/json" };

  assert.equal((await jsonResponse(await fetch(`${prefix}/catalog`))).body.result[0].pluginId, pluginId);
  assert.equal((await jsonResponse(await fetch(`${prefix}/themes`))).body.result[0].pluginId, pluginId);
  await fetch(`${prefix}/themes`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ kind: "blank", pluginId }),
  });
  await fetch(`${prefix}/themes/shared`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ expectedRevision: "revision-one", theme: { name: "Changed" } }),
  });
  await fetch(`${prefix}/themes/shared/apply`, { method: "POST" });
  await fetch(`${prefix}/themes/shared/messages`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ prompt: "warmer", expectedRevision: "revision-one" }),
  });
  await fetch(`${prefix}/runtime/verify`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ screenshot: false }),
  });
  await fetch(`${prefix}/runtime/restore`, { method: "POST" });

  assert.deepEqual(calls, [
    ["catalog", pluginId],
    ["themes", pluginId],
    ["create", pluginId, { kind: "blank" }],
    ["update", pluginId, "shared", { expectedRevision: "revision-one", theme: { name: "Changed" } }],
    ["apply", pluginId, "shared"],
    ["message", pluginId, "shared", { prompt: "warmer", expectedRevision: "revision-one" }],
    ["verify", pluginId, { screenshot: false }],
    ["restore", pluginId],
  ]);

  const mismatch = await jsonResponse(await fetch(`${prefix}/themes`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ kind: "blank", pluginId: "dreamskin.trae" }),
  }));
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.code, "INVALID_ARGUMENT");

  const malformed = await jsonResponse(await fetch(`${fixture.baseUrl}/api/v1/plugins/Bad.Plugin/themes`));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, "INVALID_ARGUMENT");
});

test("Studio HTTP maps malformed bodies and backend errors to stable error envelopes", async (t) => {
  const fixture = await serverFixture(t);
  fixture.backend.updateTheme = async () => {
    throw new ToolError("REVISION_CONFLICT", "The theme changed.", { actualRevision: "new" });
  };

  const malformed = await rawRequest({
    port: fixture.port,
    path: "/api/v1/themes",
    method: "POST",
    headers: { Host: `127.0.0.1:${fixture.port}`, "Content-Type": "application/json" },
    body: "{not-json",
  });
  assert.equal(malformed.status, 400);
  assert.equal(JSON.parse(malformed.body).ok, false);
  assert.equal(JSON.parse(malformed.body).error.code, "INVALID_JSON");

  const conflict = await jsonResponse(await fetch(`${fixture.baseUrl}/api/v1/themes/theme-one`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: "old", theme: {} }),
  }));
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body, {
    ok: false,
    error: {
      code: "REVISION_CONFLICT",
      message: "The theme changed.",
      details: { actualRevision: "new" },
    },
  });

  const missing = await jsonResponse(await fetch(`${fixture.baseUrl}/api/v1/does-not-exist`));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "NOT_FOUND");
});

test("Studio HTTP streams revisioned assets for GET and metadata-only HEAD", async (t) => {
  const fixture = await serverFixture(t);
  const get = await fetch(`${fixture.baseUrl}/api/v1/themes/theme-one/asset`);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "image/png");
  assert.equal(get.headers.get("etag"), '"theme-theme-one-revision"');
  assert.equal(get.headers.get("cache-control"), "private, no-cache");
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), fixture.assetBody);

  const head = await fetch(`${fixture.baseUrl}/api/v1/catalog/template-one/asset?revision=catalog-template-one-revision`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(fixture.assetBody.length));
  assert.equal(head.headers.get("etag"), '"catalog-template-one-revision"');
  assert.equal(head.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const stale = await jsonResponse(await fetch(`${fixture.baseUrl}/api/v1/themes/theme-one/asset?revision=old`));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "REVISION_CONFLICT");

  for (const query of ["revision=", "revision=one&revision=two", "cache=forever"]) {
    const invalid = await jsonResponse(await fetch(`${fixture.baseUrl}/api/v1/themes/theme-one/asset?${query}`));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "INVALID_ARGUMENT");
  }
});

test("Studio HTTP static files cannot escape distRoot through symlinks", async (t) => {
  const fixture = await serverFixture(t);
  const outside = path.join(fixture.root, "outside-secret.txt");
  await fs.writeFile(outside, "outside secret");
  await fs.symlink(outside, path.join(fixture.distRoot, "escape.txt"));

  const escaped = await fetch(`${fixture.baseUrl}/escape.txt`);
  const body = await escaped.text();
  assert.equal(escaped.status, 503);
  assert.doesNotMatch(body, /outside secret/);
  assert.equal(JSON.parse(body).error.code, "STUDIO_NOT_BUILT");
});

test("Studio HTTP accepts only loopback Host headers and loopback bind addresses", async (t) => {
  const fixture = await serverFixture(t);
  const accepted = await rawRequest({
    port: fixture.port,
    path: "/api/v1/catalog",
    headers: { Host: `localhost:${fixture.port}` },
  });
  assert.equal(accepted.status, 200);

  const rejected = await rawRequest({
    port: fixture.port,
    path: "/api/v1/catalog",
    headers: { Host: "studio.example.test" },
  });
  assert.equal(rejected.status, 400);
  const rejectedBody = JSON.parse(rejected.body);
  assert.equal(rejectedBody.ok, false);
  assert.equal(rejectedBody.error.code, "INVALID_HOST");

  await assert.rejects(
    () => startStudioServer({ host: "0.0.0.0", port: 0, backend: fixture.backend }),
    (error) => error.code === "INVALID_HOST",
  );
});

test("Studio HTTP rejects cross-origin writes and non-JSON mutation payloads", async (t) => {
  const fixture = await serverFixture(t);
  const host = `127.0.0.1:${fixture.port}`;
  const sameOrigin = `http://${host}`;
  const createBody = JSON.stringify({ kind: "blank" });

  const crossOrigin = await rawRequest({
    port: fixture.port,
    path: "/api/v1/themes",
    method: "POST",
    headers: {
      Host: host,
      Origin: "https://attacker.example",
      "Sec-Fetch-Site": "cross-site",
      "Content-Type": "application/json",
    },
    body: createBody,
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(JSON.parse(crossOrigin.body).error.code, "INVALID_ORIGIN");

  const browserWithoutOrigin = await rawRequest({
    port: fixture.port,
    path: "/api/v1/themes",
    method: "POST",
    headers: {
      Host: host,
      "Sec-Fetch-Site": "cross-site",
      "Content-Type": "application/json",
    },
    body: createBody,
  });
  assert.equal(browserWithoutOrigin.status, 403);
  assert.equal(JSON.parse(browserWithoutOrigin.body).error.code, "INVALID_ORIGIN");

  const plainText = await rawRequest({
    port: fixture.port,
    path: "/api/v1/themes",
    method: "POST",
    headers: {
      Host: host,
      Origin: sameOrigin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "text/plain",
    },
    body: createBody,
  });
  assert.equal(plainText.status, 415);
  assert.equal(JSON.parse(plainText.body).error.code, "INVALID_CONTENT_TYPE");

  const sameOriginWrite = await rawRequest({
    port: fixture.port,
    path: "/api/v1/themes",
    method: "POST",
    headers: {
      Host: host,
      Origin: sameOrigin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json; charset=utf-8",
    },
    body: createBody,
  });
  assert.equal(sameOriginWrite.status, 201);

  const viteProxyWrite = await rawRequest({
    port: fixture.port,
    path: "/api/v1/themes",
    method: "POST",
    headers: {
      Host: host,
      Origin: "http://127.0.0.1:5173",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    },
    body: createBody,
  });
  assert.equal(viteProxyWrite.status, 201);

  const nativeWrite = await rawRequest({
    port: fixture.port,
    path: "/api/v1/themes",
    method: "POST",
    headers: { Host: host, "Content-Type": "application/json" },
    body: createBody,
  });
  assert.equal(nativeWrite.status, 201);

  const bodylessSameOriginWrite = await rawRequest({
    port: fixture.port,
    path: "/api/v1/agents/codex/connect",
    method: "POST",
    headers: { Host: host, Origin: sameOrigin, "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(bodylessSameOriginWrite.status, 200);
  assert.equal(fixture.calls.filter(([name]) => name === "createTheme").length, 3);
});

test("Studio backend keeps catalogs, themes, runtime, components, and chat scoped by plugin", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-studio-targets-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const pluginIds = ["dreamskin.trae", "dreamskin.workbuddy"];
  const descriptors = new Map();
  const targets = [];

  for (const pluginId of pluginIds) {
    const targetId = pluginId.split(".").at(-1);
    const registryPath = path.join(root, `${targetId}-components.json`);
    await fs.writeFile(registryPath, JSON.stringify({
      components: [{
        id: `${targetId}.surface`,
        description: `${targetId} surface`,
        modes: ["light"],
        states: ["default"],
        visualSlots: ["background"],
      }],
    }));
    const descriptor = {
      id: pluginId,
      state: "active",
      active: true,
      manifest: {
        id: pluginId,
        name: targetId,
        version: "1.0.0",
        target: { id: targetId, name: targetId === "trae" ? "Trae" : "WorkBuddy", platforms: ["darwin"] },
      },
    };
    descriptors.set(pluginId, descriptor);
    const library = {
      catalog: async () => [{ pluginId, id: `${targetId}-template` }],
      list: async ({ activeThemeId } = {}) => [{ pluginId, localId: "shared", activeThemeId }],
      settings: async () => ({ autoVerify: true, selectedAgentId: "codex" }),
      read: async (id) => ({
        pluginId,
        localId: id,
        revisionHash: `${pluginId}:revision-1`,
        theme: { colors: { accent: "#111111" } },
      }),
      markApplied: async (id, revision) => ({ pluginId, localId: id, revisionHash: revision, status: "applied" }),
      reconcile: async (id) => ({
        pluginId,
        localId: id,
        revisionHash: `${pluginId}:revision-2`,
        theme: { colors: { accent: "#222222" } },
      }),
    };
    targets.push({
      pluginId,
      targetId,
      targetName: descriptor.manifest.target.name,
      library,
      registryPath,
      themesRoot: path.join(root, "themes", targetId),
    });
  }

  const backend = new StudioBackend({
    tool: {
      inspect: async (pluginId) => ({ pluginId, inspected: true }),
      validateTheme: async (input, pluginId) => {
        calls.push(["validate", pluginId, input.themeId]);
        return { valid: true };
      },
    },
    runtimeManager: {
      status: async (pluginId) => ({ available: true, session: "off", pluginId }),
      apply: async (id, pluginId) => {
        calls.push(["apply", pluginId, id]);
        return { applied: true, pluginId, themeId: id };
      },
      verify: async (input, pluginId) => {
        calls.push(["verify", pluginId, input]);
        return { verified: true, pluginId };
      },
      restore: async (pluginId) => {
        calls.push(["restore", pluginId]);
        return { restored: true, pluginId };
      },
    },
    pluginManager: {
      get: (pluginId) => descriptors.get(pluginId),
      list: () => [...descriptors.values()],
    },
    library: targets[0].library,
    targets,
    defaultPluginId: "dreamskin.trae",
    sessions: {
      selectedAgentId: "codex",
      agents: async () => [{ id: "codex" }],
      connectionState: () => ({ agentId: "codex", state: "connected" }),
      prompt: async (input) => {
        calls.push(["message", input.pluginId, input.themeId, input.expectedRevision]);
        return {
          text: "主题已更新",
          sessionId: "session-one",
          response: { stopReason: "end_turn" },
        };
      },
      acceptRevision: (input) => { calls.push(["accept", input.pluginId, input.themeId, input.revision]); },
    },
    dataRoot: path.join(root, "data"),
  });

  const bootstrap = await backend.bootstrap();
  assert.equal(bootstrap.activePluginId, "dreamskin.trae");
  assert.equal(bootstrap.targets.length, 2);
  assert.deepEqual(
    bootstrap.targets.map(({ pluginId, catalog, themes, runtime, components }) => ({
      pluginId,
      catalogPluginId: catalog[0].pluginId,
      themePluginId: themes[0].pluginId,
      runtimePluginId: runtime.pluginId,
      componentId: components[0].id,
    })),
    [
      {
        pluginId: "dreamskin.trae",
        catalogPluginId: "dreamskin.trae",
        themePluginId: "dreamskin.trae",
        runtimePluginId: "dreamskin.trae",
        componentId: "trae.surface",
      },
      {
        pluginId: "dreamskin.workbuddy",
        catalogPluginId: "dreamskin.workbuddy",
        themePluginId: "dreamskin.workbuddy",
        runtimePluginId: "dreamskin.workbuddy",
        componentId: "workbuddy.surface",
      },
    ],
  );
  assert.equal((await backend.theme("shared")).pluginId, "dreamskin.trae");
  assert.equal((await backend.theme("shared", "dreamskin.workbuddy")).pluginId, "dreamskin.workbuddy");

  calls.length = 0;
  await backend.applyTheme("shared", "dreamskin.workbuddy");
  await backend.verify({ screenshot: false }, "dreamskin.workbuddy");
  await backend.restore("dreamskin.workbuddy");
  const messaged = await backend.message("shared", {
    prompt: "make it brighter",
    componentId: "workbuddy.surface",
    expectedRevision: "dreamskin.workbuddy:revision-1",
  }, "dreamskin.workbuddy");
  assert.equal(messaged.theme.pluginId, "dreamskin.workbuddy");
  assert.deepEqual(calls, [
    ["validate", "dreamskin.workbuddy", "shared"],
    ["apply", "dreamskin.workbuddy", "shared"],
    ["verify", "dreamskin.workbuddy", { screenshot: false }],
    ["restore", "dreamskin.workbuddy"],
    ["message", "dreamskin.workbuddy", "shared", "dreamskin.workbuddy:revision-1"],
    ["accept", "dreamskin.workbuddy", "shared", "dreamskin.workbuddy:revision-2"],
    ["validate", "dreamskin.workbuddy", "shared"],
  ]);
  assert.throws(
    () => backend.verify({ pluginId: "dreamskin.trae" }, "dreamskin.workbuddy"),
    (error) => error.code === "INVALID_ARGUMENT",
  );
});

test("Studio backend generates screenshot paths only inside its data root", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-studio-previews-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const requestedPath = path.join(root, "outside", "overwrite-me.png");
  const calls = [];
  const runtimeManager = {
    preview: async (input) => { calls.push(["preview", input]); return input; },
    verify: async (options) => { calls.push(["verify", options]); return options; },
  };
  const backend = new StudioBackend({
    tool: {},
    runtimeManager,
    pluginManager: { list: () => [] },
    library: { read: async (id) => ({ localId: id }) },
    sessions: {},
    dataRoot,
    themesRoot: path.join(root, "themes"),
  });

  await backend.previewTheme("theme-one", { screenshotPath: requestedPath });
  await backend.verify({ screenshot: true, screenshotPath: requestedPath });
  await backend.verify({ screenshot: false, screenshotPath: requestedPath });

  const previewRoot = path.join(path.resolve(dataRoot), "previews");
  const previewOptions = calls[0][1];
  const verifyOptions = calls[1][1];
  assert.equal(previewOptions.screenshot, true);
  assert.equal(verifyOptions.screenshot, true);
  assert.equal(path.dirname(previewOptions.screenshotPath), previewRoot);
  assert.equal(path.dirname(verifyOptions.screenshotPath), previewRoot);
  assert.match(path.basename(previewOptions.screenshotPath), /^preview-\d+-[0-9a-f-]{36}\.png$/);
  assert.match(path.basename(verifyOptions.screenshotPath), /^verify-\d+-[0-9a-f-]{36}\.png$/);
  assert.notEqual(previewOptions.screenshotPath, requestedPath);
  assert.notEqual(verifyOptions.screenshotPath, requestedPath);
  assert.deepEqual(calls[2][1], { screenshot: false });
});

test("Studio isolated user data mode reports an offline runtime and blocks all runtime mutations", async () => {
  const calls = [];
  const backend = new StudioBackend({
    tool: {
      validateTheme: async () => { calls.push("validate"); },
    },
    runtimeManager: {
      status: async () => { calls.push("status"); },
      apply: async () => { calls.push("apply"); },
      preview: async () => { calls.push("preview"); },
      verify: async () => { calls.push("verify"); },
      restore: async () => { calls.push("restore"); },
    },
    pluginManager: { list: () => [] },
    library: {
      read: async () => { calls.push("read"); },
    },
    sessions: {},
    runtimeMutationsEnabled: false,
  });

  assert.deepEqual(await backend.runtimeStatus(), {
    available: false,
    session: "off",
    themeId: null,
    reason: "isolated-user-data",
  });
  const isReadOnlyError = (error) => error instanceof ToolError
    && error.code === "RUNTIME_PROFILE_READ_ONLY"
    && error.details.pluginId === "dreamskin.trae"
    && error.details.reason === "isolated-user-data";
  await assert.rejects(() => backend.applyTheme("theme-one"), isReadOnlyError);
  await assert.rejects(() => backend.previewTheme("theme-one"), isReadOnlyError);
  assert.throws(() => backend.verify(), isReadOnlyError);
  assert.throws(() => backend.restore(), isReadOnlyError);
  assert.deepEqual(calls, []);
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test("Studio deletion fails closed when runtime status is unavailable", async () => {
  let deleteCalls = 0;
  const backend = new StudioBackend({
    tool: {},
    runtimeManager: {
      status: async () => ({
        available: false,
        error: { code: "RUNTIME_COMMAND_FAILED", message: "status failed" },
      }),
    },
    pluginManager: { list: () => [] },
    library: {
      delete: async () => { deleteCalls += 1; },
    },
    sessions: {},
  });

  await assert.rejects(
    () => backend.deleteTheme("theme-one", { expectedRevision: "revision-one" }),
    (error) => error.code === "RUNTIME_COMMAND_FAILED"
      && error.details.runtimeError.message === "status failed",
  );
  assert.equal(deleteCalls, 0);
});

test("Studio keeps a degraded runtime theme applied and prevents its deletion", async () => {
  let deleteCalls = 0;
  let listedActiveThemeId = null;
  const backend = new StudioBackend({
    tool: {},
    runtimeManager: {
      status: async () => ({
        session: "degraded",
        themeId: "theme-one",
        themeRevision: "revision-one",
      }),
    },
    pluginManager: { list: () => [] },
    library: {
      list: async ({ activeThemeId: value }) => {
        listedActiveThemeId = value;
        return [{ localId: "theme-one", status: value === "theme-one" ? "applied" : "ready" }];
      },
      delete: async () => { deleteCalls += 1; },
    },
    sessions: {},
  });

  const themes = await backend.themes();
  assert.equal(listedActiveThemeId, "theme-one");
  assert.equal(themes[0].status, "applied");
  await assert.rejects(
    () => backend.deleteTheme("theme-one", { expectedRevision: "revision-one" }),
    (error) => error.code === "THEME_ACTIVE",
  );
  assert.equal(deleteCalls, 0);
});

test("Studio blocks deletion while an owned runtime has no trustworthy theme identity", async () => {
  for (const session of ["orphaned", "orphaned-unverified", "active", "degraded"]) {
    let deleteCalls = 0;
    const backend = new StudioBackend({
      tool: {},
      runtimeManager: { status: async () => ({ session }) },
      pluginManager: { list: () => [] },
      library: { delete: async () => { deleteCalls += 1; } },
      sessions: {},
    });

    await assert.rejects(
      () => backend.deleteTheme("theme-one", { expectedRevision: "revision-one" }),
      (error) => error.code === "THEME_ACTIVE"
        && error.details.runtimeSession === session
        && error.details.themeId === null,
      session,
    );
    assert.equal(deleteCalls, 0, session);
  }
});

test("Studio apply and delete share one lifecycle lock", async () => {
  const applyStarted = deferred();
  const finishApply = deferred();
  let activeThemeId = null;
  let statusCalls = 0;
  let deleteCalls = 0;
  const backend = new StudioBackend({
    tool: { validateTheme: async () => ({ valid: true }) },
    runtimeManager: {
      async apply(id) {
        applyStarted.resolve();
        await finishApply.promise;
        activeThemeId = id;
        return { applied: true, themeId: id };
      },
      async status() {
        statusCalls += 1;
        return activeThemeId
          ? { session: "active", themeId: activeThemeId }
          : { session: "off" };
      },
    },
    pluginManager: { list: () => [] },
    library: {
      read: async (id) => ({ localId: id, revisionHash: "revision-one" }),
      markApplied: async (id) => ({ localId: id, status: "applied" }),
      delete: async () => { deleteCalls += 1; },
    },
    sessions: {},
  });

  const applying = backend.applyTheme("theme-one");
  await applyStarted.promise;
  const deleting = assert.rejects(
    backend.deleteTheme("theme-one", { expectedRevision: "revision-one" }),
    (error) => error.code === "THEME_ACTIVE",
  );
  await Promise.resolve();
  assert.equal(statusCalls, 0);
  assert.equal(deleteCalls, 0);

  finishApply.resolve();
  await applying;
  await deleting;
  assert.equal(statusCalls, 1);
  assert.equal(deleteCalls, 0);
});

test("Studio serializes theme edits, previews, and restore behind runtime apply", async () => {
  const applyStarted = deferred();
  const finishApply = deferred();
  const calls = [];
  const backend = new StudioBackend({
    tool: { validateTheme: async () => ({ valid: true }) },
    runtimeManager: {
      async apply() {
        calls.push("apply");
        applyStarted.resolve();
        await finishApply.promise;
        return { applied: true };
      },
      async status() { calls.push("status"); return { session: "off" }; },
      async preview() { calls.push("preview"); return { previewed: true }; },
      async restore() { calls.push("restore"); return { restored: true }; },
    },
    pluginManager: { list: () => [] },
    library: {
      read: async (id) => ({ localId: id, revisionHash: "revision-one" }),
      markApplied: async (id) => ({ localId: id, status: "applied" }),
      update: async (id) => { calls.push("update"); return { localId: id }; },
    },
    sessions: {},
  });

  const applying = backend.applyTheme("theme-one");
  await applyStarted.promise;
  const updating = backend.updateTheme("theme-one", { expectedRevision: "revision-one", theme: {} });
  const previewing = backend.previewTheme("theme-one", { screenshot: false });
  const restoring = backend.restore();
  await Promise.resolve();
  assert.deepEqual(calls, ["apply"]);

  finishApply.resolve();
  await Promise.all([applying, updating, previewing, restoring]);
  assert.deepEqual(calls, ["apply", "status", "update", "preview", "restore"]);
});

test("Studio restores the host if an applied revision cannot be recorded", async () => {
  let restoreCalls = 0;
  const conflict = new ToolError("REVISION_CONFLICT", "Theme changed during apply.");
  const backend = new StudioBackend({
    tool: { validateTheme: async () => ({ valid: true }) },
    runtimeManager: {
      apply: async () => ({ applied: true }),
      restore: async () => { restoreCalls += 1; },
    },
    pluginManager: { list: () => [] },
    library: {
      read: async (id) => ({ localId: id, revisionHash: "revision-one" }),
      markApplied: async () => { throw conflict; },
    },
    sessions: {},
  });

  await assert.rejects(() => backend.applyTheme("theme-one"), (error) => error === conflict);
  assert.equal(restoreCalls, 1);
});
