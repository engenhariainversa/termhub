import unittest

from auth import authorized


class Authorized(unittest.TestCase):
    def test_needs_the_exact_bearer(self):
        self.assertTrue(authorized("Bearer s3cret", "s3cret"))
        self.assertFalse(authorized("Bearer nope", "s3cret"))
        self.assertFalse(authorized("s3cret", "s3cret"))
        self.assertFalse(authorized(None, "s3cret"))

    def test_empty_secret_refuses_everything(self):
        self.assertFalse(authorized("Bearer ", ""))
        self.assertFalse(authorized(None, ""))

    def test_non_ascii_header_is_refused_not_raised(self):
        self.assertFalse(authorized("Bearer sécret", "s3cret"))


if __name__ == "__main__":
    unittest.main()
