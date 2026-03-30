# nvicode

Run Claude Code through NVIDIA-hosted models using a local Anthropic-compatible gateway.

Supported environments:
- macOS
- Ubuntu/Linux
- WSL
- Native Windows with Claude Code installed and working from PowerShell, CMD, or Git Bash

## Quickstart

Install the published package:

```sh
npm install -g nvicode
```

Save your NVIDIA API key:

Get a free key from [NVIDIA Build API Keys](https://build.nvidia.com/settings/api-keys).

```sh
nvicode auth
```

Choose a model:

```sh
nvicode select model
```

Launch Claude Code through NVIDIA:

```sh
nvicode launch claude
```

## Screenshots

### Save your API key

![nvicode auth](https://raw.githubusercontent.com/dineshpotla/nvicode/main/assets/screenshots/auth.png)

### Choose a model

![nvicode select model](https://raw.githubusercontent.com/dineshpotla/nvicode/main/assets/screenshots/select-model.png)

### Launch Claude Code through NVIDIA

![nvicode launch claude](https://raw.githubusercontent.com/dineshpotla/nvicode/main/assets/screenshots/launch.png)

## Commands

Useful commands:

```sh
nvicode dashboard
nvicode usage
nvicode activity
nvicode models
nvicode config
nvicode auth
nvicode launch claude -p "Reply with exactly OK"
```

The launcher starts a local proxy on `127.0.0.1:8788`, points Claude Code at it with `ANTHROPIC_BASE_URL`, and forwards requests to NVIDIA `chat/completions`.

If no NVIDIA API key is saved yet, `nvicode` prompts for one on first use.
By default, the proxy paces upstream NVIDIA requests at `40 RPM`. Override that with `NVICODE_MAX_RPM` if your account has a different limit.
The usage dashboard compares your local NVIDIA run cost against Claude Opus 4.6 at `$5 / MTok input` and `$25 / MTok output`, based on Anthropic pricing as of `2026-03-30`.
If your NVIDIA endpoint is not free, override local cost estimates with `NVICODE_INPUT_USD_PER_MTOK` and `NVICODE_OUTPUT_USD_PER_MTOK`.

## Requirements

- Claude Code must already be installed on the machine.
- Node.js 20 or newer is required to install `nvicode`.
- On native Windows, Claude Code itself requires Git for Windows. See the [Claude Code setup docs](https://code.claude.com/docs/en/setup).

## Local Development

These steps are only for contributors working from a git checkout. End users do not need them.

```sh
npm install
npm run build
npm link
```

## Notes

- `thinking` is disabled by default because some NVIDIA reasoning models can consume the entire output budget and return no visible answer to Claude Code.
- The proxy supports basic text, tool calls, tool results, and token count estimation.
- The proxy includes upstream request pacing and retries on NVIDIA `429` responses.
- Claude Code remains the frontend; the selected NVIDIA model becomes the backend.
