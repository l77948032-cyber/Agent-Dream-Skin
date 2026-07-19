# Notices

Trae Dream Skin is an unofficial customization project. It is not affiliated
with, endorsed by, or sponsored by ByteDance, TRAE, or the Codex Dream Skin
project.

## Open-source basis

This project borrows the external Chromium DevTools Protocol theming approach
and includes an abstract demo asset from
[`Fei-Away/Codex-Dream-Skin`](https://github.com/Fei-Away/Codex-Dream-Skin),
which is distributed under the MIT License:

> Copyright (c) 2026 Codex Dream Skin Studio contributors

The source project's MIT license and copyright notice are retained here. The
MIT License in `LICENSE` applies to this project's software source code, the
copied abstract demo artwork under the terms stated by the source project, and
the project-created theme artwork listed below.

## Theme artwork inventory

The following files are byte-identical copies of the source project's
`macos/assets/portal-hero.png`. The source project describes that file as
original abstract geometric art generated for its open-source repository:

- Files:
  - `themes/ember-glass/background.png`
  - `themes/neon-portal/background.png`
  - `themes/paper-aurora/background.png`
- SHA-256: `31bde93bb02d6723e0b6aa0ead675577604120acb0a6799163dd37f5cdd0a08e`
- Dimensions: `2168 x 725` RGB PNG

The following original fictional-character artwork was generated specifically
for Trae Dream Skin during this project's development. It is not copied from
Codex Dream Skin, and no source-repository gallery or identity-reference image
is bundled in these themes:

- Files:
  - `themes/sunlit-spark/background.png`
  - `themes/spark-atelier/background.png` (byte-identical experimental variant)
- SHA-256: `9665cceac6e9bfab9b637e7f11b2bccbbe3ef85d9fdf12bac7a0f6bf6848b0be`
- Dimensions: `1672 x 941` RGB PNG

- File: `themes/violet-rift/background.png`
- SHA-256: `66dfc0f2863b929fc1ee6da183af4823c74eb272f00c77122793823b7bbea7d7`
- Dimensions: `1672 x 941` RGB PNG

The generated scenes depict fictional characters and are not represented as
the likeness of an identified person or as artwork from a named franchise.
This provenance record is not a substitute for an independent rights review.
Each preset may apply its own color, opacity, position, and overlay through
CSS; the checksums above identify the original bundled bitmap files.

Users are responsible for having permission to use images they add to custom
themes.

## Product boundaries

Neither license grants rights to TRAE or ByteDance trademarks, product names,
logos, trade dress, application binaries, or bundled application resources.
This project does not modify or redistribute the TRAE application.

## Security model

The skin runtime connects through Chromium DevTools Protocol on loopback only.
While a themed session is active, treat its local debugging port as sensitive
and do not run untrusted local software. Use the project's stop/restore command
to terminate the injector and relaunch TRAE without the debugging endpoint.
