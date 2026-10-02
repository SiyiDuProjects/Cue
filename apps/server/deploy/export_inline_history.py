"""Export a private SQLite backup readable by releases before image references.

Never changes the source database. Stop/gate the app before using the exported
copy for a rollback, so no records written after export are lost.
"""
import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3


def export_inline_history(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if not source.is_file() or destination.exists() or source == destination:
        raise ValueError('An existing source and a new backup destination are required.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as original, closing(sqlite3.connect(destination)) as backup:
        destination.chmod(0o600)
        original.backup(backup)
        if not backup.execute("SELECT 1 FROM sqlite_master WHERE name='conversation_images'").fetchone():
            return
        for table in ('conversations', 'transcription_buffers'):
            for owner, identity in backup.execute(f'SELECT owner,id FROM {table}').fetchall():
                body = backup.execute(f'SELECT body FROM {table} WHERE owner=? AND id=?', (owner, identity)).fetchone()[0]
                def image_hook(value):
                    if set(value) != {'$sage_image'}:
                        return value
                    image = backup.execute('SELECT body FROM conversation_images WHERE owner=? AND id=?',
                                           (owner, value['$sage_image'])).fetchone()
                    if not image:
                        raise ValueError('Missing image; cannot export a complete rollback copy.')
                    return image[0]
                decoded = json.loads(body, object_hook=image_hook)
                backup.execute(f'UPDATE {table} SET body=? WHERE owner=? AND id=?',
                               (json.dumps(decoded, ensure_ascii=False), owner, identity))
        backup.commit()
    destination.chmod(0o600)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--destination', required=True)
    args = parser.parse_args()
    export_inline_history(args.source, args.destination)
    print('Private rollback copy exported; source unchanged.')
