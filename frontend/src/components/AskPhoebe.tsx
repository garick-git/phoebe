"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import PassCard from "./PassCard";
import {
  AskError,
  askErrorMessage,
  MAX_QUESTION_LENGTH,
  MIN_QUESTION_LENGTH,
  noVisibleText,
  passGroups,
  postAsk,
  type AskResponse,
  type PassGroup,
} from "@/lib/ask";
import { fetchCloudForecast } from "@/lib/forecast";
import { buildPassCards, zoneName } from "@/lib/plainPass";
import { verifyAnswer, type Verification } from "@/lib/verifyAnswer";
import type { ForecastState } from "@/lib/viewing";

const EXAMPLES = [
  "When can I see the ISS from Austin this week?",
  "Will it be clear enough to see Tiangong from Chicago tonight?",
];

type Answered = {
  status: "done";
  id: number;
  question: string;
  response: AskResponse;
  verification: Verification;
  groups: PassGroup[];
  /** When the answer arrived: "now" for the cards' day labels and ended passes. */
  at: number;
  /** Cloud forecast per place (`placeKey`), fetched in the browser like Tonight's. */
  forecasts: Record<string, ForecastState>;
};

type State =
  | { status: "idle" }
  | { status: "loading"; id: number; question: string }
  | { status: "error"; id: number; question: string; message: string }
  | Answered;

const FORECAST_LOADING: ForecastState = { status: "loading" };

