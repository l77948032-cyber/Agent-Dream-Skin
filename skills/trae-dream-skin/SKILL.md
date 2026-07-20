---
name: trae-dream-skin
description: Use when an agent needs to inspect, create, edit, or validate a Trae or WorkBuddy theme through the local DreamSkin CLI. Studio owns preview, apply, verify, and restore as explicit user actions.
---

# DreamSkin CLI

Use the installed `dreamskin` command instead of editing generated CSS, target
application files, runtime state, or CDP settings directly. Every command emits
one JSON v1 envelope on stdout. Treat a nonzero exit code or `ok: false` as a
failed operation.

## Workflow

1. Run `dreamskin targets` and choose an explicit `pluginId`.
2. Run `dreamskin theme inspect --plugin <pluginId>` before changing anything. Read the theme schema, semantic component registry, available catalog sources, and repository summary.
3. Run `dreamskin theme read <themeId> --plugin <pluginId>`. Preserve the returned revision for optimistic concurrency.
4. Express changes only through documented theme fields: content, semantic colors, interaction states, structured visual recipes, and appearance.
5. Dry-run an update with `dreamskin theme update <themeId> --plugin <pluginId> --expected-revision <revision> --input @change.json --dry-run`.
6. Repeat the update without `--dry-run`, then run `dreamskin theme validate <themeId> --plugin <pluginId>`.
7. Summarize the visible change. The user previews, applies, verifies, restores, or rolls back through Studio.

Use `--input -` for JSON on stdin, `--input @file.json` for a JSON file, or
`--input '{...}'` for a literal object. Theme creation uses `theme create` with
an explicit id, plugin, input, and optional catalog `--source`.

When the user requests a generated or replacement background, create or select a
PNG, JPEG, or WebP file, then dry-run and commit `dreamskin theme asset import`
with the revision returned by the latest read. Read the theme again after import
because the asset commit creates a new revision.

## Guardrails

- Always pass the plugin id returned by `dreamskin targets`; never infer or reuse another target's scope.
- Never write raw CSS, DOM selectors, JavaScript, target application files, or runtime state.
- Never request general-purpose local file reads. The sole file exception is a user-requested background passed explicitly to `theme asset import`; it is validated and copied into the managed library.
- Never bypass a revision conflict. Read the theme again and reconcile the intended change.
- Treat a missing semantic component as a registry/runtime enhancement, not permission to inject an ad hoc selector.
- Never run preview, apply, verify, restore, delete, or rollback through the shell. Studio owns those actions.
- Do not parse human log text. Consume only the versioned JSON envelope written to stdout.

Read [references/tool-api.md](references/tool-api.md) for the command contract,
transaction behavior, theme fields, and error codes.
