#!/usr/bin/env python3
"""Generate the PWA icons (no game art, no third-party assets).

Draws a small desert/sun mark with a blocky DUNE wordmark; pure stdlib so it
runs anywhere (the result is committed under web/icons/).
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "icons"

# 5x7 blocky font for the wordmark.
FONT = {
    "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    "N": ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
}


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def make(size: int, maskable: bool) -> bytes:
    pixels = [[(0, 0, 0, 0) for _ in range(size)] for _ in range(size)]
    # Sky gradient (deep brown -> warm gold near the horizon).
    horizon = int(size * (0.62 if maskable else 0.58))
    for y in range(horizon):
        t = y / max(1, horizon - 1)
        r = int(lerp(18, 96, t))
        g = int(lerp(12, 62, t))
        b = int(lerp(10, 30, t))
        for x in range(size):
            pixels[y][x] = (r, g, b, 255)
    # Sun.
    cx, cy, radius = size * 0.70, size * 0.30, size * 0.135
    for y in range(size):
        for x in range(size):
            if (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2:
                t = (y - (cy - radius)) / (2 * radius)
                pixels[y][x] = (int(lerp(255, 232, t)), int(lerp(214, 150, t)), int(lerp(110, 40, t)), 255)
    # Dune silhouettes.
    def dune(base: float, amp: float, color: tuple[int, int, int]) -> None:
        for x in range(size):
            u = x / max(1, size - 1)
            wave = (0.5 + 0.5 * (abs(((u * 2.0) % 1.0) - 0.5) * 2.0)) ** 1.4
            top = int(size * base - amp * size * wave)
            for y in range(max(0, top), size):
                pixels[y][x] = (*color, 255)

    dune(0.78, 0.08, (150, 96, 34))
    dune(0.88, 0.10, (104, 63, 22))
    dune(1.02, 0.10, (62, 38, 15))
    # Wordmark.
    letters = "DUNE"
    scale = max(2, size // 46)
    glyph_w, glyph_h = 5 * scale, 7 * scale
    gap = max(2, scale)
    total = len(letters) * glyph_w + (len(letters) - 1) * gap
    left = (size - total) // 2
    top = int(size * (0.10 if maskable else 0.07))
    for index, letter in enumerate(letters):
        ox = left + index * (glyph_w + gap)
        for gy, row in enumerate(FONT[letter]):
            for gx, cell in enumerate(row):
                if cell != "1":
                    continue
                for dy in range(scale):
                    for dx in range(scale):
                        x, y = ox + gx * scale + dx, top + gy * scale + dy
                        if 0 <= x < size and 0 <= y < size:
                            pixels[y][x] = (255, 216, 115, 255)
    # Rounded corners for the non-maskable icons.
    if not maskable:
        corner = size // 8
        for y in range(size):
            for x in range(size):
                dx = max(0, corner - x, x - (size - 1 - corner))
                dy = max(0, corner - y, y - (size - 1 - corner))
                if dx * dx + dy * dy > corner * corner:
                    pixels[y][x] = (0, 0, 0, 0)

    raw = b"".join(b"\x00" + b"".join(bytes(p) for p in row) for row in pixels)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size, maskable in (
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("maskable-512.png", 512, True),
    ):
        path = OUT / name
        path.write_bytes(make(size, maskable))
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
