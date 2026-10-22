"""Ask Phoebe's evaluation set: the questions, the recordings and the
fingerprint that ties a recording to the prompt it was made with.

How the evaluation works (decision log, Oct 22):
- `manage.py run_ask_eval` asks every question in eval/questions.json for
  real, on the Mac with the dev key, and saves each full reply (answer and
  tool results) in eval/recordings/<model>.json. CI never calls Claude.
- On every PR, Vitest (frontend/src/eval/) scores the recordings with the
  same verifyAnswer() the drawer uses, and fails if the gate model's score
  drops below `min_score`.
- test_evaluation.py fails if the system prompt, the tool definitions or the
  loop's limits change without a fresh recording, so a prompt change can't
  merge until it has been re-scored.
"""

import hashlib
import json
from decimal import Decimal
from pathlib import Path

from .service import MAX_OUTPUT_TOKENS, MAX_ROUNDS, MAX_TOOL_CALLS, SYSTEM_PROMPT
from .tools import TOOL_DEFINITIONS

EVAL_DIR = Path(__file__).resolve().parent / "eval"
QUESTIONS_PATH = EVAL_DIR / "questions.json"
RECORDINGS_DIR = EVAL_DIR / "recordings"

EXPECT_TYPES = {"passes", "satellite", "ask_city", "decline"}

# Opus 5.5 dollars per question, measured Oct 21 ($0.026 to $0.035 for a
# passes question). Other models scale by their input price. Used for the
# estimate and to stop before the cap, never for billing.
OPUS_ESTIMATE_USD = {
    "passes": Decimal("0.035"),
    "clouds": Decimal("0.05"),
    "satellite": Decimal("0.03"),
    "ask_city": Decimal("0.015"),
    "decline": Decimal("0.015"),
}


def fingerprint():
    """A short hash of everything that shapes an answer apart from the model
    and the data: the system prompt, the tool definitions and the loop's
    limits. The model is stored next to it in each recording."""
    setup = {
        "system_prompt": SYSTEM_PROMPT,
        "tools": TOOL_DEFINITIONS,
        "limits": [MAX_ROUNDS, MAX_TOOL_CALLS, MAX_OUTPUT_TOKENS],
    }
    text = json.dumps(setup, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def load_questions(path=None):
    with open(path or QUESTIONS_PATH, encoding="utf-8") as f:
        return json.load(f)


def recording_path(model, directory=None):
    return Path(directory or RECORDINGS_DIR) / f"{model}.json"


def load_recording(model, directory=None):
    path = recording_path(model, directory)
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def estimate_usd(question, model_input_price):
    """Rough cost of one question for a model with this input price ($/M)."""
    expect = question["expect"]
    kind = "clouds" if expect.get("clouds") else expect["type"]
    return OPUS_ESTIMATE_USD[kind] * model_input_price / Decimal(4)
