import type { QuizQuestion } from "../shared/types.ts";
import { isRecord } from "./http.ts";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function toQuestion(item: unknown): QuizQuestion | null {
  if (!isRecord(item)) return null;
  const { question, options, answer, why } = item;
  if (!nonEmpty(question) || !nonEmpty(why)) return null;
  if (!Array.isArray(options) || options.length !== 4 || !options.every(nonEmpty)) return null;
  if (!Number.isInteger(answer) || (answer as number) < 0 || (answer as number) > 3) return null;
  return {
    question: question.trim(),
    options: options.map((option: string) => option.trim()),
    answer: answer as number,
    why: why.trim(),
  };
}

/** Checks an already-parsed value (model output or a cache file) against the quiz shape. */
export function validateQuiz(value: unknown): QuizQuestion[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const questions = value.map(toQuestion);
  return questions.every((q): q is QuizQuestion => q !== null) ? questions : null;
}

function stripFences(raw: string): string {
  const text = raw.trim();
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(text);
  return fenced?.[1] ?? text;
}

/** Parses the model's reply into questions, or null if it is not exactly the shape the prompt asked for. */
export function parseQuiz(raw: string): QuizQuestion[] | null {
  const candidates = [stripFences(raw)];
  // Models sometimes add a sentence around the array despite being told not to.
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const questions = validateQuiz(parsed);
    if (questions) return questions;
  }
  return null;
}
