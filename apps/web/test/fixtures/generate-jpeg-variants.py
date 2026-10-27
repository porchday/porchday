"""Regenerate neutral JPEG fixtures; requires Pillow and libjpeg-turbo's cjpeg."""

import base64
import hashlib
import json
from io import BytesIO
from pathlib import Path
import struct
import subprocess
import tempfile

from PIL import Image, ImageCms, __version__ as pillow_version


image = Image.new("RGB", (32, 24))
colors = [(230, 20, 10), (10, 200, 20), (20, 40, 230), (235, 210, 15)]
for y in range(image.height):
    for x in range(image.width):
        image.putpixel((x, y), colors[(y >= 12) * 2 + (x >= 16)])


def jpeg(source=image, **options):
    output = BytesIO()
    source.save(output, format="JPEG", quality=92, **options)
    return output.getvalue()


fixtures = []


def add(name, raw, **extra):
    fixtures.append({
        "name": name,
        "base64": base64.b64encode(raw).decode(),
        "sha256": hashlib.sha256(raw).hexdigest(),
        **extra,
    })


primary = jpeg()
add("baseline", primary)
add("progressive", jpeg(progressive=True))
add("grayscale", jpeg(image.convert("L")))
add("cmyk", jpeg(image.convert("CMYK")))
exif = Image.Exif()
exif[274] = 6
exif[270] = "PORCHDAY_SYNTHETIC_EXIF"
exif[306] = "2000:01:01 00:00:00"
add("exif-rotated", jpeg(exif=exif))
profile = bytearray(ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes())
profile[24:36] = struct.pack(">6H", 2000, 1, 1, 0, 0, 0)
add("icc-profile", jpeg(icc_profile=bytes(profile)))
add("trailing-padding", primary + b"\0" * 32)
auxiliary = jpeg(Image.new("RGB", (16, 12), (50, 55, 60)))
add("appended-image", primary + auxiliary, syntheticContainer=True)

# MPF APP2 index: TIFF header, three IFD entries, two 16-byte MP entries.
# Second image offset is relative to the TIFF header, at byte 10 after SOI.
mpf_length = 4 + 8 + 2 + 3 * 12 + 4 + 32
primary_length = len(primary) + 4 + mpf_length
mpf = b"MPF\0II" + struct.pack("<HIH", 42, 8, 3)
mpf += struct.pack("<HHI4s", 0xB000, 7, 4, b"0100")
mpf += struct.pack("<HHII", 0xB001, 4, 1, 2)
mpf += struct.pack("<HHII", 0xB002, 7, 32, 8 + 2 + 3 * 12 + 4)
mpf += struct.pack("<I", 0)
mpf += struct.pack("<IIIHH", 0x20030000, primary_length, 0, 0, 0)
mpf += struct.pack("<IIIHH", 0, len(auxiliary), primary_length - 10, 0, 0)
assert len(mpf) == mpf_length
mpf_image = (
    primary[:2] + b"\xff\xe2" + struct.pack(">H", len(mpf) + 2)
    + mpf + primary[2:] + auxiliary
)
add("mpf-multipicture", mpf_image, syntheticContainer=True)

# Test XMP + appended-image handling, not HDR gain-map fidelity.
xmp = (
    b"http://ns.adobe.com/xap/1.0/\0"
    b'<x:xmpmeta xmlns:x="adobe:ns:meta/">'
    b"<SyntheticMarker>PORCHDAY_SYNTHETIC_XMP</SyntheticMarker></x:xmpmeta>"
)
add("xmp-appended-image", (
    primary[:2] + b"\xff\xe1" + struct.pack(">H", len(xmp) + 2)
    + xmp + primary[2:] + auxiliary
), syntheticContainer=True)

with tempfile.TemporaryDirectory() as directory:
    ppm = Path(directory) / "source.ppm"
    image.save(ppm)
    for name, options in [
        ("restart-interval", ["-restart", "1B"]),
        ("rgb-jpeg", ["-rgb"]),
        ("arithmetic", ["-arithmetic"]),
        ("lossless", ["-lossless", "1"]),
        ("twelve-bit", ["-precision", "12"]),
    ]:
        add(name, subprocess.check_output(["cjpeg", *options, str(ppm)]))

encoder = subprocess.run(["cjpeg", "-version"], capture_output=True, text=True, check=True)
version = (encoder.stdout + encoder.stderr).strip()
result = {
    "synthetic": True,
    "width": image.width,
    "height": image.height,
    "generator": f"Pillow {pillow_version}; {version}",
    "fixtures": fixtures,
}
destination = Path(__file__).with_name("jpeg-variants.json")
destination.write_text(json.dumps(result, indent=2) + "\n")
print(f"Wrote {len(fixtures)} synthetic JPEG fixtures to {destination.name}")
