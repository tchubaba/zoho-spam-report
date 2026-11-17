#!/usr/bin/env python3
"""Package the add-on XPI.

zoho-client.json is gitignored (it holds the shared Zoho OAuth app
credentials that every user's connect flow needs) but MUST ship inside the
XPI. Missing credentials are refused here rather than shipping a broken
add-on.
"""
import pathlib, zipfile, json, sys

root = pathlib.Path(__file__).resolve().parent.parent
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
version = manifest["version"]
out = root / "dist" / f"spam-report-for-zoho-mail-{version}.xpi"
out.parent.mkdir(exist_ok=True)

client = root / "zoho-client.json"
if not client.is_file():
    sys.exit("refusing to build: zoho-client.json is missing; the shipped "
             "add-on needs the shared OAuth app credentials")
json.loads(client.read_text(encoding="utf-8"))  # sanity parse

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(root / "manifest.json", "manifest.json")
    z.write(root / "LICENSE", "LICENSE")
    z.write(client, "zoho-client.json")
    for p in sorted((root / "src").rglob("*")):
        if p.is_file():
            z.write(p, p.relative_to(root).as_posix())
print(out)
