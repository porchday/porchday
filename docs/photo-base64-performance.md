# Photo byte-copy diagnostic

The web photo path decodes decrypted base64 before JPEG validation and browser
image decode. `base64ToBytes` now copies the output of the existing `atob` call
into an exactly sized byte array with a direct loop. This avoids the iterable and
per-character callback work in `Uint8Array.from`. Base64 parsing, accepted input,
rejection, encryption, signatures, JPEG validation and expiry checks are unchanged.
The shared helper also serves archives and other binary payloads.

Reproduce the local comparison with installed Playwright Chromium and WebKit:

```sh
node scripts/check-base64-copy.mjs
```

The harness bundles the actual helper and compares it to the previous expression.
It uses local synthetic bytes covering all 256 byte values, blocks remote traffic,
checks every output byte outside the timed interval, alternates execution order,
and discards one warmup per method/size. Fifteen valid/invalid base64 forms must
retain identical acceptance and rejection in each engine. Unit coverage also checks
empty input, padding boundaries, 8192-byte chunk boundaries and independent buffers.

Observed October 29, 2026 on the local desktop, headless Chromium 156.0.8078.4 and
WebKit 27.2, without CPU/network emulation:

| Engine | Decoded size | Prior median | Direct-copy median | Samples per method |
| --- | ---: | ---: | ---: | ---: |
| Chromium | 1 MiB | 29.5 ms | 1.4 ms | 5 |
| Chromium | 4 MiB | 118.8 ms | 5.8 ms | 5 |
| WebKit | 1 MiB | 6 ms | 2 ms | 5 |
| WebKit | 4 MiB | 25 ms | 7 ms | 5 |

Measured intervals include `atob`, allocation and copying. These synthetic sizes
are diagnostic fixtures, not a claim about typical member photos. JIT warmup,
garbage collection and timer resolution affect these small samples. This is CPU
work removed from the photo path, not a first-visible-photo, physical-phone or p99
result. Full network download, author-key lookup, cryptographic validation, JPEG
validation/decode and visible rendering remain outside this benchmark. The
original regional, physical-device and production acceptance gates remain open.
