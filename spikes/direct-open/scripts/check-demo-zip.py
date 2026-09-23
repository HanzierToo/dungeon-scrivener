from pathlib import Path, PurePosixPath
from zipfile import ZIP_STORED, ZipFile


ROOT = Path(__file__).resolve().parent.parent
archive = ROOT / "dungeon-scrivener-direct-open.zip"
expected = {
    "index.html": (ROOT / "index.html").read_bytes(),
    "assets/lantern-map.png": (ROOT / "assets/lantern-map.png").read_bytes(),
    "assets/night-birds.wav": (ROOT / "assets/night-birds.wav").read_bytes(),
}

with ZipFile(archive) as zip_file:
    names = zip_file.namelist()
    if set(names) != set(expected) or len(names) != len(expected):
        raise SystemExit(f"FAIL: unexpected ZIP paths: {names}")
    if zip_file.testzip() is not None:
        raise SystemExit("FAIL: ZIP CRC mismatch")
    for info in zip_file.infolist():
        if info.compress_type != ZIP_STORED:
            raise SystemExit(f"FAIL: {info.filename} is compressed")
        path = PurePosixPath(info.filename)
        if path.is_absolute() or not path.parts or any(part in (".", "..") for part in path.parts) or ":" in path.parts[0]:
            raise SystemExit(f"FAIL: unsafe ZIP path {info.filename}")
        if zip_file.read(info.filename) != expected[info.filename]:
            raise SystemExit(f"FAIL: ZIP content differs from {info.filename}")
    html = zip_file.read("index.html").decode("utf-8")
    if "type=\"module\"" in html or "<script src=" in html or "fetch(" in html.split("<script>", 1)[0]:
        raise SystemExit("FAIL: unexpected module, external script, or pre-runtime network loading")

print(f"PASS: {archive.name}, {archive.stat().st_size} bytes, {len(expected)} byte-identical stored entries")
