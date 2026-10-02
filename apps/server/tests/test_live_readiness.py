"""Offline regression of screenshots, live cursors and stop/answer overlap."""
import asyncio
from contextlib import closing
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.services.conversation_store import ConversationStore
from app.services.interview_materials import InterviewMaterials
from app.services.openai_realtime import InterviewRegistry, _forward_ui_controls
from tests.test_realtime import make_runtime
from tests.codex_provider import CodexProvider


class ScreenshotStorageTests(unittest.TestCase):
    def test_images_are_written_once_and_restore_losslessly_after_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            store = ConversationStore(folder, 'owner')
            image = 'data:image/png;base64,' + 'A' * 4_000_000
            screen = {'kind': 'screen', 'request_id': 'image', 'image_url': image}
            record = {'title': 'fixture', 'updated_at': 'now', 'entries': [screen, {'screens': [screen]}]}
            transcript = {'id': 'transcript', 'entries': [screen]}
            store.save_transcription(transcript)
            store.save('chat', record)
            with store.connect() as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM conversation_images').fetchone()[0], 1)
                self.assertLess(len(db.execute('SELECT body FROM conversations').fetchone()[0]), 1000)
            with patch.object(store, '_write_images', wraps=store._write_images) as writes:
                for i in range(5):
                    transcript['entries'].append({'kind': 'transcript', 'text': str(i)})
                    store.save_transcription(transcript)
                    store.save('chat', record)
                self.assertTrue(all(not call.args[1] for call in writes.call_args_list))
            restarted = ConversationStore(folder, 'owner')
            self.assertEqual(restarted.read('chat'), record)
            self.assertEqual(restarted.read_transcription(), transcript)
            self.assertIsNone(ConversationStore(folder, 'someone-else').read('chat'))
            from deploy.export_inline_history import export_inline_history
            backup_path = Path(folder) / 'rollback.sqlite3'
            export_inline_history(store.path, backup_path)
            with closing(sqlite3.connect(backup_path)) as backup:
                self.assertEqual(json.loads(backup.execute('SELECT body FROM conversations').fetchone()[0]), record)

    def test_legacy_records_migrate_without_mutation_and_failed_saves_retry_assets(self):
        with tempfile.TemporaryDirectory() as folder:
            store = ConversationStore(folder, 'owner')
            record = {'title': 'legacy', 'updated_at': 'now', 'image_url': 'data:image/png;base64,old'}
            with store.connect() as db:
                db.execute('INSERT INTO conversations VALUES (?,?,?,?,?)', (store.owner, 'old', 'legacy', 'now', json.dumps(record)))
            self.assertEqual(store.read('old'), record)
            with patch.object(store, '_write_images', side_effect=sqlite3.OperationalError('disk full')):
                with self.assertRaises(sqlite3.Error):
                    store.save('old', record)
            self.assertFalse(store._saved_images)
            store.save('old', record)
            self.assertEqual(store.read('old'), record)
            self.assertIsInstance(record['image_url'], str)


class LiveCursorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'OPENAI_API_KEY': '', 'OPENAI_BASE_URL': 'http://127.0.0.1:1/v1',
            'INTERVIEW_WORKSPACE_HISTORY_DIR': self.folder.name})
        self.env.start()
        self.registry = InterviewRegistry()
        self.rt = await self.registry.create()
        self.reader = InterviewMaterials(self.registry)

    async def asyncTearDown(self):
        await self.registry.clear()
        self.env.stop()
        self.folder.cleanup()

    async def test_live_updates_skip_unread_history_but_history_remains_complete(self):
        for i in range(300):
            await self.rt.update_transcript('interviewer', str(i), f'old {i}', 'completed')
        first, _ = await self.reader.read()
        self.assertTrue(first['history_cursor'])
        self.assertIn('old 299', json.dumps(first))
        await self.rt.update_transcript('interviewer', '299', 'corrected current question', 'completed', corrected=True)
        await self.rt.update_transcript('candidate', 'new', 'followup question', 'completed')
        update, _ = await self.reader.read(cursor=first['updates_cursor'])
        self.assertEqual([row['text'] for row in update['records']], ['corrected current question', 'followup question'])
        self.assertFalse(update['has_more'])
        await self.rt.update_transcript('candidate', 'later', 'arrived after read', 'completed')
        replay, _ = await self.reader.read(cursor=first['updates_cursor'])
        self.assertEqual(replay, update)
        fresh, _ = await InterviewMaterials(self.registry).read(cursor=update['updates_cursor'])
        self.assertEqual([row['text'] for row in fresh['records']], ['arrived after read'])
        ids = {row.get('record_id', row['id']) for row in first['records']}
        cursor = first['history_cursor']
        while cursor:
            page, _ = await self.reader.read(cursor=cursor)
            ids.update(row.get('record_id', row['id']) for row in page['records'])
            cursor = page['next_cursor'] if page['has_more'] else None
        self.assertTrue({f'transcript:{i}' for i in range(300)} <= ids)

    async def test_update_overflow_and_old_record_corrections_are_not_lost(self):
        for i in range(200):
            await self.rt.update_transcript('interviewer', str(i), f'old {i}', 'completed')
        first, _ = await self.reader.read()
        await self.rt.update_transcript('interviewer', '0', 'corrected old requirement', 'completed', corrected=True)
        for i in range(200):
            await self.rt.update_transcript('candidate', f'new{i}', f'new {i}', 'completed')
        cursor, texts = first['updates_cursor'], []
        while True:
            page, _ = await self.reader.read(cursor=cursor)
            texts.extend(row['text'] for row in page['records'])
            cursor = page['next_cursor']
            if not page['has_more']:
                break
        self.assertEqual(set(texts), {f'new {i}' for i in range(200)} | {'corrected old requirement'})
        self.assertEqual(len(texts), 201)
        await self.rt.new_transcription('new-boundary')
        with self.assertRaisesRegex(ValueError, '游标'):
            await self.reader.read(cursor=cursor)


class StopOverlapTests(unittest.IsolatedAsyncioTestCase):
    async def test_stop_does_not_block_ping_and_answer_wait_can_be_cancelled(self):
        rt = make_runtime()
        entered, finish = asyncio.Event(), asyncio.Event()
        async def stopping():
            entered.set()
            await finish.wait()
            await rt.update_transcript('candidate', 'tail', 'complete tail', 'completed')
        rt._stop_transcription = stopping
        rt.send_to_ui_client = AsyncMock()
        socket = AsyncMock()
        socket.receive.side_effect = [
            {'type': 'websocket.receive', 'text': json.dumps({'type': 'stop_transcription'})},
            {'type': 'websocket.receive', 'text': json.dumps({'type': 'ping'})},
            {'type': 'websocket.disconnect'},
        ]
        await asyncio.wait_for(_forward_ui_controls(rt, socket), .5)
        await entered.wait()
        self.assertTrue(any(call.args[1].get('type') == 'pong' for call in rt.send_to_ui_client.call_args_list))
        provider = CodexProvider()
        rt.chat.host = provider.host
        request = asyncio.create_task(rt.chat.request('question', 'wait', selected=[]))
        for _ in range(100):
            if rt.chat.task:
                break
            await asyncio.sleep(.001)
        self.assertFalse(provider.inputs)
        await rt.chat.cancel()
        await asyncio.gather(request, return_exceptions=True)
        self.assertFalse(rt._transcription_stop_task.cancelled())
        self.assertFalse(rt._transcription_stop_task.done())
        finish.set()
        await rt.stop_transcription()
        await rt.chat.request('followup', 'next', selected=[])
        self.assertIn('complete tail', json.dumps(provider.inputs))
        await rt.close()
