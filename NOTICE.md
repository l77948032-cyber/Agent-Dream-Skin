# Notices

Agent Dream Skin is an unofficial customization project. It is not affiliated
with, endorsed by, or sponsored by ByteDance, TRAE, WorkBuddy, OpenAI, or the
Codex Dream Skin project.

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
`macos/assets/portal-hero.png`:

- `themes/ember-glass/background.png`
- `themes/neon-portal/background.png`
- `themes/paper-aurora/background.png`
- `plugins/trae/catalog/neon-portal/background.png`
- SHA-256: `31bde93bb02d6723e0b6aa0ead675577604120acb0a6799163dd37f5cdd0a08e`
- Dimensions: `2168 x 725` RGB PNG

The remaining bundled catalog scenes are original, AI-assisted artwork created
for Agent Dream Skin. They do not use an identified person's likeness or a
named franchise as a reference. Checksums identify the exact source bitmaps
included in this distribution.

| Catalog artwork | SHA-256 | Dimensions |
| --- | --- | --- |
| `plugins/trae/catalog/alpine-signal/background.png` | `9f8ddf43b25e0e96645a9a52c02a9af01e0eaa22a045f69156fd47aaac55abbb` | 1672 x 941 |
| `plugins/trae/catalog/cosmic-arcade/background.png` | `90469fc1527d4212444c269ff89b12e007a884f399166e8226caa9443ea07093` | 1672 x 941 |
| `plugins/trae/catalog/ember-glass/background-v2.png` | `a293a92fd3e9d4740470618f7802367123eeed036fa27135bd891806c234eaac` | 1672 x 941 |
| `plugins/trae/catalog/jade-courtyard/background.png` | `6888a7004cf366f0b4adbc3210dcc2a8c9d48d1e4eb2c7e9de860896fb774bac` | 1672 x 941 |
| `plugins/trae/catalog/midnight-library/background.png` | `9a3767499fd58337fd79bc0e5b330fc411763ef4ebc8a1ccf12fee7cc1d3c934` | 1672 x 941 |
| `plugins/trae/catalog/paper-aurora/background-v2.png` | `02abda05261b18c940d061be7c3527ed7cefa03ef4dbaa0bba0c064882f94f6d` | 1672 x 941 |
| `plugins/trae/catalog/spark-atelier/background-v2.png` | `11d513d75591855b33b67abc6955d87ffeab6ca0235bf968dc8aa11c188117b9` | 1672 x 941 |
| `plugins/trae/catalog/sunlit-spark/background.png` | `9665cceac6e9bfab9b637e7f11b2bccbbe3ef85d9fdf12bac7a0f6bf6848b0be` | 1672 x 941 |
| `plugins/trae/catalog/violet-rift/background.png` | `66dfc0f2863b929fc1ee6da183af4823c74eb272f00c77122793823b7bbea7d7` | 1672 x 941 |
| `plugins/workbuddy/catalog/city-rain/background.png` | `bc45ae96c51c1488808b907745fb8e783b3b224e11dc7646187b8fb6cc4ef12a` | 1672 x 941 |
| `plugins/workbuddy/catalog/coral-studio/background.png` | `957192169685d7e0ca4defff170022c87c9bbbf63e7ed5c7f62e5a220260ce55` | 1672 x 941 |
| `plugins/workbuddy/catalog/desert-dawn/background.png` | `5ba301312add3e41055acfeaa20a343fac82be7b5f521e791c4ff13ccd9b0a75` | 1672 x 941 |
| `plugins/workbuddy/catalog/forest-notes/background.png` | `c82ea7585af5bcc98c6a3307deca671accbb71bcee7da940c6726b924bdb4d50` | 1672 x 941 |
| `plugins/workbuddy/catalog/harbor-focus/background.png` | `ced18279dda4a159a67fb52ff513f34bff8c8110183723e4e71df6494e429ec3` | 1942 x 809 |
| `plugins/workbuddy/catalog/ink-courtyard/background.png` | `07cc9258096f44385cba14a4aca895686ef24621f79d84efbe96869740c9e804` | 1672 x 941 |
| `plugins/workbuddy/catalog/orbit-console/background.png` | `f27031c2a3d643c04969194ce0cf7e2651044e2f8a6be2a134c5445ab0dce1ca` | 1672 x 941 |
| `plugins/workbuddy/catalog/orchid-night/background.png` | `0c524043cf4fcdfb793c9bbce0564e3d1f4129275aeff817adf31bf7bc5dc43f` | 1942 x 809 |
| `plugins/workbuddy/catalog/paper-garden/background.png` | `9cf324c8831d7f526efad37cc8c37c5877a24241877465cefc4be2e55579d920` | 1942 x 809 |
| `plugins/workbuddy/catalog/winter-lodge/background.png` | `9f97d9c49d1d5f600ed8e114570a7497dfe7dae8189f8a3a5cc6f5afab398dfb` | 1672 x 941 |

The root compatibility themes retain two generated bitmaps already represented
above: `themes/sunlit-spark/background.png` and
`themes/spark-atelier/background.png` share the Sunlit Spark checksum, while
`themes/violet-rift/background.png` shares the Violet Rift checksum.

Each preset may apply its own color, opacity, position, material, and overlay
through theme data. Users are responsible for having permission to use images
they add to custom themes.

## Product boundaries

Neither license grants rights to TRAE, WorkBuddy, ByteDance, OpenAI, or other
vendors' trademarks, product names, logos, trade dress, application binaries,
or bundled application resources. This project does not redistribute a target
application.

## Security model

DreamSkin stores themes locally and exposes a scoped CLI for theme documents.
Applying or restoring a theme remains an explicit Studio action. Target runtime
connections use loopback-only local mechanisms; while a themed session is
active, treat its local debugging endpoint as sensitive and do not run
untrusted local software.
