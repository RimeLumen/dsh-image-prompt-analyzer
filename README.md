# dsh-image-prompt-analyzer

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.5-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-00add8?logo=npm)](https://www.npmjs.com)
[![License](https://img.shields.io/badge/license-Apache_2.0-blue)](LICENSE)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that converts a local image into model-specific prompts for ComfyUI.

It takes an image, runs it through a vision model to produce a structured Intermediate Representation (IR), then compiles that IR into positive and negative prompts following the **official tag standards** of your target model — slot order, quality blocks, scoring chains, forbidden tags, and word styling.

## Why not one generic prompt?

Pony's `score_9` chain, NoobAI's underscore prohibition, Illustrious's `very aesthetic`, Animagine's `high score` — these four standards conflict with each other. A single generic tag string that works for one model is pure noise for another. This plugin compiles per-model, per-standard.

## Supported Models

| Model | Profile ID | Key Standard |
|---|---|---|
| Pony Diffusion V6 XL | `pony-v6` | score_9 chain, source_anime, rating system |
| NoobAI XL | `noobai-xl` | underscored tags, no quality prefix, Danbooru slot order |
| Illustrious XL | `illustrious` | `masterpiece, best quality, very aesthetic, absurdres` |
| Animagine XL 4.0 | `animagine-xl-4.0` | `$dscore <8>` prefix, `high score` quality block |

## Features

- **4 model profiles** — each a JSON config declaring slot order, fixed blocks, forbidden tags, negative defaults, word styling
- **7-type image classification** — general / photography / landscape / poster-typography / IP-character / 3D-render / illustration
- **Interactive workbench** — sidebar UI with upload, URL fetch, model/profile selection, real-time thinking stream
- **Local knowledge base** — pure SQLite, CSV import, zero network
- **Experience store** — per-profile history, ratings, export/import
- **Vision model auto-discovery** — finds image-capable models from the host directory, auto-fallback on failure
- **Auto-preload** — key resources warm up in background after DSH starts

## Install

```bash
dsh plugin install ./dsh-image-prompt-analyzer
```

## Quick Start

Ask the model in conversation:

```
Analyze this image with the illustrious profile:
  image_path: "D:/pics/sample.png"
  target_profile: "illustrious"
```

Or open the workbench from the left sidebar → upload image → select profile → analyze.

## Structure

```
├── dsh-image-prompt-analyzer/       # Plugin package
│   ├── index.js                     # Host entry (tool registration + preload)
│   ├── client.js                    # Browser workbench UI
│   ├── configs/
│   │   ├── model-profiles/          # 4 model profiles
│   │   ├── image-types/             # 7-type classification rules
│   │   └── presets/                 # 3 detail levels
│   ├── lib/
│   │   ├── vision/                  # Vision pipeline (2-stage analysis)
│   │   ├── compile/                 # Prompt compiler (7 phases)
│   │   ├── rules/                   # Image type classification engine
│   │   ├── kb/                      # Tag knowledge base (SQLite)
│   │   ├── experience/              # Experience store
│   │   └── panel/                   # HTTP routes + workbench
│   ├── locale/                      # zh / en
│   └── python/                      # Image decode helper
├── docs/
│   ├── PANEL_API.md                 # HTTP API spec
│   └── panel-api.openapi.yaml       # OpenAPI definition
└── README.md
```

## Tech

| | |
|---|---|
| Runtime dependencies | **0** |
| Build step | None (pure ESM) |
| Node.js | ≥ 22.5 (`node:sqlite`) |
| Typing | JSDoc |
| Network | Only user-provided image URL downloads |
| Data | Local SQLite, no image uploads to external services |

## License

Apache-2.0
