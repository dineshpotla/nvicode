# nvicode

Run Claude Code through NVIDIA-hosted models using a local Anthropic-compatible gateway.

## Install

Published package:

```sh
npm install -g nvicode
```

Local development:

```sh
npm install
npm run build
ln -sf "$(pwd)/dist/cli.js" ~/.local/bin/nvicode
```

## Usage

Choose a model and save your NVIDIA API key:

```sh
nvicode select model
```

Launch Claude Code through the local gateway:

```sh
nvicode launch claude
```

Useful commands:

```sh
nvicode models
nvicode config
nvicode auth
nvicode launch claude -p "Reply with exactly OK"
```

The launcher starts a local proxy on `127.0.0.1:8788`, points Claude Code at it with `ANTHROPIC_BASE_URL`, and forwards requests to NVIDIA `chat/completions`.

If no NVIDIA API key is saved yet, `nvicode` prompts for one on first use.

## Notes

- `thinking` is disabled by default because some NVIDIA reasoning models can consume the entire output budget and return no visible answer to Claude Code.
- The proxy supports basic text, tool calls, tool results, and token count estimation.
- Claude Code remains the frontend; the selected NVIDIA model becomes the backend.
