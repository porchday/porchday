#!/usr/bin/env python3
"""Build a private/local client source artifact from explicitly allowed tracked files."""
import argparse,gzip,io,subprocess,tarfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('output',type=Path,help='Local output .tar.gz; no upload is performed')
args=parser.parse_args()
allowed=['apps/web','apps/ios','packages/crypto','third-party-licenses','THIRD_PARTY_NOTICES.md','LICENSE','package.json','package-lock.json','apps/api/package.json','tsconfig.base.json','scripts/build-third-party-notices.py']
paths=subprocess.check_output(['git','ls-files','-z','--',*allowed],cwd=root).decode().split('\0')
readme=b'Porchday client source bundle. See THIRD_PARTY_NOTICES.md for pinned dependency source and rebuild instructions. This artifact is prepared locally; its creation does not publish any source. No service credentials are included.\n'
buffer=io.BytesIO()
with tarfile.open(fileobj=buffer,mode='w',format=tarfile.PAX_FORMAT) as archive:
    def add(name,data,mode=0o644):
        info=tarfile.TarInfo('porchday-client/'+name);info.size=len(data);info.mode=mode;info.mtime=0
        archive.addfile(info,io.BytesIO(data))
    add('REBUILDING.txt',readme)
    for name in sorted(filter(None,paths)):
        path=Path(name)
        if any(part.startswith('.env') or part in {'node_modules','build','.DS_Store','.git'} for part in path.parts):continue
        if path.suffix.lower() in {'.p12','.p8','.key','.mobileprovision','.pem'}:raise SystemExit('Credential-shaped file rejected from source archive')
        source=root/path
        if source.is_symlink():raise SystemExit('Symlink rejected from source archive')
        if not source.is_file():raise SystemExit('Tracked source file missing: '+name)
        add(name,source.read_bytes(),0o755 if source.stat().st_mode&0o111 else 0o644)
args.output.parent.mkdir(parents=True,exist_ok=True)
with args.output.open('wb') as file:
    with gzip.GzipFile(filename='',mode='wb',fileobj=file,mtime=0) as compressed:compressed.write(buffer.getvalue())
print('Created local client source artifact; nothing was uploaded.')
