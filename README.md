# dsh-image-prompt-analyzer

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.5-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Python](https://img.shields.io/badge/Python-3%20%2B%20Pillow-3776ab?logo=python&logoColor=white)](https://python.org)
[![npm dependencies](https://img.shields.io/badge/npm%20dependencies-0-00add8?logo=npm)](https://www.npmjs.com)
[![License](https://img.shields.io/badge/license-Apache_2.0-blue)](LICENSE)

A [[DSH]](https://github.com/deepseek-ai/deepseek-harness) plugin that converts a local image into model-specific prompts for ComfyUI.

It takes an image, runs it through a vision model to produce a structured Intermediate Representation (IR), then compiles that IR into positive and negative prompts following the **official tag standards** of your target model — slot order, quality blocks, scoring chains, forbidden tags, and word styling.

---

## Prerequisites

Two runtimes are needed. **Both are required** — the plugin does not start analysing images without them.

| | Requirement | Why |
|---|---|---|
| **Node.js** | **≥ 22.5** | `node:sqlite` is built in and used for the local knowledge base. There is no npm dependency to install — no `npm install` step at all. |
| **Python** | **3 with [Pillow](https://python-pillow.org/)** (verified on 3.10.6 + Pillow 12.1.1) | Image decoding. Every PNG / JPEG / WEBP / BMP goes through `python/decode_helper.py`, which uses Pillow. Without Pillow, **every image fails with `DECODE_FAILED`** — the plugin is unusable. |
| **numpy** *(optional)* | any recent version | Extra geometric metrics (subject-region luminance, contrast profiles). Missing numpy degrades those metrics to `null`; analysis still runs. |
| **rawpy** *(optional)* | any recent version | RAW camera formats (`.cr2`, `.nef`, `.dng`, …). Off by default (`image.raw_enabled: false`). |

Install the required Python side:

```bash
pip install Pillow
```

Then verify — this is the fastest way to tell whether the Python side is wired up correctly. Run it from inside the plugin package:

```bash
echo '{"op":"probe"}' | python python/decode_helper.py
```

```json
{
  "ok": true,
  "python": { "version": "3.10.6", "executable": "…/python.exe", "platform": "win32" },
  "pillow": { "available": true, "version": "12.1.1" },
  "rawpy": { "available": false, "version": null },
  "bitmap_formats": ["PNG", "JPEG", "WEBP", "BMP"],
  "raw_extensions": [".cr2", ".nef", ".dng", "…"],
  "warnings": []
}
```

If `pillow.available` is `false`, fix that before anything else. If `python` is not on `PATH`, or you need a specific interpreter, point the plugin at it in the plugin config:

```yaml
python:
  executable: "C:/Python311/python.exe"
  timeout_seconds: 30
  enabled: true
```

---

## Install

From a local checkout:

```bash
dsh plugin install ./dsh-image-prompt-analyzer
```

Or point the profile at the package directly (`link:` works for development):

```yaml
plugins:
  - include:@RimeLumen/dsh-image-prompt-analyzer
```

---

## Quick Start

Ask the model in conversation:

```
Analyze this image with the illustrious profile:
  image_path: "D:/pics/sample.png"
  target_profile: "illustrious"
```

Or open the workbench from the left sidebar → upload image (or paste a URL) → select profile → analyze.

`target_profile` has no default — omitting it returns `MODEL_PROFILE_NOT_SELECTED`. Pick one of the two shipped profiles.

---

## Tools

| Tool | What it does |
|---|---|
| `analyze_image_prompt` | The main entry. Image → IR → prompts. Returns the tag version, the description version, the negative prompt, slot breakdown and per-observation diagnostics. |
| `preview_model_profile` | Compiles a sample IR through a profile **without** calling any vision model — shows what a profile actually produces before you spend a call. |
| `validate_configs` | Static validation of the shipped and user-overridden configs: JSON syntax, schema version, required fields, duplicate IDs, dangling references. |
| `diagnose_knowledge_base` | Whether the SQLite knowledge base opens, is writable, what schema version it is, how many tags it holds, when it was last imported. |
| `rebuild_knowledge_base` | Re-imports the local tag CSVs into SQLite. Idempotent upsert per source, transactional, `dry_run` supported. |
| `manage_experiences` | Browse / search / rate / export / import the local experience store. |

---

## Why not one generic prompt?

Illustrious's `very aesthetic` block and Animagine's `$dscore` chain are not interchangeable, and Animagine's Model Card is explicit that tag-based prompts are what it reads best. A single generic tag string that works for one model is pure noise for another. This plugin compiles per-model, per-standard.

## Colour mode comes first

Before the vision model is asked anything, the pixel stats decide what kind of image this is: `greyscale`, `duotone`, `spot_color` or `color` (`lib/vision/preflight.js`). The verdict goes into the prompt as step 0 and into `ir.provenance.color_mode`, so the compiler knows whether to suppress hue words at all.

Without that step the model answers from genre priors — a monochrome portrait of a girl still comes back as `blonde hair, blue eyes`. When the two disagree, the pixel verdict wins and the mismatch is reported as `VISION_COLOR_MODE_MISMATCH`.

`color_mode` overrides that verdict for the *output*, without touching the pixel facts:

| value | what it does |
| --- | --- |
| `auto` (default) | pixel preflight decides — hueless source gets a monochrome prompt, colour source gets a colour prompt |
| `monochrome` | force a black-and-white prompt; hue observations are dropped even when the source is in colour |
| `color` | force a colour prompt; `greyscale` / `monochrome` / `black and white` observations are stripped so they stop pinning the renderer back to grey |

Forcing `color` on a hueless source is honest about what it can do: the pixel mode stays visible as `pixel_mode`, and `VISION_COLOR_MODE_FORCED` warns that the colours have no evidence behind them (a greyscale file does not store hue — the generator fills them from its own priors).

## Tag first, then prompt language

The analysis layer only ever produces tags; the wording layer decides how those tags become a prompt:

1. **Analyze** — the vision model fills the IR with observations, relations included (`holding umbrella`, `wearing black coat` as entities + relation).
2. **Compose relations into tags** — relations are turned into booru-legal compound tags (`holding_umbrella`), never into invented words. Multi-word objects are left alone rather than welded into tags that do not exist.
3. **Render two versions side by side** — every analysis returns both:
   - `prompts.positive` — **tags only** (`1girl, long hair, left_hand_on_own_chest, masterpiece, best quality`). Only vocabulary the knowledge base can confirm as a real tag goes here; anything else would dilute the weight of the tags that do exist.
   - `prompts.description` — **the same observations as sentences** (`1girl, standing with left hand on own chest, wearing sheer translucent chiffon, lit by blown out white glow behind subject`). This is where actions, media (fog, haze, dust), and relations live, because a tag cannot express them.

Which one you feed a model is your call, not the profile's: tag models take the tag line, sentence models take the description, and for img2img the description is the better starting point. `tag_standard.word_style` only shifts the default: `prose` puts the description into `positive`, `underscored` / `spaced` / `hybrid` keep the tag line there (confined to the tag line, which is why the two never blend).

Tag-vs-description routing is driven by the knowledge base: a short observation that resolves to a real tag stays in the tag line, one that does not resolve is dropped from the tag line and kept in the description with reason `not_in_vocabulary`. When the knowledge base is unavailable, nothing is dropped — the tag line stays long rather than losing observations it could not verify.

Sentences are grounded: content words must come from the observations, and a violation is surfaced as `COMPOSE_UNGROUNDED_PROSE` instead of silently shipped.

Animagine XL 4.0 deliberately stays on the tag path — its Model Card limits it to tag-based prompts and notes natural language may not be effective. Switching a profile to prose is one field:

```json
{ "tag_standard": { "word_style": "prose" } }
```

## Adult content

The analyzer does not censor itself. Nude and explicit material is described with the same Danbooru anatomical vocabulary the target models were trained on (`nude`, `nipples`, `spread legs`, `sex`, …); euphemisms and omissions are what actually break reconstruction, because the tagger never sees the concept it must reproduce.

Rating follows the picture, not the profile:

- Nothing is emitted for all-ages images. `safe` is not written — it occupies a high-weight slot at the front and changes nothing.
- `nsfw` / `explicit` is written only when the observation itself reports it.
- `tag_standard.rating_emit` is the allow-list (default `["nsfw", "explicit"]`, `[]` disables ratings entirely); `rating_default` is `null` unless a profile wants a fixed rating.

A rating that the allow-list blocks is dropped with reason `rating_suppressed` and does not count against the fidelity score — that is a policy choice, not a lost observation.

## Supported Models

| Model | Profile ID | Key Standard |
|---|---|---|
| Illustrious XL | `illustrious` | `masterpiece, best quality, very aesthetic, absurdres`, tag register |
| Animagine XL 4.0 | `animagine-xl-4.0` | tag-only prompts, `high score` quality block |

Adding a model is one JSON file in `configs/model-profiles/` — no code change.

## Features

- **2 model profiles** — each a JSON config declaring slot order, fixed blocks, forbidden tags, negative defaults, word styling
- **Dual output** — a tag version and a description version, compiled from the same observations
- **Evidence layer** — observations are cross-checked against pixel measurements before they reach the prompt; contradictions are reported, not silently resolved
- **Stage tracing** — every analysis can be replayed: pre/post-evidence IR, raw model responses, and a fact ledger that says where each observation ended up
- **Interactive workbench** — sidebar UI with upload, URL fetch, model/profile selection, real-time thinking stream
- **Local knowledge base** — pure SQLite, CSV import, zero network
- **Experience store** — per-profile history, ratings, export/import
- **Vision model auto-discovery** — finds image-capable models from the host directory, auto-fallback on failure
- **Auto-preload** — key resources warm up in background after DSH starts

## Knowledge base data

The two tag CSVs are **shipped with the repository**:

| File | Rows | Size |
|---|---|---|
| `res/illustrious_tags_no_artist.csv` | 58,519 | 1.6 MB |
| `res/anima_tags_no_artist.csv` | 66,058 | 1.7 MB |

They are Danbooru-style exports in `tag,native_category,aliases,post_count` form, with artist rows removed. `configs/knowledge-base.default.json` lists them as `sources[]`; `data/knowledge.sqlite3` is created from them on first use.

After a fresh clone, build the database once:

```
rebuild_knowledge_base
```

or import a single source with the CLI:

```bash
npm run import-tags
```

To use your own tag table instead, point `sources[].path` at any CSV inside the package and re-run the rebuild. Tags missing from the table are not treated as invalid — they just stay in the description version instead of being confirmed as tags.

## Inspecting a compile

`scripts/inspect-prompt.mjs` compiles a saved IR and reports either the four output hashes or where a specific observation ended up. It never calls the vision model and never generates an image, so it is safe to run on a saved IR as often as you like.

```bash
node scripts/inspect-prompt.mjs baseline --ir ir.json
node scripts/inspect-prompt.mjs ledger   --ir ir.json --ir-before ir.pre-evidence.json
node scripts/inspect-prompt.mjs explain  --ir ir.json "camera.angle"
node scripts/inspect-prompt.mjs channels --ir ir.json
```

| Subcommand | Answers |
|---|---|
| `baseline` | Did the output change? Prints the hash and length of the tag version, the default description, the negative line and the candidate description. `--expect positive=<hash>,...` turns "unchanged" into a pass/fail exit code. |
| `ledger` | What is in the fact ledger, and what does the per-channel fidelity audit say? |
| `explain` | Where did one observation go? With no argument it lists everything dropped, rewritten or partially lost. |
| `channels` | Which channel is missing what, grouped by reason — "blocked by a rule" and "lost unexpectedly" are counted separately. |

Options: `--profile <id>` (default `illustrious`), `--preset <id>` (default `detail-standard`), `--db <path>`, `--kb-config <path>`, `--no-kb`, `--json`, `--help`.

Two cautions, both learned the hard way:

- **State the knowledge-base mode whenever you quote a hash.** With no tag table attached the outputs are different strings, so a hash without a `kb` label is not a baseline. `baseline` always prints the mode on its own line.
- **The fidelity `score` is a word-surface retention metric, not a quality score.** `score: 1` only means every audited fact reached at least one channel; read `channels` and `retention_claim` before claiming anything was preserved.

## Structure

```
├── dsh-image-prompt-analyzer/       # Plugin package
│   ├── index.js                     # Host entry (tool registration + preload)
│   ├── client.js                    # Browser workbench UI
│   ├── configs/
│   │   ├── model-profiles/          # 2 model profiles
│   │   ├── presets/                 # 3 detail levels (minimal / standard / high)
│   │   └── knowledge-base.*.json    # KB sources + storage schema
│   ├── lib/
│   │   ├── vision/                  # Vision pipeline (2-stage analysis + evidence layer)
│   │   ├── compile/                 # Prompt compiler (tag + description versions)
│   │   ├── ir/                      # Observation IR (schema, build, merge)
│   │   ├── trace/                   # Stage snapshots + fact ledger
│   │   ├── kb/                      # Tag knowledge base (SQLite)
│   │   ├── experience/              # Experience store
│   │   ├── input/                   # Decode + preprocess
│   │   ├── pipeline/                # Stage orchestration
│   │   ├── tools/                   # MCP tool implementations
│   │   ├── config/                  # Config load + validation
│   │   ├── model-profile/           # Profile schema + defaults
│   │   ├── runtime/                 # Lazy singletons (KB, config store)
│   │   └── panel/                   # HTTP routes + workbench
│   ├── locale/                      # zh / en
│   ├── python/                      # Image decode helper (Pillow)
│   ├── res/                         # Tag CSVs (knowledge base sources)
│   └── scripts/                     # CLI helpers (tag import, experience export, compile inspection)
├── docs/
│   ├── PANEL_API.md                 # HTTP API spec
│   └── panel-api.openapi.yaml       # OpenAPI definition
└── README.md
```

## Tech

| | |
|---|---|
| npm runtime dependencies | **0** — nothing to `npm install`, pure ESM |
| Node.js | **≥ 22.5** (`node:sqlite` is built in) |
| Python | **3 with Pillow** — required for all image decoding |
| Python optional | `numpy` (geometric metrics), `rawpy` (RAW formats) |
| Build step | None |
| Typing | JSDoc |
| Network | Only user-provided image URL downloads; no image is ever uploaded to a third party |
| Data | Local SQLite under `data/`, never committed |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `DECODE_FAILED` / "Pillow 不可用" | Pillow missing from the Python on `PATH` | `pip install Pillow`, then re-run the `probe` command above |
| `PYTHON_UNAVAILABLE` | `python.executable` does not resolve, or `python.enabled: false` | Set `python.executable` to an absolute interpreter path |
| `KB_EMPTY` / tag line is unusually long | Knowledge base not built yet | Run `rebuild_knowledge_base` once |
| `KB_IMPORT_FILE_UNREADABLE` | `sources[].path` points at a file that is not there | Check `configs/knowledge-base.default.json` against `res/` |
| `MODEL_PROFILE_NOT_SELECTED` | `target_profile` omitted | Pass `illustrious` or `animagine-xl-4.0` |

## License

Apache-2.0
