import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DesktopStudioApiRouter } from "../desktop/api-router.mjs";
import { createDreamSkinProtocolHandler } from "../desktop/protocol-router.mjs";
import { ToolError } from "../src/core/errors.mjs";

function backendFixture() {
  const calls = [];
  const backend = {
    bootstrap: async () => ({ product: "DreamSkin" }),
    catalog: async () => [{ id: "template-one" }],
    themes: async () => [{ localId: "theme-one" }],
    createTheme: async (input) => { calls.push(["create", input]); return input; },
    duplicateTheme: async (id) => { calls.push(["duplicate", id]); return { localId: `${id}-copy` }; },
    deleteTheme: async (id, input) => { calls.push(["delete", id, input]); return { deleted: true, themeId: id }; },
    theme: async (id) => ({ localId: id }),
    updateTheme: async (id, input) => { calls.push(["update", id, input]); return { localId: id }; },
    applyTheme: async (id) => ({ applied: id }),
    validateTheme: async (id) => ({ valid: id }),
    previewTheme: async (id, input) => ({ previewed: id, input }),
    message: async (id, input) => ({ messaged: id, input }),
    agents: async () => [],
    connectAgent: async (id) => ({ connected: id }),
    settings: async () => ({ autoVerify: true }),
    updateSettings: async (input) => input,
    verify: async (input) => ({ verified: input }),
    restore: async () => ({ restored: true }),
    asset: async (kind, id) => ({
      buffer: Buffer.from(`${kind}:${id}`),
      bytes: Buffer.byteLength(`${kind}:${id}`),
      mime: "image/png",
      revision: `${kind}-${id}-rev`,
    }),
  };
  return { backend, calls };
}

test("desktop API router exposes only named Studio operations", async () => {
  const fixture = backendFixture();
  const router = new DesktopStudioApiRouter({ backend: fixture.backend });

  assert.deepEqual(await router.invoke("bootstrap"), { product: "DreamSkin" });
  assert.deepEqual(await router.invoke("themes.read", { themeId: "theme-one" }), { localId: "theme-one" });
  await router.invoke("themes.update", {
    themeId: "theme-one",
    input: { expectedRevision: "rev-one", theme: { name: "Changed" } },
  });
  assert.deepEqual(fixture.calls, [["update", "theme-one", {
    expectedRevision: "rev-one",
    theme: { name: "Changed" },
  }]]);
  assert.deepEqual(await router.invoke("themes.duplicate", { themeId: "theme-one" }), {
    localId: "theme-one-copy",
  });
  assert.deepEqual(await router.invoke("themes.delete", {
    themeId: "theme-one",
    input: { expectedRevision: "rev-two" },
  }), { deleted: true, themeId: "theme-one" });
  assert.deepEqual(fixture.calls.slice(1), [
    ["duplicate", "theme-one"],
    ["delete", "theme-one", { expectedRevision: "rev-two" }],
  ]);

  await assert.rejects(() => router.invoke("filesystem.read", { path: "/etc/passwd" }), {
    code: "INVALID_OPERATION",
  });
  await assert.rejects(() => router.invoke("themes.read", { themeId: "../outside" }), {
    code: "INVALID_ARGUMENT",
  });
});

test("desktop API router forwards plugin scope independently from a shared theme id", async () => {
  const fixture = backendFixture();
  const calls = [];
  fixture.backend.createTheme = async (input, pluginId) => {
    calls.push(["create", pluginId, input]);
    return { pluginId, localId: "shared" };
  };
  fixture.backend.applyTheme = async (id, pluginId) => {
    calls.push(["apply", pluginId, id]);
    return { pluginId, applied: id };
  };
  fixture.backend.message = async (id, input, pluginId) => {
    calls.push(["message", pluginId, id, input]);
    return { pluginId, messaged: id };
  };
  fixture.backend.verify = async (input, pluginId) => {
    calls.push(["verify", pluginId, input]);
    return { pluginId, verified: true };
  };
  fixture.backend.restore = async (pluginId) => {
    calls.push(["restore", pluginId]);
    return { pluginId, restored: true };
  };
  fixture.backend.asset = async (kind, id, pluginId) => {
    calls.push(["asset", pluginId, kind, id]);
    return { buffer: Buffer.from("asset"), bytes: 5, mime: "image/png", revision: "revision-one" };
  };
  const router = new DesktopStudioApiRouter({ backend: fixture.backend });
  const pluginId = "dreamskin.workbuddy";

  await router.invoke("themes.create", { kind: "blank", pluginId });
  await router.invoke("themes.apply", { themeId: "shared", pluginId });
  await router.invoke("themes.message", {
    themeId: "shared",
    pluginId,
    input: { prompt: "brighter", expectedRevision: "revision-one" },
  });
  await router.invoke("runtime.verify", { screenshot: false, pluginId });
  await router.invoke("runtime.restore", { pluginId });
  await router.asset("theme", "shared", pluginId);

  assert.deepEqual(calls, [
    ["create", pluginId, { kind: "blank" }],
    ["apply", pluginId, "shared"],
    ["message", pluginId, "shared", { prompt: "brighter", expectedRevision: "revision-one" }],
    ["verify", pluginId, { screenshot: false }],
    ["restore", pluginId],
    ["asset", pluginId, "theme", "shared"],
  ]);
  await assert.rejects(
    () => router.invoke("themes.list", { pluginId: "Bad.Plugin" }),
    (error) => error.code === "INVALID_ARGUMENT",
  );
});

