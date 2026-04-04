# NviCode

[![CI](https://github.com/dineshpotla/nvicode/actions/workflows/ci.yml/badge.svg)](https://github.com/dineshpotla/nvicode/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/nvicode)](https://www.npmjs.com/package/nvicode)
[![package](https://img.shields.io/badge/package-nvicode-orange)](https://www.npmjs.com/package/nvicode)
[![node >=20](https://img.shields.io/badge/node-%3E%3D20-339933)](https://nodejs.org/)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Route Claude Code, Codex CLI, and OpenClaw through NVIDIA or OpenRouter with one setup.

`nvicode` lets you choose a provider once, save the API key once, pick a model once, and then launch the coding tool you want against that same backend.

What it gives you:
- One guided setup flow for provider, key, and model
- Claude Code support
- Codex CLI support
- OpenClaw support
- NVIDIA proxy mode with pacing and local usage tracking
- OpenRouter direct mode for compatible models

Supported environments:
- macOS
- Ubuntu/Linux
- WSL
- Native Windows with Claude Code installed and working from PowerShell, CMD, or Git Bash

## Quickstart

Install `nvicode`:

```sh
npm install -g nvicode
```

Choose provider, key, and model:

```sh
nvicode select model
```

Launch the tool you want:

```sh
nvicode launch claude
nvicode launch codex
nvicode launch openclaw
```

Provider setup:

- NVIDIA: get a free key from [NVIDIA Build API Keys](https://build.nvidia.com/settings/api-keys)
- OpenRouter: use your OpenRouter API key

What happens after first launch:
- The first successful `nvicode launch claude` installs persistent plain `claude` routing.
- The first successful `nvicode launch codex` installs persistent plain `codex` routing.
- `nvicode launch openclaw` updates the default OpenClaw profile for the selected provider/model.

After that, plain:

```sh
claude
codex
```

continues using your selected `nvicode` provider and model.

## Screenshots

### Save your API key

![nvicode auth](https://raw.githubusercontent.com/dineshpotla/nvicode/main/assets/screenshots/auth.png)

### Choose a model

![nvicode select model](https://raw.githubusercontent.com/dineshpotla/nvicode/main/assets/screenshots/select-model.png)

### Launch through your selected provider

![nvicode launch claude](https://raw.githubusercontent.com/dineshpotla/nvicode/main/assets/screenshots/launch.png)

## How It Works

- Claude Code:
  - NVIDIA uses a local Anthropic-compatible proxy on `127.0.0.1:8788`
  - OpenRouter connects directly to `https://openrouter.ai/api`
- Codex CLI:
  - uses the local `nvicode` proxy
  - `nvicode` configures Codex to talk to that proxy through the Responses API
- OpenClaw:
  - updates the default OpenClaw config for the selected provider/model
  - restart the gateway after config changes:

```sh
openclaw gateway restart
```

## Commands

Common commands:

```sh
nvicode select model
nvicode launch claude
nvicode launch codex
nvicode launch openclaw
nvicode dashboard
nvicode usage
nvicode activity
nvicode models
nvicode config
nvicode auth
nvicode launch claude -p "Reply with exactly OK"
nvicode launch codex "Explain this project"
```

Behavior notes:
- `nvicode select model` asks for provider, optional API key update, and model choice in one guided flow.
- Claude Code uses direct OpenRouter mode for OpenRouter, and proxy mode for NVIDIA.
- Codex currently uses the local `nvicode` proxy path.
- `nvicode usage`, `activity`, and `dashboard` are currently focused on NVIDIA proxy sessions.
- OpenRouter does not currently produce the same local usage visibility as the NVIDIA proxy flow.
- NVIDIA requests are paced to `40 RPM` by default. Override with `NVICODE_MAX_RPM` if your account allows more.

In an interactive terminal, `nvicode usage` refreshes live every 2 seconds. When piped or redirected, it prints a single snapshot.

The usage dashboard compares your local NVIDIA run cost against Claude Opus 4.6 at `$5 / MTok input` and `$25 / MTok output`, based on Anthropic pricing as of `2026-03-30`.
If your NVIDIA endpoint is not free, override local cost estimates with `NVICODE_INPUT_USD_PER_MTOK` and `NVICODE_OUTPUT_USD_PER_MTOK`.

## Requirements

- Claude Code must already be installed to use `nvicode launch claude`.
- Codex must already be installed to use `nvicode launch codex`. Install with `npm install -g @openai/codex`.
- OpenClaw must already be installed to use `nvicode launch openclaw`. Install with `npm install -g openclaw@latest`.
- Node.js 20 or newer is required to install `nvicode`.
- OpenClaw itself requires Node.js `>=22.14.0`.
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
- Claude Code, Codex CLI, and OpenClaw remain the frontends; the selected provider/model becomes the backend.
