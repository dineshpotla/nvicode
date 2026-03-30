# nvicode

Run Claude Code through NVIDIA-hosted models using a local Anthropic-compatible gateway.

## Quickstart

Install the published package:

```sh
npm install -g nvicode
```

Save your NVIDIA API key:

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
nvicode models
nvicode config
nvicode auth
nvicode launch claude -p "Reply with exactly OK"
```

The launcher starts a local proxy on `127.0.0.1:8788`, points Claude Code at it with `ANTHROPIC_BASE_URL`, and forwards requests to NVIDIA `chat/completions`.

If no NVIDIA API key is saved yet, `nvicode` prompts for one on first use.

## Requirements

- Claude Code must already be installed on the machine.
- Node.js 20 or newer is required to install `nvicode`.

## Local Development

These steps are only for contributors working from a git checkout. End users do not need them.

```sh
npm install
npm run build
ln -sf "$(pwd)/dist/cli.js" ~/.local/bin/nvicode
```

## Notes

- `thinking` is disabled by default because some NVIDIA reasoning models can consume the entire output budget and return no visible answer to Claude Code.
- The proxy supports basic text, tool calls, tool results, and token count estimation.
- Claude Code remains the frontend; the selected NVIDIA model becomes the backend.
