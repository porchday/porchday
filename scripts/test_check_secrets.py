import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('check_secrets', Path(__file__).with_name('check-secrets.py'))
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class SecretGuard(unittest.TestCase):
    def test_binary_and_large_files_and_chunk_boundary(self):
        token = b'gh' + b'p_' + b'a' * 36
        body = b'\xff' * (checker.BLOCK * 3 - 4) + token + b'\x00'
        self.assertIn('GitHub token', checker.content_rules(io.BytesIO(body)))

    def test_private_key_and_remote_database(self):
        key = b'-----BEGIN ' + b'RSA PRIVATE KEY-----\n' + b'A' * 80
        self.assertIn('private key', checker.content_rules(io.BytesIO(key)))
        armor = b'-----BEGIN PGP ' + b'PRIVATE KEY BLOCK-----\nVersion: fixture\n\n' + b'A' * 80
        self.assertIn('OpenPGP private key', checker.content_rules(io.BytesIO(armor)))
        credential = b'postgres://user:' + b'unit-test-only' + b'@db.example.invalid/database'
        self.assertIn('remote PostgreSQL credential', checker.content_rules(io.BytesIO(credential)))
        for host in [b'localhost', b'127.0.0.1', b'[::1]']:
            fixture = b'postgres://user:' + b'local-only' + b'@' + host + b':5432/test'
            self.assertEqual(checker.content_rules(io.BytesIO(fixture)), [])
        spoof = b'postgres://user:' + b'local-only' + b'@localhost.example.invalid/test'
        self.assertIn('remote PostgreSQL credential', checker.content_rules(io.BytesIO(spoof)))

    def test_force_added_ignored_file_and_newline_filename_without_value_output(self):
        with tempfile.TemporaryDirectory() as directory:
            subprocess.run(['git', 'init', '-q', directory], check=True)
            root = Path(directory)
            (root / '.gitignore').write_text('.env\n')
            (root / '.env').write_text('EXAMPLE=value\n')
            subprocess.run(['git', '-C', directory, 'add', '-f', '.env'], check=True)
            token = 'gh' + 'p_' + 'z' * 36
            (root / 'odd\nname.bin').write_bytes(b'\xff' + token.encode())
            (root / (token + '.key')).write_bytes(b'fixture')
            (root / (token + '.txt')).write_bytes(b'fixture')
            result = subprocess.run([sys.executable, str(Path(checker.__file__).resolve())],
                                    cwd=directory, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn('credential/private file', result.stdout)
            self.assertIn('GitHub token', result.stdout)
            self.assertIn('credential-shaped filename', result.stdout)
            self.assertNotIn(token, result.stdout + result.stderr)

    def test_example_env_is_allowed_but_secrets_are_not(self):
        self.assertFalse(checker.sensitive_filename('apps/api/.env.example'))
        for name in ['.env', '.env.production', '.dev.vars', 'signing.p8',
                     'signing.p12', 'secrets.env', 'artifacts/private/report.json']:
            self.assertTrue(checker.sensitive_filename(name), name)


if __name__ == '__main__':
    unittest.main()
