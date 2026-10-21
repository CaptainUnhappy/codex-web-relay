# Codex Mini macOS App

This folder contains the SwiftUI wrapper app for the local Codex Mini service.

The app embeds:

- the Node.js runtime
- the local Codex Mini service payload
- a small control panel for starting/stopping the local LaunchAgent

Build from the repository root:

```bash
./scripts/build-codex-mini-app.sh
```

The default output is:

```text
/Applications/Codex Mini.app
```

You can override identifiers and paths with environment variables, for example:

```bash
BUNDLE_ID=local.codex-mini.app \
SERVICE_LABEL=codex-mini.local \
APP_PATH="$PWD/dist/Codex Mini.app" \
./scripts/build-codex-mini-app.sh
```
