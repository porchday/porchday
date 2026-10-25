#!/usr/bin/env python3
"""Bundle checked-in upstream notices; reads no environment or secret files."""
from pathlib import Path
root=Path(__file__).resolve().parents[1]
text=(root/'THIRD_PARTY_NOTICES.md').read_text()+'\n'
for path in sorted((root/'third-party-licenses').glob('*.txt')):
    text+='\n'+'='*72+'\n'+path.name+'\n'+'='*72+'\n'+path.read_text()+'\n'
for target in [root/'apps/web/public/third-party-notices.txt',root/'apps/ios/Porchday/ThirdPartyNotices.txt']:
    target.write_text(text)
print('Client license notices regenerated.')