function placeKey(group: PassGroup): string {
  return `${group.place.latitude},${group.place.longitude}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What the screen reader hears when the request settles (the answer itself isn't a live region). */
function statusText(state: State, cardCount: number): string {
  if (state.status === "loading") return "Asking Phoebe…";
  if (state.status === "error") return state.message;
  if (state.status === "idle") return "";
  const cards = cardCount ? ` ${plural(cardCount, "visible pass", "visible passes")} shown as cards.` : "";
  return state.verification.ok
    ? `Answer ready.${cards}`
    : `Phoebe's answer couldn't be double-checked, so its pass data is shown instead.${cards}`;
}

function GroupCards({ group, at, forecast }: { group: PassGroup; at: number; forecast: ForecastState }) {
  const { tonight, later } = buildPassCards(
    [{ noradId: group.noradId, nickname: group.satellite, passes: group.visible }],
    at,
    group.place.timezone,
    forecast,
  );
  const cards = [...tonight, ...later];
  const span = group.days === 1 ? "next day" : `next ${group.days} days`;
  return (
    <section aria-labelledby={`ask-group-${group.key}`} className="mt-6">
      <h4 id={`ask-group-${group.key}`} className="text-base font-semibold text-ink">
        {group.satellite} from {group.place.label}
      </h4>
      <p className="mt-1 text-sm text-muted">
        Visible passes in the {span}. Times are {zoneName(group.place.timezone, at)}.
      </p>
      {cards.length > 0 ? (
        <ol className="mt-3 space-y-3">
          {cards.map((card) => (
            <li key={card.key}>
              <PassCard card={card} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 rounded-xl border border-line bg-surface p-4 text-base text-ink">
          {group.visible.length > 0 ? "Those passes have already ended." : noVisibleText(group)}
        </p>
      )}
    </section>
  );
}

function AnswerView({ state }: { state: Answered }) {
  const { response, verification, groups } = state;
  return (
    <div>
      {verification.ok ? (
        <>
          {/* Plain text from the model, rendered as text (React escapes it); its "- " lines stay as lines. */}
          <p className="whitespace-pre-line text-base leading-relaxed text-ink">{response.answer}</p>
          {!response.complete && (
            <p className="mt-3 text-sm text-muted">
              Phoebe stopped before finishing this one. Try a shorter or simpler question.
            </p>
          )}
          {verification.checked > 0 && (
            <p className="mt-3 flex items-center gap-2 text-sm text-muted">
              <span aria-hidden="true" className="font-bold text-accent">
                ✓
              </span>
              Times and numbers checked against Phoebe’s pass data.
            </p>
          )}
        </>
      ) : (
        <p className="rounded-xl border border-line bg-surface p-4 text-base text-ink">
          {groups.length > 0
            ? "I couldn’t double-check that answer against Phoebe’s data, so here are the passes straight from it."
            : "I couldn’t double-check that answer against Phoebe’s data, so I’m not showing it. Try asking another way, with a satellite and a city."}
        </p>
      )}
      {groups.map((group) => (
        <GroupCards
          key={group.key}
          group={group}
          at={state.at}
          forecast={state.forecasts[placeKey(group)] ?? FORECAST_LOADING}
        />
      ))}
    </div>
  );
}

/**
 * Ask Phoebe's content: one question at a time (the API takes no history, so
 * nobody can forge earlier turns), the answer only after verifyAnswer() has
 * checked its times and numbers against the tool results, and pass cards from
 * those same results. If the check fails, the cards are shown instead of the
 * answer (brief, week 4).
 */
export default function AskPhoebe() {
  const [question, setQuestion] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [state, setState] = useState<State>({ status: "idle" });
  const controllerRef = useRef<AbortController | null>(null);
  const nextId = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // Leaving the page cancels a question still in flight (closing the drawer doesn't).
  useEffect(() => () => controllerRef.current?.abort(), []);

  const loading = state.status === "loading";

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // aria-disabled instead of disabled, so the button keeps keyboard focus;
    // the guard here does the disabling.
    if (loading) return;
    const text = question.trim();
    if (text.length < MIN_QUESTION_LENGTH) {
      setInputError("Type a question first, for example one of the examples above.");
      inputRef.current?.focus();
      return;
    }
    setInputError(null);

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const id = ++nextId.current;
    setState({ status: "loading", id, question: text });
    setQuestion("");

    let response: AskResponse;
    try {
      response = await postAsk(text, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = askErrorMessage(error instanceof AskError ? error : new AskError(null));
      setState({ status: "error", id, question: text, message });
      setQuestion(text); // so trying again is one tap
      return;
    }

    const groups = passGroups(response.tools);
    setState({
      status: "done",
      id,
      question: text,
      response,
      verification: verifyAnswer(response.answer, response.tools),
      groups,
      at: Date.now(),
      forecasts: {},
    });
    resultRef.current?.scrollTo?.({ top: 0 });

    // Cloud ratings for the cards: one request per place with visible passes.
    // A failure only changes the cards' rating line to "unavailable".
    const places = new Map(groups.filter((g) => g.visible.length > 0).map((g) => [placeKey(g), g.place]));
    for (const [key, place] of places) {
      const record = (forecast: ForecastState) =>
        setState((prev) =>
          prev.status === "done" && prev.id === id
            ? { ...prev, forecasts: { ...prev.forecasts, [key]: forecast } }
            : prev,
        );
      fetchCloudForecast(place.latitude, place.longitude, controller.signal).then(
        (forecast) => record({ status: "ok", forecast }),
        () => {
          if (!controller.signal.aborted) record({ status: "error" });
        },
      );
    }
  }

  function fillExample(text: string) {
    setQuestion(text);
    setInputError(null);
    inputRef.current?.focus();
  }

  const cardCount =
    state.status === "done" ? state.groups.reduce((n, g) => n + g.visible.length, 0) : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={resultRef} className="flex-1 overflow-y-auto px-5 py-6">
        {state.status === "idle" ? (
          <div className="space-y-4 text-sm leading-relaxed text-muted">
            <p>Ask about seeing a satellite from a city, in plain English. For example:</p>
            <ul className="space-y-2">
              {EXAMPLES.map((text) => (
                <li key={text}>
                  <button
                    type="button"
                    onClick={() => fillExample(text)}
                    className="min-h-11 w-full rounded-lg bg-raised px-4 py-3 text-left text-ink hover:bg-line"
                  >
                    “{text}”
                  </button>
                </li>
              ))}
            </ul>
            <p>Each question is answered on its own, so name the satellite and the city every time.</p>
          </div>
        ) : (
          <div aria-busy={loading}>
            <p className="text-sm text-muted">You asked</p>
            <p className="mt-1 text-base font-medium text-ink">{state.question}</p>
            <div className="mt-4">
              {state.status === "loading" && (
                <div aria-hidden="true">
                  <p className="text-sm text-muted">Checking the sky… this can take up to a minute.</p>
                  <div className="mt-3 h-24 rounded-xl border border-line bg-surface motion-safe:animate-pulse" />
                </div>
              )}
              {state.status === "error" && (
                <p className="rounded-xl border border-line bg-surface p-4 text-base text-ink">{state.message}</p>
              )}
              {state.status === "done" && <AnswerView state={state} />}
            </div>
          </div>
        )}
        <p role="status" className="sr-only">
          {statusText(state, cardCount)}
        </p>
      </div>

      <form onSubmit={ask} noValidate className="border-t border-line px-5 pb-5 pt-4">
        <label htmlFor="ask-question" className="sr-only">
          Your question
        </label>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            id="ask-question"
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={MAX_QUESTION_LENGTH}
            enterKeyHint="send"
            autoComplete="off"
            placeholder="When can I see the ISS from…"
            aria-invalid={inputError ? true : undefined}
            aria-describedby={inputError ? "ask-question-error ask-question-note" : "ask-question-note"}
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-base text-ink placeholder:text-muted"
          />
          <button
            type="submit"
            aria-disabled={loading}
            className="min-h-11 shrink-0 rounded-lg bg-accent px-4 font-semibold text-accent-ink aria-disabled:opacity-60"
          >
            {loading ? "Asking…" : "Ask"}
          </button>
        </div>
        {inputError && (
          <p id="ask-question-error" className="mt-2 text-sm text-ink">
            {inputError}
          </p>
        )}
        <p id="ask-question-note" className="mt-2 text-xs text-muted">
          Answered by Claude (Anthropic) from Phoebe’s data. Don’t include personal details.
        </p>
      </form>
    </div>
  );
}
