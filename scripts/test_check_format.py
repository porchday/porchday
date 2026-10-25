import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('check_format', Path(__file__).with_name('check-format.py'))
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class FormattingPolicy(unittest.TestCase):
    def test_preserves_existing_indentation_quotes_and_markdown_breaks(self):
        self.assertEqual(checker.violations('code.ts', b'  const x="x";\n'), [])
        self.assertEqual(checker.violations('guide.md', b'First line  \nNext line\n'), [])

    def test_rejects_crlf_missing_newline_and_trailing_whitespace(self):
        self.assertIn('use LF line endings', checker.violations('code.ts', b'x\r\n'))
        self.assertIn('missing final newline', checker.violations('code.py', b'x'))
        for name, body in [('code.ts', b'x  \n'), ('guide.md', b'x \n'), ('guide.md', b'  \n')]:
            self.assertTrue(any('trailing whitespace' in error for error in checker.violations(name, body)))

    def test_keeps_checksum_fixtures_and_vendor_bytes_unchanged(self):
        for name in ['docs/archive/sample/index.html', 'third-party-licenses/library.md', 'photo.jpg']:
            self.assertEqual(checker.violations(name, b'\xff\r\n  '), [])
        self.assertEqual(checker.violations('first-party.ts', b'\xff'), ['invalid UTF-8'])


if __name__ == '__main__':
    unittest.main()
