import unittest

from lang import best_attempt, candidates, parse_hints, pick_language, retry_order


class ParseHints(unittest.TestCase):
    def test_keeps_codes_in_order_without_repeats(self):
        self.assertEqual(parse_hints("en,pt,EN, es"), ["en", "pt", "es"])

    def test_drops_anything_that_is_not_a_code(self):
        self.assertEqual(parse_hints("pt-BR,../x,,e n,fr"), ["fr"])
        self.assertEqual(parse_hints(None), [])
        self.assertEqual(parse_hints(""), [])


class Candidates(unittest.TestCase):
    def test_hints_first_then_the_fallback(self):
        self.assertEqual(candidates(["en"]), ["en", "pt", "es"])
        self.assertEqual(candidates([]), ["pt", "en", "es"])
        self.assertEqual(candidates(["fr", "es"]), ["fr", "es", "pt", "en"])


class PickLanguage(unittest.TestCase):
    def test_a_confident_detection_wins_over_the_hints(self):
        # English audio from someone whose app is in Portuguese.
        self.assertEqual(pick_language("en", 0.97, [("en", 0.97), ("pt", 0.01)], ["pt"], 0.6), "en")
        # Spanish audio, no hint at all.
        self.assertEqual(pick_language("es", 0.91, [("es", 0.91)], [], 0.6), "es")

    def test_an_unsure_detection_falls_to_the_likeliest_candidate(self):
        # A short clip whisper reads as Galician: Portuguese is the likeliest of the candidates.
        probs = [("gl", 0.40), ("pt", 0.35), ("es", 0.20)]
        self.assertEqual(pick_language("gl", 0.40, probs, ["en"], 0.6), "gl")
        probs = [("gl", 0.30), ("pt", 0.35), ("es", 0.20)]
        self.assertEqual(pick_language("gl", 0.30, probs, ["en"], 0.6), "pt")

    def test_a_tie_goes_to_the_client_language(self):
        probs = [("nn", 0.2), ("en", 0.3), ("pt", 0.3)]
        self.assertEqual(pick_language("nn", 0.2, probs, ["en"], 0.6), "en")
        self.assertEqual(pick_language("nn", 0.2, probs, ["pt"], 0.6), "pt")

    def test_a_candidate_without_probability_never_beats_the_detection(self):
        self.assertEqual(pick_language("de", 0.3, [("de", 0.3)], ["en"], 0.6), "de")


class Retry(unittest.TestCase):
    def test_the_other_candidates_in_order(self):
        self.assertEqual(retry_order("pt", ["en"]), ["en", "es"])
        self.assertEqual(retry_order("gl", []), ["pt", "en", "es"])

    def test_keeps_the_most_confident_spoken_attempt(self):
        attempts = [
            {"text": "", "language": "pt", "avg_logprob": -0.1},
            {"text": "hello there", "language": "en", "avg_logprob": -0.3},
            {"text": "jelou zer", "language": "es", "avg_logprob": -0.9},
        ]
        self.assertEqual(best_attempt(attempts)["language"], "en")

    def test_all_empty_keeps_the_first(self):
        attempts = [{"text": "", "language": "pt", "avg_logprob": -1.0}, {"text": "", "language": "en", "avg_logprob": -0.2}]
        self.assertEqual(best_attempt(attempts)["language"], "pt")


if __name__ == "__main__":
    unittest.main()