test("dreamskin protocol serves the SPA, immutable assets, and Studio API", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-desktop-protocol-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const distRoot = path.join(root, "dist");
  await fs.mkdir(path.join(distRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(distRoot, "index.html"), "<!doctype html><title>DreamSkin</title>");
  await fs.writeFile(path.join(distRoot, "assets", "app.js"), "globalThis.dreamskin = true;");
  await fs.writeFile(path.join(root, "secret.txt"), "outside");
  await fs.symlink(path.join(root, "secret.txt"), path.join(distRoot, "escape.txt"));

  const fixture = backendFixture();
  const router = new DesktopStudioApiRouter({ backend: fixture.backend });
  const handle = createDreamSkinProtocolHandler({ router, distRoot });

  const index = await handle(new Request("dreamskin://studio/"));
  assert.equal(index.status, 200);
  assert.match(await index.text(), /DreamSkin/);
  assert.match(index.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(index.headers.get("x-frame-options"), "DENY");
  assert.equal(index.headers.get("cache-control"), "no-cache");

  const spa = await handle(new Request("dreamskin://studio/my-themes"));
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /DreamSkin/);

  const script = await handle(new Request("dreamskin://studio/assets/app.js"));
  assert.equal(script.status, 200);
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(script.headers.get("cache-control"), /immutable/);

  const missingAsset = await handle(new Request("dreamskin://studio/assets/missing.js"));
  assert.equal(missingAsset.status, 404);
  assert.equal((await missingAsset.json()).error.code, "NOT_FOUND");

  const escapedSymlink = await handle(new Request("dreamskin://studio/escape.txt"));
  assert.equal(escapedSymlink.status, 404);

  const catalog = await handle(new Request("dreamskin://studio/api/v1/catalog"));
  assert.deepEqual(await catalog.json(), { ok: true, result: [{ id: "template-one" }] });

  const created = await handle(new Request("dreamskin://studio/api/v1/themes", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "dreamskin://studio", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ kind: "blank" }),
  }));
  assert.equal(created.status, 201);
  assert.deepEqual(fixture.calls[0], ["create", { kind: "blank" }]);

  const mutationHeaders = { Origin: "dreamskin://studio", "Sec-Fetch-Site": "same-origin" };
  const duplicated = await handle(new Request("dreamskin://studio/api/v1/themes/theme-one/duplicate", {
    method: "POST",
    headers: mutationHeaders,
  }));
  assert.equal(duplicated.status, 201);
  assert.deepEqual((await duplicated.json()).result, { localId: "theme-one-copy" });

  const deleted = await handle(new Request("dreamskin://studio/api/v1/themes/theme-one", {
    method: "DELETE",
    headers: { ...mutationHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: "theme-theme-one-rev" }),
  }));
  assert.equal(deleted.status, 200);
  assert.deepEqual((await deleted.json()).result, { deleted: true, themeId: "theme-one" });
  assert.deepEqual(fixture.calls.slice(1), [
    ["duplicate", "theme-one"],
    ["delete", "theme-one", { expectedRevision: "theme-theme-one-rev" }],
  ]);

  const asset = await handle(new Request("dreamskin://studio/api/v1/themes/theme-one/asset?revision=theme-theme-one-rev", { method: "HEAD" }));
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("etag"), '"theme-theme-one-rev"');
  assert.match(asset.headers.get("cache-control"), /immutable/);
  assert.equal((await asset.arrayBuffer()).byteLength, 0);

  const uncachedAsset = await handle(new Request("dreamskin://studio/api/v1/themes/theme-one/asset"));
  assert.equal(uncachedAsset.status, 200);
  assert.equal(uncachedAsset.headers.get("cache-control"), "private, no-cache");

  const staleAsset = await handle(new Request("dreamskin://studio/api/v1/themes/theme-one/asset?revision=old"));
  assert.equal(staleAsset.status, 409);
  assert.equal((await staleAsset.json()).error.code, "REVISION_CONFLICT");

  for (const query of ["revision=", "revision=one&revision=two", "cache=forever"]) {
    const invalidAsset = await handle(new Request(`dreamskin://studio/api/v1/themes/theme-one/asset?${query}`));
    assert.equal(invalidAsset.status, 400);
    assert.equal((await invalidAsset.json()).error.code, "INVALID_ARGUMENT");
  }

  fixture.backend.deleteTheme = async () => {
    throw new ToolError("THEME_ACTIVE", "The active theme cannot be deleted.");
  };
  const activeDelete = await handle(new Request("dreamskin://studio/api/v1/themes/theme-one", {
    method: "DELETE",
    headers: { ...mutationHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: "theme-theme-one-rev" }),
  }));
  assert.equal(activeDelete.status, 409);
  assert.equal((await activeDelete.json()).error.code, "THEME_ACTIVE");
});

