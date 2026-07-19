import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const cssUrl = new URL("../assets/trae-skin.css", import.meta.url);

test("interaction styling covers portals and the complete control state ladder", async () => {
  const css = await fs.readFile(cssUrl, "utf8");

  for (const required of [
    '[role="tooltip"] > [class*="container-"]',
    '[role="tooltip"] [class*="arrow-"] path',
    '[class^="popover-"][role="dialog"]',
    ".headerViewMenu__item--active",
    ".core-model-select-portal-content",
    ".taskIconBtn",
    ":not(:disabled):hover",
    ":not(:disabled):active",
    ":focus-visible",
    '[aria-disabled="true"]',
    '[data-state="open"]',
  ]) {
    assert.ok(css.includes(required), `missing interaction selector: ${required}`);
  }

  assert.doesNotMatch(
    css,
    /\.task-list-panel\s+:is\(\s*\[class\*="selected"\],\s*\[class\*="active"\]/,
    "task state styling must not match every generated active class",
  );
});
