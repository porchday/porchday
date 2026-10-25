# Repository text formatting

Run `python3 scripts/check-format.py` before committing. Linux CI runs the same check plus its regression tests. `.editorconfig` supplies the corresponding editor defaults.

The minimum repository-wide policy is UTF-8, LF line endings, a final newline for nonempty files, and no trailing spaces or tabs. Markdown may use exactly two trailing spaces after nonempty text for a hard line break. Existing indentation, quote styles and language-specific layouts are preserved; this is a text-hygiene check, not a claim that every language has a canonical formatter.

The checker covers tracked and nonignored candidate first-party source, documentation and configuration. It does not traverse ignored secrets, dependencies or build output. Binary files, upstream license texts, generated client-source packages and the checksum-bound `docs/archive/sample/` interoperability fixtures are excluded. Changing those fixture bytes requires regenerating and validating their checksums, not automatic whitespace cleanup. The checker reports only filenames, line numbers and fixed rule names.
