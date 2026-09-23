from pathlib import Path, PurePosixPath
from stat import S_ISREG
import sys
from zipfile import ZIP_STORED, ZipFile

root = Path(__file__).resolve().parent.parent
archive = Path(sys.argv[1])
destination = Path(sys.argv[2])
expected = {
    "index.html": (root / "index.html").read_bytes(),
    "assets/lantern-map.png": (root / "assets" / "lantern-map.png").read_bytes(),
    "assets/night-birds.wav": (root / "assets" / "night-birds.wav").read_bytes(),
}

with ZipFile(archive) as zip_file:
    infos = zip_file.infolist()
    names = [info.filename for info in infos]
    if len(names) != len(expected) or set(names) != set(expected):
        raise SystemExit(f"FAIL: unexpected ZIP paths: {names}")
    bad_member = zip_file.testzip()
    if bad_member is not None:
        raise SystemExit(f"FAIL: ZIP CRC mismatch: {bad_member}")
    for info in infos:
        path = PurePosixPath(info.filename)
        mode = info.external_attr >> 16
        if (info.compress_type != ZIP_STORED or path.is_absolute() or not path.parts
                or any(part in ("", ".", "..") for part in path.parts)
                or ":" in path.parts[0] or (mode and not S_ISREG(mode))):
            raise SystemExit(f"FAIL: unsupported or unsafe ZIP member {info.filename}")
        data = zip_file.read(info.filename)
        if data != expected[info.filename]:
            raise SystemExit(f"FAIL: ZIP content differs from {info.filename}")
        target = destination.joinpath(*path.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

print(f"PASS: extracted and opened archive copy with {len(expected)} byte-identical stored members")
