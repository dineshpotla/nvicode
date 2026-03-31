# NviCode - Introducing one click Nvidia/OpenRouter keys to Claude Code. Free Claude code.

Run Claude Code through NVIDIA-hosted models or OpenRouter using a simple CLI wrapper.
Use top open-source model APIs on NVIDIA Build for free, with `nvicode` paced to `40 RPM` by default.

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

Set up provider, key, and model:

```sh
nvicode select model
```

The setup flow asks for provider, API key, and model:

- NVIDIA: get a free key from [NVIDIA Build API Keys](https://build.nvidia.com/settings/api-keys)
- OpenRouter: use your OpenRouter API key

Launch Claude Code through your selected provider:

```sh
nvicode launch claude
```

The first successful `nvicode launch claude` also installs persistent plain-`claude` routing.
After that, restarting your terminal or PC and running:

```sh
claude
```

will continue using your selected `nvicode` provider and model.

## Screenshots

### Save your API key

![nvicode auth](https://raw.githubusercontent.com/dineshpotla/nvicode/main/assets/screenshots/auth.png)

### Choose a model

![nvicode select model](https://raw.githubusercontent.com/dineshpotla/nvicode/main/assets/screenshots/select-model.png)

### Launch Claude Code through your selected provider

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

Provider behavior:
- NVIDIA: starts a local proxy on `127.0.0.1:8788`, points Claude Code at it with `ANTHROPIC_BASE_URL`, and forwards requests to NVIDIA `chat/completions`.
- OpenRouter: points Claude Code directly at `https://openrouter.ai/api` using OpenRouter credentials and Anthropic-compatible model ids.

In an interactive terminal, `nvicode usage` refreshes live every 2 seconds. When piped or redirected, it prints a single snapshot.

`nvicode select model` now asks for provider, optional API key update, and model choice in one guided flow.
If no API key is saved for the active provider yet, `nvicode` prompts for one on first use.
By default, the proxy paces upstream NVIDIA requests at `40 RPM`. Override that with `NVICODE_MAX_RPM` if your account has a different limit.
The usage dashboard compares your local NVIDIA run cost against Claude Opus 4.6 at `$5 / MTok input` and `$25 / MTok output`, based on Anthropic pricing as of `2026-03-30`.
If your NVIDIA endpoint is not free, override local cost estimates with `NVICODE_INPUT_USD_PER_MTOK` and `NVICODE_OUTPUT_USD_PER_MTOK`.
Local `usage`, `activity`, and `dashboard` commands are available for NVIDIA proxy sessions. OpenRouter sessions use OpenRouter's direct connection path instead.

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
- Claude Code remains the frontend; the selected provider/model becomes the backend.
