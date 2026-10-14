import unittest

from extract_ai_studio_messages import extract, last_transcript_timestamp


class ExtractAiStudioMessagesTest(unittest.TestCase):
    def test_resume_excludes_boundary_thoughts_and_nonconversation_chunks(self):
        chunks = [
            {"role": "user", "text": "Old user", "createTime": "t0"},
            {"role": "model", "text": "Old answer", "createTime": "t1"},
            {"role": "model", "text": "private reasoning", "isThought": True, "createTime": "t2"},
            {"role": "tool", "text": "tool output", "createTime": "t3"},
            {"role": "user", "text": "New user", "createTime": "t4"},
            {"role": "model", "text": "New answer", "createTime": "t5"},
            {"role": "model", "text": "", "createTime": "t6"},
        ]
        transcript = "[USER] [t0]\nOld user\n\n[AI MODEL] [t1]\nOld answer"
        self.assertEqual(last_transcript_timestamp(transcript), "t1")
        self.assertEqual(extract(chunks, after_timestamp="t1"), [
            ("user", "t4", "New user"),
            ("model", "t5", "New answer"),
        ])

    def test_start_marker_remains_inclusive_for_original_extraction_workflow(self):
        chunks = [
            {"role": "user", "text": "before start", "createTime": "t0"},
            {"role": "user", "text": "Chosen marker", "createTime": "t1"},
        ]
        self.assertEqual(extract(chunks, marker="chosen marker"), [("user", "t1", "Chosen marker")])


if __name__ == "__main__":
    unittest.main()
