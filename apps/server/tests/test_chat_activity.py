import unittest
from unittest.mock import AsyncMock
from app.services.chat_activity import record_activity, finish_activities
from tests.test_realtime import make_runtime

class ActivityTests(unittest.IsolatedAsyncioTestCase):
    async def test_activity_dedup_terminal_order_bounds_and_private_fields(self):
        rt = make_runtime('activity')
        rt._broadcast_clients_locked = AsyncMock()
        try:
            item = {'id':'a','label':'读取 resume.txt','kind':'command','status':'running','output':'PRIVATE'}
            await record_activity(rt,'r',item)
            await record_activity(rt,'r',{**item,'status':'completed'})
            await record_activity(rt,'r',item)
            entries = rt._response_metadata['r']['activities']
            self.assertEqual(len(entries),1)
            self.assertEqual(entries[0]['status'],'completed')
            self.assertNotIn('output',entries[0])
            for i in range(100): await record_activity(rt,'r',{**item,'id':str(i)})
            self.assertEqual(len(entries),80)
            finish_activities(rt._response_metadata['r'])
            self.assertEqual(entries[1]['status'],'interrupted')
            rt.terminal_responses.add('r')
            await record_activity(rt,'r',{**item,'id':'late'})
            self.assertEqual(len(entries),80)
        finally:
            await rt.close()
