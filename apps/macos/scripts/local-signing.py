#!/usr/bin/env python3
"""Cue-only build signing. Never changes certificate trust or app permissions."""
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[4] / '_private' / 'Cue' / 'signing'
CONFIG = ROOT / 'identity.json'


def run(args, password='', **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if result.returncode:
        detail = result.stderr.replace(password, '[redacted]') if password else result.stderr
        raise RuntimeError(f'{Path(args[0]).name} failed: {detail[:600]}')
    return result.stdout.strip()


def setup():
    if CONFIG.exists():
        print('Cue signing identity already configured; preserved.')
        return
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    ROOT.chmod(0o700)
    keychain = ROOT / 'cue-build.keychain-db'
    if keychain.exists():
        raise RuntimeError('An unfinished Cue signing keychain exists; do not replace its identity.')
    password = base64.urlsafe_b64encode(secrets.token_bytes(36)).decode()
    password_file = ROOT / 'keychain-password'
    fd = os.open(password_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(password)
    with tempfile.TemporaryDirectory(prefix='identity-', dir=ROOT) as temp:
        folder = Path(temp)
        config = folder / 'openssl.cnf'
        config.write_text('[req]\ndistinguished_name=dn\nx509_extensions=signing\nprompt=no\n[dn]\nCN=Cue Local Code Signing\n[signing]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n')
        key = folder / 'private.pem'
        certificate = ROOT / 'certificate.pem'
        run(['/usr/bin/openssl', 'req', '-new', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '3650', '-config', str(config), '-keyout', str(key), '-out', str(certificate)])
        key.chmod(0o600)
        identity = folder / 'identity.p12'
        run(['/usr/bin/openssl', 'pkcs12', '-export', '-inkey', str(key), '-in', str(certificate), '-name', 'Cue Local Code Signing', '-out', str(identity), '-passout', 'file:' + str(password_file)])
        identity.chmod(0o600)
        try:
            run(['/usr/bin/security', 'create-keychain', '-p', password, str(keychain)], password)
            run(['/usr/bin/security', 'set-keychain-settings', '-lut', '900', str(keychain)])
            run(['/usr/bin/security', 'unlock-keychain', '-p', password, str(keychain)], password)
            run(['/usr/bin/security', 'import', str(identity), '-k', str(keychain), '-P', password, '-T', '/usr/bin/codesign'], password)
            run(['/usr/bin/security', 'set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', password, str(keychain)], password)
        finally:
            # Creation can add a keychain to the user search list. Remove only
            # this build keychain; preserve every unrelated/current entry.
            current = shlex.split(run(['/usr/bin/security', 'list-keychains', '-d', 'user']))
            remaining = [p for p in current if Path(p) != keychain]
            if remaining != current:
                run(['/usr/bin/security', 'list-keychains', '-d', 'user', '-s', *remaining])
        der = subprocess.run(['/usr/bin/openssl', 'x509', '-in', str(certificate), '-outform', 'DER'], capture_output=True, check=True).stdout
        fingerprint = hashlib.sha1(der).hexdigest().upper()
        metadata = {'identity': fingerprint, 'keychain': str(keychain), 'password_file': str(password_file), 'scope': 'Cue local builds only; no system trust changes'}
        CONFIG.write_text(json.dumps(metadata, indent=2) + '\n')
        CONFIG.chmod(0o600)
        print('Created fixed Cue local signing identity; certificate trust and existing permissions unchanged.')


def sign(paths):
    config = json.loads(CONFIG.read_text())
    password = Path(config['password_file']).read_text()
    run(['/usr/bin/security', 'unlock-keychain', '-p', password, config['keychain']], password)
    for path in paths:
        run(['/usr/bin/codesign', '--force', '--sign', config['identity'], '--keychain', config['keychain'], '--timestamp=none', path], password)
        run(['/usr/bin/codesign', '--verify', '--strict', path])
    print(f'Signed {len(paths)} artifact(s) with the fixed Cue identity.')


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['setup']:
            setup()
        elif len(sys.argv) > 2 and sys.argv[1] == 'sign':
            sign(sys.argv[2:])
        elif sys.argv[1:] == ['configured']:
            sys.exit(0 if CONFIG.exists() else 1)
        else:
            raise RuntimeError('Usage: local-signing.py setup | configured | sign PATH...')
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
