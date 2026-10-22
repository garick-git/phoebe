"""The evaluation set's guard rails (decision log, Oct 22).

The scoring itself runs in Vitest (frontend/src/eval/), with the same
verifyAnswer() the drawer uses. These tests make sure what it scores is
current: the gate model's recording must have been made with today's system
prompt, tool definitions and limits, and must answer every question. They
also check that run_ask_eval can't spend money by accident. No test here
calls Claude (conftest.py's NoRealClaude would fail it).
"""

import json
from decimal import Decimal

import pytest
from django.conf import settings
from django.core.management import CommandError, call_command

from ask import evaluation

from .conftest import final

RERUN = (
    "Re-record it on the Mac (real money: about $0.30 on Sonnet 5.5, $0.65 on "
    "Opus 5.5; dry run first for the estimate): docker compose exec web python "
    "manage.py run_ask_eval --model {model} --max-usd <estimate + 10%> --spend, "
    "then commit the recording and "
    "check the score with `npx vitest run src/eval` in frontend/."
)


def test_questions_are_well_formed():
    data = evaluation.load_questions()
    questions = data["questions"]
    ids = [q["id"] for q in questions]
    assert len(ids) == len(set(ids)), "question ids must be unique"
    assert 15 <= len(questions) <= 25, "keep the set about 20 questions (each one costs money)"
    for q in questions:
        expect = q["expect"]
        assert expect["type"] in evaluation.EXPECT_TYPES, q["id"]
        if expect["type"] == "passes":
            assert isinstance(expect["satellite"], int), q["id"]
            assert expect["place"]["asked"] and expect["place"]["label"], q["id"]
    assert data["gate_model"] in {"claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"}


def test_the_gate_model_is_the_one_in_production():
    """The score that gates CI must be the model visitors get."""
    assert evaluation.load_questions()["gate_model"] == settings.ASK_PHOEBE_MODEL


def test_gate_recording_matches_the_current_prompt():
    data = evaluation.load_questions()
    model = data["gate_model"]
    recording = evaluation.load_recording(model)
    assert recording is not None, f"No recording for {model}. " + RERUN.format(model=model)
    assert recording["model"] == model
    assert recording["fingerprint"] == evaluation.fingerprint(), (
        "The system prompt, tool definitions or loop limits changed since the "
        "evaluation was recorded. " + RERUN.format(model=model)
    )


def test_gate_recording_answers_every_question():
    data = evaluation.load_questions()
    model = data["gate_model"]
    recording = evaluation.load_recording(model)
    assert recording is not None
    asked = {r["id"]: r["question"] for r in recording["replies"]}
    expected = {q["id"]: q["question"] for q in data["questions"]}
    assert asked == expected, (
        "The questions changed since the recording (added, removed or reworded). "
        + RERUN.format(model=model)
    )


def test_fingerprint_changes_with_the_prompt(monkeypatch):
    before = evaluation.fingerprint()
    monkeypatch.setattr(evaluation, "SYSTEM_PROMPT", evaluation.SYSTEM_PROMPT + " Be terse.")
    assert evaluation.fingerprint() != before


# --- run_ask_eval: no accidental spending -------------------------------------


@pytest.fixture
def two_questions(tmp_path, monkeypatch):
    """A two-question set and a temporary recordings folder."""
    questions = {
        "gate_model": "claude-opus-5-5",
        "min_score": None,
        "questions": [
            {"id": "off-topic", "question": "Best pizza?", "expect": {"type": "decline"}},
            {"id": "no-city", "question": "When is the ISS up?", "expect": {"type": "ask_city"}},
        ],
    }
    path = tmp_path / "questions.json"
    path.write_text(json.dumps(questions))
    monkeypatch.setattr(evaluation, "QUESTIONS_PATH", path)
    monkeypatch.setattr(evaluation, "RECORDINGS_DIR", tmp_path / "recordings")
    monkeypatch.delenv("CI", raising=False)
    return tmp_path


def test_refuses_to_run_in_ci(two_questions, monkeypatch):
    monkeypatch.setenv("CI", "true")
    with pytest.raises(CommandError, match="never runs in CI"):
        call_command("run_ask_eval", model="claude-opus-5-5", spend=True, max_usd=Decimal("1"))


def test_dry_run_sends_nothing(two_questions, capsys):
    # NoRealClaude (conftest) would fail the test if anything were sent.
    call_command("run_ask_eval", model="claude-opus-5-5")
    assert "Dry run" in capsys.readouterr().out
    assert not (two_questions / "recordings").exists()


@pytest.mark.parametrize("cap", [None, Decimal("0"), Decimal("7.2")])
def test_spend_needs_a_sensible_cap(two_questions, cap):
    with pytest.raises(CommandError, match="max-usd"):
        call_command("run_ask_eval", model="claude-opus-5-5", spend=True, max_usd=cap)


def test_unknown_model_is_refused(two_questions):
    with pytest.raises(CommandError, match="no price"):
        call_command("run_ask_eval", model="claude-opus-9")


@pytest.mark.django_db
def test_records_every_reply_with_its_cost(two_questions, fake_claude, settings):
    settings.ASK_PHOEBE_DAILY_BUDGET_USD = Decimal("0")  # lifted inside the command
    fake = fake_claude(
        final("I can only help with satellite viewing.", usage=(2000, 20)),
        final("Which city are you in?", usage=(2000, 10)),
    )
    call_command("run_ask_eval", model="claude-sonnet-5-5", spend=True, max_usd=Decimal("0.10"))

    assert [r["model"] for r in fake.requests] == ["claude-sonnet-5-5"] * 2
    recording = evaluation.load_recording("claude-sonnet-5-5")
    assert recording["fingerprint"] == evaluation.fingerprint()
    assert [r["id"] for r in recording["replies"]] == ["off-topic", "no-city"]
    first = recording["replies"][0]
    assert first["answer"] == "I can only help with satellite viewing."
    assert first["complete"] is True and first["error"] is None
    assert first["cost_usd"] == "0.0042"  # 2000 x $2/M + 20 x $10/M
    assert recording["cost_usd"] == "0.0083"


@pytest.mark.django_db
def test_stops_before_passing_the_cap(two_questions, fake_claude):
    fake = fake_claude(final("Only satellites, sorry."))
    # Opus estimate for a decline question is $0.015; a $0.02 cap fits one.
    call_command("run_ask_eval", model="claude-opus-5-5", spend=True, max_usd=Decimal("0.02"))
    assert len(fake.requests) == 1
    recording = evaluation.load_recording("claude-opus-5-5")
    assert [r["id"] for r in recording["replies"]] == ["off-topic"]


@pytest.mark.django_db
def test_only_reasks_some_and_keeps_the_rest(two_questions, fake_claude):
    fake_claude(final("Only satellites."), final("Which city?"))
    call_command("run_ask_eval", model="claude-opus-5-5", spend=True, max_usd=Decimal("0.10"))
    fake_claude(final("Which city are you in?"))
    call_command(
        "run_ask_eval", model="claude-opus-5-5", spend=True, max_usd=Decimal("0.10"), only="no-city"
    )
    replies = evaluation.load_recording("claude-opus-5-5")["replies"]
    assert [r["answer"] for r in replies] == ["Only satellites.", "Which city are you in?"]
