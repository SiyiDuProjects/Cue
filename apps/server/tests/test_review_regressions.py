import unittest
from app.config import Settings, get_settings
from unittest.mock import patch
from app.services.realtime_history import InterviewHistory

class ReviewPureTests(unittest.TestCase):
    def test_question_correction_replaces_prior_segments_then_appends(self):
        history = InterviewHistory()
        history.add_turn("interviewer", "First", question_id="q", turn_id="a")
        history.add_turn("interviewer", "second", question_id="q")
        history.add_turn("interviewer", "Corrected", question_id="q", corrects_turn_id="a")
        history.add_turn("interviewer", "details", question_id="q")
        self.assertEqual(history.question_text("q"), "Corrected details")
        self.assertEqual(history.questions()[0]["text"], "Corrected details")

    def test_default_reasoning_budget_matches_project_contract(self):
        self.assertEqual(Settings().openai_code_max_output_tokens, 32768)
        with patch("app.config._load_dotenv"), patch.dict("os.environ", {}, clear=True):
            self.assertEqual(get_settings().openai_code_max_output_tokens, 32768)
