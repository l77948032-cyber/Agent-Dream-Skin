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
