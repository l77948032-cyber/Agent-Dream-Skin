---
name: trae-dream-skin
description: Use when an agent needs to inspect, create, edit, or validate a Trae theme through DreamSkin Tool. Studio owns preview, apply, verify, and restore as explicit user actions.
---

# Trae-Dream-Skin

Use the single `dreamskin_theme` Tool rather than editing Trae, generated CSS,
runtime state, or CDP settings directly. MCP may be used internally as a
compatibility transport, but it is not part of this workflow.

## Workflow

1. Call `dreamskin_theme` with `action: "inspect"` before changing anything. Read the semantic component registry, each component's `visualSlots`, the theme schema, and available revisions.
2. Call it with `action: "read"` and `themeId` for the selected theme. Keep its `revision` for optimistic concurrency.
3. Express changes only through documented theme fields: content, semantic colors, interaction `states`, structured `visual` recipes, and `appearance`.
4. Call it with `action: "update"`, `themeId`, `themePatch`, `dryRun: true`, and `expectedRevision` before committing.
5. Commit with `action: "update"`, then call `action: "validate"` for the written theme.
6. Summarize the visible change. Studio handles preview, apply, restore, and version rollback outside the Agent Tool.

## Guardrails

- Never write raw CSS, DOM selectors, JavaScript, Trae application files, or runtime state through this skill.
- Never connect CDP to a non-loopback host or reuse an endpoint the runtime has not verified as the owned Trae session.
- Do not bypass a revision conflict. Read the theme again and reconcile the intended change.
- Treat a missing semantic component as a registry/runtime enhancement, not permission to inject an ad hoc selector.
- Never attempt runtime actions through another tool or the shell; Studio owns those actions.

Read [references/tool-api.md](references/tool-api.md) for inputs, CLI equivalents, transaction behavior, and error codes.
