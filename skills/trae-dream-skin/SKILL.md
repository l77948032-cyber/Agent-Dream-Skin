---
name: trae-dream-skin
description: Use when an agent needs to inspect, create, edit, validate, preview, apply, verify, or remove a Trae desktop skin through the Trae-Dream-Skin MCP tools or JSON CLI. This skill covers structured theme work and reversible local Trae skin operations on macOS and Windows.
---

# Trae-Dream-Skin

Use the shared Agent Tool rather than editing Trae, generated CSS, runtime state, or CDP settings directly. Prefer MCP tools. Use the JSON CLI only when MCP is unavailable or while debugging the tool itself.

## Workflow

1. Call `inspect` before changing anything. Read runtime status, the semantic component registry, theme schema, and available revisions.
2. Call `theme_read` for the source or target theme. Keep its `revision` for optimistic concurrency.
3. Express changes only through documented theme fields: content, semantic colors, interaction `states`, and `appearance`.
4. Call `theme_write` with `dryRun: true` and `expectedRevision` before committing.
5. Commit with `theme_write`, then call `theme_validate` for the written theme.
6. Call `preview`. It applies, verifies, optionally captures a screenshot, and restores the previous theme or native state automatically.
7. Call `apply` only after preview passes. Finish with `verify`.
8. Call `restore` when the user wants the skin off. It is idempotent.

If a committed theme edit is wrong, call `theme_write` with `operation: "rollback"` and the returned `transactionId`.

## Guardrails

- Never write raw CSS, DOM selectors, JavaScript, Trae application files, or runtime state through this skill.
- Never connect CDP to a non-loopback host or reuse an endpoint the runtime has not verified as the owned Trae session.
- Do not bypass a revision conflict. Read the theme again and reconcile the intended change.
- Treat a missing semantic component as a registry/runtime enhancement, not permission to inject an ad hoc selector.
- On preview or verification failure, leave the user on the restored prior state and report the structured error.

Read [references/tool-api.md](references/tool-api.md) for inputs, CLI equivalents, transaction behavior, and error codes.
