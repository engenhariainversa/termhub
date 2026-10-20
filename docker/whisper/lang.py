"""Which language to transcribe in (TER-1096), with no model import so it is testable anywhere.

Whisper forced to one language turns speech in another into an empty, wrong or translated text.
So the service detects the spoken language; when the detection is unsure (a short or noisy clip),
the caller's hints (the client's language, then the account's) and the languages termhub's users
speak decide among the likely ones.
"""
import re

# Tried after the caller's hints, in this order, when the detection is unsure or the text comes out empty.
FALLBACK = ("pt", "en", "es")
_CODE = re.compile(r"^[a-z]{2,3}$")


def parse_hints(raw: str | None) -> list[str]:
    """`en,pt` -> ["en", "pt"]: lowercase language codes, deduplicated, anything else dropped."""
    out: list[str] = []
    for part in (raw or "").split(","):
        code = part.strip().lower()
        if _CODE.match(code) and code not in out:
            out.append(code)
    return out[:5]


def candidates(hints: list[str]) -> list[str]:
    """The hints, then the fallback languages not already among them."""
    return hints + [c for c in FALLBACK if c not in hints]


def pick_language(detected: str, probability: float, all_probs: list[tuple[str, float]], hints: list[str], threshold: float) -> str:
    """The detected language when whisper is sure of it; otherwise the likeliest of the candidates.

    A candidate the detection gave no probability to never beats the detected language, and on a
    tie the earlier candidate (the client's language) wins.
    """
    if probability >= threshold:
        return detected
    probs = dict(all_probs)
    best, best_p = detected, probability
    for code in candidates(hints):
        p = probs.get(code, 0.0)
        if p > best_p:
            best, best_p = code, p
    return best


def retry_order(chosen: str, hints: list[str]) -> list[str]:
    """The candidates still worth a try after `chosen` gave an empty text."""
    return [c for c in candidates(hints) if c != chosen]


def best_attempt(attempts: list[dict]) -> dict:
    """Of several transcriptions, the non-empty one whisper was the most confident in (`avg_logprob`)."""
    spoken = [a for a in attempts if a["text"]]
    if not spoken:
        return attempts[0]
    return max(spoken, key=lambda a: a["avg_logprob"])
