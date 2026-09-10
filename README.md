# ScreenForge

A macOS screen recorder that produces finished, presentable video, not raw footage you still have to edit.

Records your screen, then automatically adds the things that make a recording watchable: camera moves that follow what you're doing, smoothed cursor motion, keystroke overlays, and privacy blur over anything you don't want on tape. Exports to MP4, WebM, or GIF.

<!-- TODO: add a demo GIF here. This is the single highest-impact thing on the page.
     Record ~10 seconds showing: drag out a capture area, click around so the auto-zoom
     fires, then drop a circular blur over something. Save as docs/demo.gif and use:
     ![ScreenForge](docs/demo.gif) -->

---

## The problem

Screen recordings are boring to watch. The interesting thing is a 200-pixel corner of a 5K display, the cursor jitters, and nobody can tell which keyboard shortcut you just used. Fixing that by hand in a video editor takes longer than the recording did.

ScreenForge does that pass automatically, then lets you correct it.

## What it does

**Capture**
- Full display, a single application window, or a drag-selected region
- Webcam overlay, microphone, and system audio
- Multi-display aware

**Automatic post-production**
- **Camera direction** - analyses your cursor path and clicks, then generates zoom moves that follow the work. Three intensity profiles (calm, tutorial, energetic). Every generated move is editable or deletable.
- **Click and cursor effects** - click rings, cursor smoothing, and a synthetic cursor that stays sharp when zoomed
- **Keystroke overlay** - renders shortcuts on screen as key-cap badges, so viewers can see what you pressed
- **Silence removal** - cuts dead air automatically
- **Captions** with timing controls

**Privacy blur**
- Draw a rectangle, square, or circle over anything sensitive
- Per-zone start and end times, so a blur only covers something while it's actually on screen
- Sized for real targets: a zone can be as small as ~15x9px at 1080p, tight enough to sit on a single account number
- Circles are true circles, masked into the alpha channel at export rather than faked with a rounded rectangle

**Export**
- MP4, WebM, GIF
- Backgrounds, padding, rounded corners, shadows
- Speed control, trim, and cuts

## Architecture

Electron, with a deliberately hard boundary between the two processes.

```
main.js            Electron main process. Capture sources, window management,
                   FFmpeg lifecycle, global input hook, IPC gatekeeping.
preload.js         The only bridge. contextIsolation on, nodeIntegration off.
renderer/
  app.js           Editor UI and timeline state
  creator-engine.js   Camera direction, time mapping, cursor path splitting
  cursor-engine.js    Cursor smoothing and synthesis
  presentation-engine.js  Background, padding, framing geometry
export-engine.js   Builds the FFmpeg filtergraph and validates it
test/              117 tests, including real-FFmpeg integration tests
```

**Process isolation.** All three windows run `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`. The renderer has no Node access.

**IPC is role-gated.** Every channel is registered through one wrapper that checks the sender's identity against the page that's allowed to use it, so a compromised renderer can't call a channel belonging to a different window. A test asserts that exactly one `ipcMain.handle` call exists in the codebase, which keeps the wrapper from being bypassed later.

**Export is a filtergraph, not a render loop.** Effects compile into a single FFmpeg graph. Camera moves, blur zones, captions, and cursor overlays are all composed as filters, so export is one pass and the preview and output agree.

**Untrusted input is clamped at the boundary.** Project files are user-editable JSON that ends up in an FFmpeg command, so every value is range-clamped and every shape name is allowlisted before it reaches the graph.

## Engineering notes

A few problems worth describing, because the fix was more interesting than the bug.

**Camera moves were being silently deleted.** Export supports a bounded number of camera segments. The budget check enforced that by *deleting* zoom keyframes from state. A zoom's cost is the number of export segments it spans, which depends on where the cuts are, so trimming one part of the timeline could retroactively destroy zooms somewhere else. Same project, different result, no undo, and one call site did it without any message.

The fix was to make the budget non-destructive: compute active and over-budget sets, mark rather than delete, and filter only at render and export. Over-budget moves become active again on their own when the user frees up budget. There's a test that adds 50 zooms, cuts the timeline until 10 go inactive, removes the cuts, and asserts all 50 come back.

**The global input hook ran for the app's entire lifetime.** The keystroke overlay uses a system-wide input hook. It was started during window creation rather than on record, which meant that simply having the app open captured every keystroke on the machine, including passwords typed into other applications. It's now gated to run only between recording start and stop, with the listeners additionally guarded on a runtime flag so a stop that races an in-flight event can't leak a keystroke.

**Circular blur needed an alpha mask.** Cropping a region gives you a rectangle. To get a real circle, the blurred crop is converted to `yuva420p` and an ellipse is written into the alpha channel with `geq`, then composited back with `overlay`. Square and circle zones are constrained to equal *pixels* rather than equal percent, because width and height are fractions of different dimensions and an equal-percent box renders visibly oblong on a 16:9 frame.

The first version of that filtergraph looked correct and exited 0, but the output was a squashed oval because the test region wasn't square. Exit codes aren't verification for anything visual. That check is now a test that runs the real bundled FFmpeg and asserts the graph is accepted.

## Tests

```bash
npm test
```

117 tests. Most are fast unit and contract tests, but several spawn the real bundled FFmpeg and assert that generated filtergraphs actually parse and encode, which is the only way to catch a filtergraph that is syntactically plausible and wrong.

## Running it

Requires macOS on Apple Silicon. The app bundles its own runtime via Electron; you need Node locally only for the build tooling.

```bash
npm install
npm start
```

Build a distributable:

```bash
npm run dist
```

On first run macOS will ask for Screen Recording permission, and for Accessibility if you use the keystroke overlay.

## Distribution

ScreenForge ships as a signed, notarized DMG rather than through the Mac App Store. That's a deliberate constraint, not an omission: the keystroke overlay needs a system-wide input hook and export needs to execute a bundled FFmpeg binary, and neither is permitted under App Store sandboxing. Most professional screen recorders distribute the same way for the same reason.

## Stack

Electron 43 · FFmpeg (bundled via `ffmpeg-static`) · `uiohook-napi` for global input · `sharp` for image processing · Tailwind · `electron-store` · `electron-log`

## Status

Actively developed. Current focus is motion blur on fast camera moves and per-segment speed ramping.
