import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("laya-swarm-eval.py")
SPEC = importlib.util.spec_from_file_location("laya_swarm_eval", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class LayaQualityAssessmentTests(unittest.TestCase):
    def test_small_high_error_sample_is_exploratory_and_not_production_eligible(self):
        result = MODULE.assess_quality(8, 0.81705, 0)
        self.assertEqual(result["status"], "exploratory_only")
        self.assertFalse(result["production_eligible"])
        self.assertEqual(result["reason_codes"], [
            "calibration_sample_below_100",
            "calibration_error_above_0.10_or_unavailable",
        ])

    def test_large_clean_sample_still_requires_external_acceptance(self):
        result = MODULE.assess_quality(128, 0.05, 0)
        self.assertEqual(result["status"], "candidate_for_larger_evaluation")
        self.assertFalse(result["production_eligible"])
        self.assertEqual(result["reason_codes"], ["production_acceptance_requires_external_validation"])

    def test_any_false_acceptance_blocks_quality_candidate(self):
        result = MODULE.assess_quality(128, 0.05, 1)
        self.assertEqual(result["status"], "exploratory_only")
        self.assertIn("false_acceptance_observed", result["reason_codes"])


if __name__ == "__main__":
    unittest.main()
