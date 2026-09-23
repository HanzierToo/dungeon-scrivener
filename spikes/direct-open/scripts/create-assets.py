from math import pi, sin
from pathlib import Path
import struct
import zlib


ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
ASSETS.mkdir(exist_ok=True)


def png_chunk(kind: bytes, data: bytes) -> bytes:
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


width, height = 192, 128
pixels = bytearray()
for y in range(height):
    for x in range(width):
        color = (12, 22, 55, 255)
        if (x + 2 * y) % 47 == 0 and y < 52:
            color = (205, 215, 235, 255)
        # A broad blue trail bends toward the lantern.
        trail_x = 20 + y // 2 if y > 70 else 58 + (70 - y) // 2
        if abs(x - trail_x) <= 4:
            color = (43, 119, 205, 255)
        if 138 <= x <= 154 and 38 <= y <= 60:
            color = (235, 162, 55, 255)
        if 142 <= x <= 150 and 42 <= y <= 55:
            color = (255, 225, 130, 255)
        pixels.extend(color)

scanlines = b"".join(b"\x00" + pixels[y * width * 4:(y + 1) * width * 4] for y in range(height))
png = (
    b"\x89PNG\r\n\x1a\n"
    + png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    + png_chunk(b"IDAT", zlib.compress(scanlines, 9))
    + png_chunk(b"IEND", b"")
)
(ASSETS / "lantern-map.png").write_bytes(png)

sample_rate = 22050
duration = 0.8
sample_count = int(sample_rate * duration)
samples = bytearray()
for index in range(sample_count):
    t = index / sample_rate
    envelope = min(1.0, t * 18) * min(1.0, (duration - t) * 8)
    tone = sin(2 * pi * 660 * t) + 0.35 * sin(2 * pi * 990 * t)
    sample = int(max(-1, min(1, 0.22 * envelope * tone)) * 32767)
    samples.extend(struct.pack("<h", sample))

pcm = bytes(samples)
wav = (
    b"RIFF"
    + struct.pack("<I", 36 + len(pcm))
    + b"WAVEfmt "
    + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
    + b"data"
    + struct.pack("<I", len(pcm))
    + pcm
)
(ASSETS / "night-birds.wav").write_bytes(wav)