test("dreamskin protocol exposes target-scoped Studio routes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-desktop-scoped-protocol-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "index.html"), "studio");
  const fixture = backendFixture();
  const calls = [];
  fixture.backend.catalog = async (pluginId) => {
    calls.push(["catalog", pluginId]);
    return [{ pluginId }];
  };
  fixture.backend.message = async (id, input, pluginId) => {
    calls.push(["message", pluginId, id, input]);
    return { pluginId, id };
  };
  const handle = createDreamSkinProtocolHandler({
    router: new DesktopStudioApiRouter({ backend: fixture.backend }),
    distRoot: root,
  });
  const pluginId = "dreamskin.workbuddy";
  const catalog = await handle(new Request(`dreamskin://studio/api/v1/plugins/${pluginId}/catalog`));
  assert.equal(catalog.status, 200);
  assert.equal((await catalog.json()).result[0].pluginId, pluginId);

  const message = await handle(new Request(
    `dreamskin://studio/api/v1/plugins/${pluginId}/themes/shared/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "dreamskin://studio",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ prompt: "warmer", expectedRevision: "revision-one" }),
    },
  ));
  assert.equal(message.status, 200);
  assert.deepEqual(calls, [
    ["catalog", pluginId],
    ["message", pluginId, "shared", { prompt: "warmer", expectedRevision: "revision-one" }],
  ]);

  const mismatch = await handle(new Request(
    `dreamskin://studio/api/v1/plugins/${pluginId}/themes/shared/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "dreamskin://studio",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({
        prompt: "warmer",
        expectedRevision: "revision-one",
        pluginId: "dreamskin.trae",
      }),
    },
  ));
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error.code, "INVALID_ARGUMENT");
});

test("dreamskin protocol rejects untrusted origins, hosts, and payload types", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-desktop-security-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "index.html"), "studio");
  const fixture = backendFixture();
  const handle = createDreamSkinProtocolHandler({
    router: new DesktopStudioApiRouter({ backend: fixture.backend }),
    distRoot: root,
  });

  const wrongHost = await handle(new Request("dreamskin://attacker/api/v1/catalog"));
  assert.equal(wrongHost.status, 403);

  const wrongOrigin = await handle(new Request("dreamskin://studio/api/v1/themes", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
    body: "{}",
  }));
  assert.equal(wrongOrigin.status, 403);
  assert.equal((await wrongOrigin.json()).error.code, "INVALID_ORIGIN");

  const wrongType = await handle(new Request("dreamskin://studio/api/v1/themes", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      Origin: "dreamskin://studio",
      "Sec-Fetch-Site": "same-origin",
    },
    body: "{}",
  }));
  assert.equal(wrongType.status, 415);
  assert.equal((await wrongType.json()).error.code, "INVALID_CONTENT_TYPE");

  const missingProvenance = await handle(new Request("dreamskin://studio/api/v1/themes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }));
  assert.equal(missingProvenance.status, 403);
  assert.equal((await missingProvenance.json()).error.code, "INVALID_ORIGIN");
});
