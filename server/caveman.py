# server/caveman.py
"""Caveman output-style system prompt injection.

inject_caveman(body, level) prepends a terse-style instruction to the system
message so the model responds with fewer tokens. Mutates body in-place.
"""

VALID_LEVELS = frozenset({'lite', 'full', 'ultra'})

_SHARED_BOUNDARIES = (
    "Code blocks, file paths, commands, errors, URLs: keep exact. "
    "Security warnings, irreversible action confirmations, multi-step ordered sequences: "
    "write normal. Resume terse style after."
)
_SHARED_EXAMPLES = (
    'Not: "Sure! I\'d be happy to help you with that. The issue you\'re experiencing is likely caused by..." '
    'Yes: "Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:"'
)
_SHARED_AUTO_CLARITY = (
    "Auto-Clarity: drop caveman for security warnings, irreversible actions, multi-step sequences "
    "where fragment ambiguity risks misread, or when user repeats a question. Resume after the clear part."
)
_SHARED_PERSISTENCE = "ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Still active if unsure."

CAVEMAN_PROMPTS = {
    'lite': ' '.join([
        "Respond tersely. Keep grammar and full sentences but drop filler, hedging and pleasantries "
        "(just/really/basically/sure/of course/I'd be happy to).",
        "Pattern: state the thing, the action, the reason. Then next step.",
        _SHARED_EXAMPLES, _SHARED_BOUNDARIES, _SHARED_AUTO_CLARITY, _SHARED_PERSISTENCE,
    ]),
    'full': ' '.join([
        "Respond like terse caveman. All technical substance stay exact, only fluff die.",
        "Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries, hedging. "
        "Fragments OK. Short synonyms (big not extensive, fix not implement a solution for).",
        "Pattern: [thing] [action] [reason]. [next step].",
        _SHARED_EXAMPLES, _SHARED_BOUNDARIES, _SHARED_AUTO_CLARITY, _SHARED_PERSISTENCE,
    ]),
    'ultra': ' '.join([
        "Respond ultra-terse. Maximum compression. Telegraphic.",
        "Abbreviate (DB/auth/config/req/res/fn/impl), strip conjunctions, use arrows for causality (X → Y). "
        "One word when one word enough.",
        "Pattern: [thing] → [result]. [fix].",
        _SHARED_EXAMPLES, _SHARED_BOUNDARIES, _SHARED_AUTO_CLARITY, _SHARED_PERSISTENCE,
    ]),
}


def inject_caveman(body: dict, level: str) -> None:
    """Inject caveman prompt into body['messages'] system message. Mutates in-place."""
    if level not in VALID_LEVELS:
        return
    messages = body.get('messages')
    if not isinstance(messages, list) or not messages:
        return
    prompt = CAVEMAN_PROMPTS[level]
    if messages[0].get('role') == 'system':
        existing = messages[0].get('content') or ''
        messages[0] = {**messages[0], 'content': f"{existing}\n\n{prompt}".lstrip()}
    else:
        messages.insert(0, {'role': 'system', 'content': prompt})
