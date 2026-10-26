# Unicode emoji data

`emoji-test-17.0.txt` is the unmodified Unicode 17.0 source from
https://www.unicode.org/Public/17.0.0/emoji/emoji-test.txt.
Its SHA-256 is `1d8a944f88d7952f7ef7c5167fef3c67995bcae24543949710231b03a201acda`.
Unicode's redistribution license is included in `UNICODE-LICENSE.txt`.

Run `python3 scripts/generate-unicode-emoji.py` from the repository to regenerate
`emoji-17.0.json`, or pass `--check` to verify the checked-in result. Generation
uses only the pinned local source and never downloads data. Native and web
clients consume the same JSON resource.

Only fully-qualified emoji are picker entries. Their officially listed
minimally-qualified and unqualified forms are aliases of the same entry, matched
by exact source name, group, and subgroup. Standalone components are excluded.
No skin-tone, gender, flag, variation-selector, or ZWJ combinations are invented.
The six original Porchday glyphs retain their legacy reaction IDs.
