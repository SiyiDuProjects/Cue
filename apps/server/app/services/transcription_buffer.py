"""The single device transcription timeline, independent of chat selection."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import uuid

from app.services.realtime_history import InterviewHistory, observed_at


def recent_turns(history, seen=None):
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat().replace('+00:00', 'Z')
    # Previously supplied turns must still receive corrections after the window.
    return [t for t in history.transcript_snapshot()
            if t.get('created_at', '') >= cutoff or t['turn_id'] in (seen or {})]


class TranscriptionBuffer:
    def __init__(self, record=None):
        self.history = InterviewHistory()
        self.identity = (record or {}).get('id') or str(uuid.uuid4())
        self.started_at = (record or {}).get('started_at') or observed_at()
        self.visible_images = set((record or {}).get('visible_images', []))
        self.sent_images = set((record or {}).get('sent_images', []))
        for entry in deepcopy((record or {}).get('entries', [])):
            self.history.entries.append(entry)
            key = entry['turn_id'] if entry['kind'] == 'transcript' else 'screen:' + entry['request_id']
            self.history.by_id[key] = entry
            if entry['kind'] == 'transcript':
                if entry.get('status') == 'streaming':
                    entry['status'] = 'interrupted'
                self.history.turns.append(entry)

    def export(self):
        return deepcopy({'id': self.identity, 'started_at': self.started_at,
                         'entries': self.history.entries, 'visible_images': sorted(self.visible_images),
                         'sent_images': sorted(self.sent_images)})

    def import_legacy(self, record):
        for entry in deepcopy(record.get('entries', [])):
            if entry['kind'] not in {'transcript', 'screen'}:
                continue
            key = entry.get('turn_id') if entry['kind'] == 'transcript' else 'screen:' + entry['request_id']
            if key in self.history.by_id:
                continue
            self.history.entries.append(entry)
            self.history.by_id[key] = entry
            if entry['kind'] == 'transcript':
                if entry.get('status') == 'streaming':
                    entry['status'] = 'interrupted'
                self.history.turns.append(entry)
        self.visible_images.update(record.get('screens', []))
        for entry in record.get('entries', []):
            if entry['kind'] == 'chat_request':
                self.sent_images.update(s['request_id'] for s in entry.get('screens', []))
        self.visible_images.update(self.sent_images)

    def material_record(self):
        return {'title': '当前转录', 'entries': deepcopy(self.history.entries),
                'screens': list(self.visible_images - self.sent_images),
                'visible_images': list(self.visible_images), 'answers': {}, 'answer_status': {}}
