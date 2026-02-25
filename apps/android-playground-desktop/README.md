# Midscene Android Playground — Desktop

An [Electron](https://www.electronjs.org/) desktop application that wraps the
**Midscene Android Playground** so that end users can run it with a single
double-click — **no Node.js installation required**.

## Prerequisites

| Requirement | Notes |
|---|---|
| **ADB** (`adb`) on `PATH` | Install via [Android SDK Platform Tools](https://developer.android.com/tools/releases/platform-tools). The app itself does **not** bundle ADB. |
| Android device | USB debugging enabled and device authorised |

> The `scrcpy-server` binary is bundled inside the app and does **not** need
> to be installed separately.

## Development

```bash
# From the repo root – build workspace packages first
pnpm run build

# Then work on this app
cd apps/android-playground-desktop

# Install deps (first time)
pnpm install

# Build the Electron main process
pnpm run build

# Launch in development mode
pnpm run start
```

## Packaging

```bash
# macOS  → release/*.dmg
pnpm run dist:mac

# Windows → release/*-Setup.exe
pnpm run dist:win

# Linux   → release/*.AppImage
pnpm run dist:linux

# All platforms
pnpm run dist
```

Packaged artefacts are written to the `release/` directory.

## How it works

1. On launch, the app detects connected Android devices via ADB.
2. If multiple devices are found the user is prompted to pick one.
3. The **PlaygroundServer** (Express/REST) and **ScrcpyServer**
   (Socket.IO + scrcpy video stream) start on localhost.
4. A `BrowserWindow` opens pointing at the playground URL so the whole
   experience feels like a native app.
