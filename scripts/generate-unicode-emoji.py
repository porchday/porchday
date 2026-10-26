#!/usr/bin/env python3
"""Generate offline emoji metadata from the checked-in Unicode 17 source."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'packages/crypto/data/emoji-test-17.0.txt'
OUTPUT = ROOT / 'packages/crypto/data/emoji-17.0.json'
SHA256 = '1d8a944f88d7952f7ef7c5167fef3c67995bcae24543949710231b03a201acda'
URL = 'https://www.unicode.org/Public/17.0.0/emoji/emoji-test.txt'


def generate():
    raw = SOURCE.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SHA256:
        raise ValueError('Pinned Unicode source checksum changed')
    group = subgroup = ''
    rows = []
    for line in raw.decode('utf8').splitlines():
        if line.startswith('# group: '):
            group = line.removeprefix('# group: ')
        elif line.startswith('# subgroup: '):
            subgroup = line.removeprefix('# subgroup: ')
        elif line and not line.startswith('#'):
            match = re.fullmatch(r'([0-9A-F ]+)\s*;\s*(fully-qualified|minimally-qualified|unqualified|component)\s*#\s*\S+\s+E([0-9.]+)\s+(.+)', line)
            if not match:
                raise ValueError('Unexpected Unicode source row')
            points, status, version, name = match.groups()
            value = ''.join(chr(int(point, 16)) for point in points.split())
            if value != unicodedata.normalize('NFC', value):
                raise ValueError('Noncanonical Unicode source sequence')
            if status != 'component':
                rows.append((value, status, version, name, group, subgroup))
    canonical = {}
    for value, status, version, name, group, subgroup in rows:
        if status == 'fully-qualified':
            key = (name, group, subgroup)
            if key in canonical:
                raise ValueError('Ambiguous Unicode canonical name')
            canonical[key] = {'unicode': value, 'name': name, 'group': group,
                              'subgroup': subgroup, 'version': version, 'aliases': []}
    aliases = {}
    for value, _, _, name, group, subgroup in rows:
        entry = canonical[(name, group, subgroup)]
        if value in aliases:
            raise ValueError('Duplicate Unicode alias')
        aliases[value] = entry['unicode']
        entry['aliases'].append(value)
    return {'version': '17.0', 'source': URL, 'sourceSha256': SHA256,
            'license': 'Unicode-3.0; see UNICODE-LICENSE.txt',
            'emojis': list(canonical.values())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    data = generate()
    text = json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n'
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_text() != text:
            raise SystemExit('Generated Unicode metadata is stale')
    else:
        OUTPUT.write_text(text)
    print(f"Unicode {data['version']}: {len(data['emojis'])} canonical emoji, "
          f"{sum(len(e['aliases']) for e in data['emojis'])} recognized forms")


if __name__ == '__main__':
    main()
