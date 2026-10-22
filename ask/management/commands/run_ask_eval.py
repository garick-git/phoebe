"""Ask the evaluation questions for real and record every reply.

    # Dry run (default): list the questions and the estimate, send nothing.
    docker compose exec web python manage.py run_ask_eval --model claude-opus-5-5

    # Spend: ask them all, stopping before the cap is passed.
    docker compose exec web python manage.py run_ask_eval --model claude-opus-5-5 --max-usd 0.72 --spend

    # Re-ask a few (same prompt fingerprint only), keeping the other replies.
    ... --only iss-chicago-3d,off-topic --max-usd 0.10 --spend

Real money (about $0.014 a question on Sonnet 5.5, $0.03 on Opus 5.5; the
full set cost $0.28 and $0.62 on Oct 22), so it refuses to run in CI,
needs --spend and a --max-usd cap, and saves after every question so a
failure never loses replies already paid for. Score the result with
`npx vitest run src/eval` in frontend/.
"""

import json
import os
from datetime import datetime, timezone
from decimal import Decimal

from django.core.management.base import BaseCommand, CommandError
from django.test.utils import override_settings

from ask import budget, evaluation, service
from ask.claude import ClaudeError

# A hard ceiling for --max-usd, so a typo ("7.2") can't spend the credits.
MAX_ALLOWED_USD = Decimal("2.00")


class Command(BaseCommand):
    help = "Ask Ask Phoebe's evaluation questions for real (costs money) and record the replies."

    def add_arguments(self, parser):
        parser.add_argument("--model", required=True, help="e.g. claude-opus-5-5")
        parser.add_argument("--max-usd", type=Decimal, help="Stop before spending more than this.")
        parser.add_argument("--only", help="Comma-separated question ids to (re-)ask.")
        parser.add_argument(
            "--spend", action="store_true", help="Actually call Claude (without it: dry run)."
        )

    def handle(self, *args, **options):
        if os.environ.get("CI"):
            raise CommandError("run_ask_eval never runs in CI: it calls the real Claude API.")

        model = options["model"]
        if model not in budget.PRICES_PER_MILLION:
            raise CommandError(f"{model!r} has no price in ask/budget.py.")
        input_price = budget.PRICES_PER_MILLION[model][0]

        questions = evaluation.load_questions()["questions"]
        if options["only"]:
            wanted = {q.strip() for q in options["only"].split(",") if q.strip()}
            unknown = wanted - {q["id"] for q in questions}
            if unknown:
                raise CommandError(f"Unknown question ids: {', '.join(sorted(unknown))}")
            questions = [q for q in questions if q["id"] in wanted]

        fingerprint = evaluation.fingerprint()
        recording = evaluation.load_recording(model)
        if options["only"]:
            if recording is None or recording.get("fingerprint") != fingerprint:
                raise CommandError(
                    "--only needs an existing recording made with the current prompt; "
                    "run every question instead."
                )
        else:
            recording = None  # a full run starts a fresh recording

        estimate = sum(evaluation.estimate_usd(q, input_price) for q in questions)
        self.stdout.write(
            f"{len(questions)} questions on {model}, estimated ${estimate:.2f} "
            f"(prompt fingerprint {fingerprint})"
        )

        if not options["spend"]:
            for q in questions:
                self.stdout.write(f"  {q['id']}: {q['question']}")
            self.stdout.write("Dry run: nothing sent. Add --max-usd <dollars> --spend to ask them.")
            return

        cap = options["max_usd"]
        if cap is None:
            raise CommandError("--spend needs --max-usd, for example --max-usd 0.72.")
        if cap <= 0 or cap > MAX_ALLOWED_USD:
            raise CommandError(f"--max-usd must be above 0 and at most {MAX_ALLOWED_USD}.")
        if service.get_client() is None:
            raise CommandError("No ANTHROPIC_API_KEY in this environment.")

        if recording is None:
            recording = {"model": model, "fingerprint": fingerprint, "replies": []}
        replies = {r["id"]: r for r in recording["replies"]}

        spent = Decimal(0)
        stopped = None
        # This command has its own cap, so the site's daily budget (meant to
        # share a month across visitors) is lifted for this process only.
        with override_settings(ASK_PHOEBE_MODEL=model, ASK_PHOEBE_DAILY_BUDGET_USD=Decimal("1000")):
            for q in questions:
                next_estimate = evaluation.estimate_usd(q, input_price)
                if spent + next_estimate > cap:
                    stopped = f"the next question could pass the ${cap} cap"
                    break
                asked_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
                try:
                    reply = service.answer(q["question"])
                    error = None
                except ClaudeError as e:
                    reply, error = None, e.kind
                except service.AskUnavailable as e:
                    reply, error = None, e.kind

                usage = (reply or {}).get("usage") or {}
                cost = budget.cost_of(usage, model) if usage else Decimal(0)
                # A failed question may have paid for calls before failing;
                # count its estimate so the cap stays conservative.
                spent += cost if reply else next_estimate
                replies[q["id"]] = {
                    "id": q["id"],
                    "question": q["question"],
                    "asked_at": asked_at,
                    "answer": (reply or {}).get("answer", ""),
                    "complete": bool((reply or {}).get("complete")),
                    "tools": (reply or {}).get("tools", []),
                    "usage": usage,
                    "cost_usd": f"{cost:.4f}",
                    "error": error,
                }
                self._save(recording, replies, model)
                tools = ", ".join(t["name"] for t in replies[q["id"]]["tools"]) or "no tools"
                status = f"error: {error}" if error else tools
                self.stdout.write(f"  {q['id']}: {status} (${cost:.4f}, total ${spent:.4f})")
                if error in ("spend_limit", "config"):
                    stopped = f"Claude returned {error}"
                    break

        path = evaluation.recording_path(model)
        if stopped:
            self.stdout.write(self.style.WARNING(f"Stopped early: {stopped}."))
        self.stdout.write(
            self.style.SUCCESS(f"Spent ${spent:.4f}. Saved {len(replies)} replies to {path.name}.")
        )
        self.stdout.write("Score them: cd frontend && npx vitest run src/eval")

    def _save(self, recording, replies, model):
        """Write the recording in question order, atomically, after every reply."""
        order = [q["id"] for q in evaluation.load_questions()["questions"]]
        recording["replies"] = sorted(
            replies.values(), key=lambda r: order.index(r["id"]) if r["id"] in order else len(order)
        )
        recording["recorded_at"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
        recording["cost_usd"] = f"{sum(Decimal(r['cost_usd']) for r in recording['replies']):.4f}"
        path = evaluation.recording_path(model)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(recording, f, indent=1, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
