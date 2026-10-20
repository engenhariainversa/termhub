"""Shared-secret check for the whisper service (no model import, so it is testable anywhere)."""
import hmac


def authorized(header: str | None, secret: str) -> bool:
    """An empty secret refuses every request: the service must never run open on the network."""
    if not secret or not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[len("Bearer "):].encode(), secret.encode())
