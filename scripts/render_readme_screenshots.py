#!/usr/bin/env python3

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "assets" / "screenshots"
FONT_PATH = Path("/System/Library/Fonts/SFNSMono.ttf")


def load_font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT_PATH), size=size)


def wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    if not text:
        return [""]

    wrapped: list[str] = []
    for raw_line in text.splitlines():
        if not raw_line:
            wrapped.append("")
            continue

        current = ""
        for word in raw_line.split(" "):
            candidate = word if not current else f"{current} {word}"
            width = draw.textbbox((0, 0), candidate, font=font)[2]
            if width <= max_width:
                current = candidate
                continue

            if current:
                wrapped.append(current)
            current = word

        wrapped.append(current)

    return wrapped


def render_terminal_card(
    *,
    title: str,
    subtitle: str,
    body: str,
    filename: str,
    width: int = 1480,
) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    title_font = load_font(44)
    subtitle_font = load_font(22)
    body_font = load_font(28)
    line_height = 42

    temp_image = Image.new("RGB", (width, 1000))
    temp_draw = ImageDraw.Draw(temp_image)
    body_lines = wrap_text(temp_draw, body, body_font, width - 180)

    header_height = 122
    body_height = 120 + (len(body_lines) * line_height)
    height = header_height + body_height + 36

    image = Image.new("RGB", (width, height), "#09131f")
    draw = ImageDraw.Draw(image)

    for y in range(height):
        ratio = y / max(height - 1, 1)
        r = int(9 + ((19 - 9) * ratio))
        g = int(19 + ((26 - 19) * ratio))
        b = int(31 + ((43 - 31) * ratio))
        draw.line((0, y, width, y), fill=(r, g, b))

    margin = 28
    card_left = margin
    card_top = margin
    card_right = width - margin
    card_bottom = height - margin

    draw.rounded_rectangle(
        (card_left, card_top, card_right, card_bottom),
        radius=26,
        fill="#0d1624",
        outline="#233247",
        width=2,
    )

    header_bottom = card_top + header_height
    draw.rounded_rectangle(
        (card_left, card_top, card_right, header_bottom),
        radius=26,
        fill="#101b2a",
        outline=None,
    )
    draw.rectangle((card_left, header_bottom - 26, card_right, header_bottom), fill="#101b2a")
    draw.line((card_left, header_bottom, card_right, header_bottom), fill="#233247", width=2)

    circle_y = card_top + 38
    circle_x = card_left + 34
    colors = ["#ff5f57", "#febc2e", "#28c840"]
    for color in colors:
        draw.ellipse((circle_x, circle_y, circle_x + 18, circle_y + 18), fill=color)
        circle_x += 30

    draw.text((card_left + 128, card_top + 24), title, font=title_font, fill="#f4f7fb")
    draw.text((card_left + 130, card_top + 70), subtitle, font=subtitle_font, fill="#9db2c8")

    body_x = card_left + 44
    body_y = header_bottom + 36
    for index, line in enumerate(body_lines):
        color = "#cfe0f5"
        if line.startswith("$ "):
            color = "#7fe3a1"
        elif line.startswith("#"):
            color = "#8ca2b8"
        draw.text((body_x, body_y + (index * line_height)), line, font=body_font, fill=color)

    output = OUT_DIR / filename
    image.save(output)


def main() -> None:
    render_terminal_card(
        title="nvicode auth",
        subtitle="Provider-aware key save flow",
        filename="auth.png",
        body=(
            "$ nvicode auth\n"
            "OpenRouter API key: sk-or-example-readme-key\n"
            "Saved OpenRouter API key."
        ),
    )

    render_terminal_card(
        title="nvicode select model",
        subtitle="Guided provider, key, and model setup",
        filename="select-model.png",
        body=(
            "$ nvicode select model\n"
            "Choose a provider:\n"
            "1. NVIDIA\n"
            "2. OpenRouter\n"
            "Provider selection [2]: 2\n"
            "OpenRouter API key already saved. Update it? [y/N]: n\n"
            "Top popular OpenRouter models:\n"
            "1. Qwen 3.6 Plus Preview (Free)\n"
            "   qwen/qwen3.6-plus-preview:free\n"
            "   Free OpenRouter Qwen preview model.\n"
            "2. Claude Sonnet 4.6\n"
            "   anthropic/claude-sonnet-4.6\n"
            "   Recommended OpenRouter model for Claude Code compatibility.\n"
            "3. Claude Opus 4.6\n"
            "   anthropic/claude-opus-4.6\n"
            "   Higher-end Anthropic model through OpenRouter.\n"
            "Or paste a full model id.\n"
            "Example: qwen/qwen3.6-plus-preview:free\n"
            "Model selection: qwen/qwen3.6-plus-preview:free\n"
            "Saved model: qwen/qwen3.6-plus-preview:free"
        ),
    )

    render_terminal_card(
        title="nvicode launch claude",
        subtitle="Claude Code launched through OpenRouter via nvicode",
        filename="launch.png",
        body=(
            "$ nvicode launch claude\n"
            "Claude Code v2.1.87\n"
            "\n"
            "❯ /status\n"
            "Status   Config   Usage\n"
            "\n"
            "Version: 2.1.87\n"
            "Session name: /rename to add a name\n"
            "Session ID: 2c9d288b-98b0-4fde-ba25-533bfd06f53e\n"
            "cwd: ~/project\n"
            "Auth token: ANTHROPIC_AUTH_TOKEN\n"
            "Anthropic base URL: https://openrouter.ai/api\n"
            "\n"
            "Model: qwen/qwen3.6-plus-preview:free\n"
            "Setting sources: User settings"
        ),
    )


if __name__ == "__main__":
    main()
