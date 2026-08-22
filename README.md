<div align="center">

# Aelion Studio

**A professional timeline video editor that runs entirely in your browser.**

Nothing uploads. Nothing queues. Your footage never leaves your machine.

**English** · [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](LICENSE)
[![Built on AelionSDK](https://img.shields.io/badge/built%20on-AelionSDK-3d8bfd.svg)](https://github.com/FoyonaCZY/AelionSDK)
[![No install](https://img.shields.io/badge/install-none-8a5528.svg)](#getting-started)
[![Media never uploaded](https://img.shields.io/badge/media-never%20uploaded-5c4480.svg)](#your-footage-never-leaves-the-machine)

</div>

---

Aelion Studio is a complete video editor that lives in a browser tab. Multi-track timeline, on-canvas transforms, captions, audio mixing, retiming, transitions, effects — and **it encodes MP4 locally**. No render server, no upload wait, no export queue.

Once the page has loaded, editing and exporting make **zero network requests**.

<!--
  Screenshots: add three images here before launch and replace this comment.
  1. docs/screenshot-editor.png     full workspace (timeline + monitor + inspector)
  2. docs/screenshot-transform.png  on-canvas transform with snapping guides
  3. docs/screenshot-export.png     export dialog with capability preflight
-->

## Why it's different

### Your footage never leaves the machine

Most browser editors ask you to upload first. A 4 GB source file means half an hour of waiting before you can make a single cut — and trusting someone else with unreleased material.

Aelion Studio doesn't upload. Source files are written to the browser's **OPFS** (origin private file system), project state goes to **IndexedDB**, and decoding, compositing and encoding all happen on your own CPU and GPU. **The application has no backend at all.** What you deploy is a folder of static files.

For anyone handling unreleased footage, client material, or anything under a compliance constraint, that isn't a feature — it's the entry requirement.

### Export finishes on your own GPU

**WebCodecs** drives your system's hardware encoder directly:

| Video | Audio | Image |
| --- | --- | --- |
| MP4 · H.264 / AAC | WAV · PCM | Current frame PNG |
| MP4 · HEVC / AAC | | Current frame JPEG |
| MP4 · AV1 / AAC | | Current frame WebP |
| WebM · VP9 / Opus | | GIF |

Every export begins with a **capability preflight** that asks the browser and GPU whether they can actually do the job. If the answer is no, you find out immediately — not at 90%.

### Frame-exact, and deterministic about it

Underneath is [AelionSDK](https://github.com/FoyonaCZY/AelionSDK), an engine built around exactness: precise seeking, a canonical project document, and transactional edits carrying revision numbers.

What that buys you in practice: a drag is one transaction, so undo really does land on the previous state; and if the playhead sits on frame 137, frame 137 of the export is the frame you were looking at.

---

## Features

### Import

Drop files onto the window, onto a specific track, or pick them from the menu. **Import from URL** works too, for any host that supports HTTP Range.

| | |
| --- | --- |
| **Video** | MP4 · WebM · MOV · MKV · MPEG-TS |
| **Audio** | Tracks demuxed from those containers, plus standalone audio files |
| **Image** | PNG · JPEG · WebP · GIF · BMP · AVIF · SVG |
| **Subtitles** | SRT · WebVTT |

A file carrying both video and audio is split into two linked clips — move one and the other follows. Sources are cached to OPFS at the same time, so reopening a project doesn't ask you to locate files again.

### Timeline

- Multi-track editing with video, caption and audio lanes you can add or remove at will; new projects start with V1–V3 · C1 · A1–A2
- Five tools: **select**, **razor**, **slip**, **slide**, **roll**
- Snapping, linked A/V editing and ripple editing, each toggled independently
- Drag across tracks with automatic collision handling; drop onto an occupied slot and the two clips swap and repack
- Waveforms drawn on audio clips, thumbnail filmstrips on video clips
- Markers, plus per-track mute / solo / lock / hide
- Full undo and redo, with a whole drag collapsed into a single history entry

### Canvas

- **Drag directly in the monitor** to move, scale and rotate — eight handles plus a rotation grip
- Smart snapping to frame center, thirds and edges, and to other layers' bounds and centers, with guides drawn on contact
- `Shift` breaks the aspect lock, `Alt` suspends snapping, rotation snaps every 90°
- Opacity, scale, position, rotation, fit mode (contain / cover / fill / none) and blend mode
- Safe-area overlay and a preview quality selector (adaptive / draft / full)

### Text and captions

- Title and subtitle layers with font, size, weight, italic, colour, stroke, alignment and a **background plate**
- A dedicated caption track, importing and exporting **SRT** and **WebVTT**
- Selection boxes hug the actual glyphs rather than a loose bounding rectangle

### Shapes and generators

Rectangles, ellipses, solid mattes, linear gradients, and **adjustment layers** that apply their effects to everything beneath them.

### Effects and transitions

Eight effects — brightness, contrast, saturation, greyscale, sepia, hue rotation, invert and blur — each with an adjustable amount and a live preview.

Five transitions — cross dissolve, slide from left or right, dip to black, dip to white. Drop one on a cut, drag either edge to change its length.

### Audio

- Gain, pan, fades, and whether retiming preserves pitch
- **Loudness analysis** reporting LUFS and true peak (dBTP)
- **Silence detection** with one-click removal
- **Beat detection** that drops markers automatically, for cutting to music
- **Energy-change detection** for finding a clip's natural segments

### Retiming

Continuous 0.1×–4× speed, reverse, and a two-second **freeze** at the out point.

### Projects

- A project home with search, sorting, and grid or list layout
- Autosave while you edit — close the tab, come back, and both media and progress are still there
- Presets for 1080p 16:9 (30/60 fps), 9:16 vertical, 1:1 square and 4K
- Projects export as a canonical JSON document, suitable for archiving, migration or feeding a pipeline

### Keyboard

| | | | |
| --- | --- | --- | --- |
| `Space` play / pause | `K` / `L` pause / play | `S` split | `M` marker |
| `V` select | `C` razor | `Y` slip | `U` slide |
| `N` roll | `←` `→` step frame (`Shift` ten) | `Home` `End` start / end | `+` `-` zoom |
| `Del` delete | `Ctrl+Z` undo | `Ctrl+Y` redo | `Ctrl+wheel` timeline zoom |

---

## Getting started

Studio is self-contained. It depends on the published `@aelionsdk/*` packages, so it installs and builds anywhere.

```bash
git clone https://github.com/FoyonaCZY/AelionStudio.git
cd AelionStudio
pnpm install
```

### Develop

```bash
pnpm dev
```

Open <http://127.0.0.1:4174/>. The dev server already sends the cross-origin isolation headers.

### Build and deploy

```bash
pnpm build        # static output in dist/
pnpm preview      # serve dist/ locally on :4180
```

The output is plain static files — Vercel, Netlify, Nginx or object storage will all serve it.

**Recommended:** send these two response headers from your host.

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

They enable cross-origin isolation, which lets audio use the low-latency `SharedArrayBuffer` ring buffer. **Studio works without them** — playback falls back to a postMessage path at slightly higher latency.

### Developing against a local SDK checkout

Studio can be cloned into an AelionSDK checkout as `apps/editor-demo` and still installs independently, because it owns its own pnpm workspace boundary. Either way it resolves the published SDK packages.

To test against local SDK changes, build the SDK once and link the four packages Studio imports (paths assume Studio sits at `apps/editor-demo`):

```bash
cd ../..            # AelionSDK root
corepack pnpm install --frozen-lockfile
corepack pnpm run build

cd apps/editor-demo
pnpm link ../../packages/core
pnpm link ../../packages/project-schema
pnpm link ../../packages/sdk
pnpm link ../../packages/export
```

`pnpm install` restores the published packages.

---

## Browser support

Studio needs **WebCodecs**, **WebGL2**, **OPFS** and **AudioWorklet**.

| Browser | Status |
| --- | --- |
| Chrome / Edge (Chromium) | ✅ Primary target |
| Firefox | ⚠️ Edits and previews; export depends on `VideoEncoder` availability |
| Safari / iOS / Android | ❌ Not certified |

The underlying engine is smoke-tested against Chromium and Firefox in CI. Desktop Chrome or Edge is currently the most complete experience.

---

## What it can't do yet

Better stated up front than discovered later:

- **No proxy workflow.** Preview decodes at the source resolution, so 4K material is demanding on modest hardware.
- **Single sequence.** The engine supports nested sequences; the interface doesn't expose them yet.
- **SDR only.** The local colour pipeline is RGBA8. HDR and 10-bit fail loudly rather than rendering wrong.
- **Subtitle formats.** SRT and WebVTT, not ASS/SSA.
- **No collaboration.** Single user, single machine, no cloud sync.
- **The interface is Chinese-only.**
- **No keyframe animation.** Transforms and effects hold one value for the whole clip.

---

## Architecture

Studio is built strictly on the **public entry points** of [`@aelionsdk/sdk`](https://github.com/FoyonaCZY/AelionSDK) and `@aelionsdk/export` — no private APIs, no patches. Everything you see here can be built into your own product with the same interfaces.

```
Aelion Studio  ·  plain TypeScript, no framework
        │
        ├── @aelionsdk/sdk        session, timeline transactions, player, preview
        └── @aelionsdk/export     WebCodecs encoding and muxing
                    │
                    ├── WebGL2 / WebGPU compositor (in a Worker)
                    ├── WebCodecs decode + exact seek
                    └── AudioWorklet clock and mixing
```

The interface layer is framework-free TypeScript: event delegation and targeted repaints. Rendering, decoding and encoding all live in Workers and on the GPU, leaving the main thread to the UI.

---

## License

[MIT](LICENSE) © 2026 FoyonaCZY and Aelion Studio contributors
