// Instant, keyless translation for the moment a word is tapped.
// Uses the unofficial Google dictionary-extension endpoint (the better-known gtx one serves a block page from some
// addresses), and Microsoft's Edge endpoint (chapter-translation.ts) when Google refuses: it sends some addresses to its
// robot check. Both are unofficial, so every failure is expected and the UI falls back to the AI word explanation.
import { readFile } from "node:fs/promises";
import type { LangCode } from "../shared/types.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { translateTexts } from "./chapter-translation.ts";

export type QuickTranslate = (text: string, lang: LangCode) => Promise<string>;

export class TranslateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslateError";
  }
}

export type QuickTranslateOptions = {
  cacheFile: string;
  /** Replaceable so tests never touch the network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const ENDPOINT = "https://clients5.google.com/translate_a/t";
const TIMEOUT_MS = 4_000;
const SAVE_DELAY_MS = 750;
// Oldest entries go first; a reader's own vocabulary stays far below this.
const MAX_CACHED = 20_000;

/** Reads the shapes this endpoint is known to return: [["text","en"]], ["text"], {sentences:[{trans}]}. */
export function parseTranslation(body: unknown): string | null {
  const pieces: string[] = [];
  if (Array.isArray(body)) {
    for (const entry of body) {
      if (typeof entry === "string") pieces.push(entry);
      else if (Array.isArray(entry) && typeof entry[0] === "string") pieces.push(entry[0]);
    }
  } else if (typeof body === "object" && body !== null && "sentences" in body && Array.isArray(body.sentences)) {
    for (const sentence of body.sentences) {
      if (typeof sentence === "object" && sentence !== null && "trans" in sentence && typeof sentence.trans === "string") {
        pieces.push(sentence.trans);
      }
    }
  }
  const joined = pieces.map((piece) => piece.trim()).filter(Boolean).join(" ");
  return joined === "" ? null : joined;
}

export function createQuickTranslate(options: QuickTranslateOptions): { translate: QuickTranslate; flush(): Promise<void> } {
  const doFetch = options.fetchImpl ?? fetch;
  let cache: Map<string, string> | null = null;
  let loading: Promise<Map<string, string>> | null = null;
  let saveTimer: NodeJS.Timeout | undefined;
  let saving: Promise<void> = Promise.resolve();
  let dirty = false;

  function load(): Promise<Map<string, string>> {
    loading ??= (async () => {
      try {
        const parsed: unknown = JSON.parse(await readFile(options.cacheFile, "utf8"));
        const entries = Object.entries(parsed as Record<string, unknown>).filter(
          (pair): pair is [string, string] => typeof pair[1] === "string",
        );
        return new Map(entries);
      } catch (error) {
        const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
        if (!missing) console.warn("translate cache unreadable, starting empty:", error);
        return new Map();
      }
    })();
    return loading;
  }

  function save(entries: Map<string, string>): Promise<void> {
    dirty = false;
    saving = saving
      .then(() => writeFileAtomic(options.cacheFile, JSON.stringify(Object.fromEntries(entries))))
      .catch((error: unknown) => console.warn("could not save translate cache:", error));
    return saving;
  }

  function scheduleSave(entries: Map<string, string>): void {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(entries), SAVE_DELAY_MS);
    saveTimer.unref();
  }

  async function fromGoogle(text: string, lang: LangCode): Promise<string> {
    const url = `${ENDPOINT}?client=dict-chrome-ex&sl=auto&tl=${lang}&q=${encodeURIComponent(text)}`;
    let body: unknown;
    try {
      // A redirect is not followed: it leads to Google's robot check, and asking Microsoft is quicker than loading that page.
      const response = await doFetch(url, { redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS) });
      if (!response.ok) throw new TranslateError(`translate service answered ${response.status}`);
      // A block page is HTML, so this throws instead of caching garbage.
      body = JSON.parse(await response.text());
    } catch (error) {
      if (error instanceof TranslateError) throw error;
      throw new TranslateError(`translate service unreachable or unreadable: ${String(error)}`);
    }
    const translation = parseTranslation(body);
    if (translation === null) throw new TranslateError("translate service returned no translation");
    return translation;
  }

  async function fromMicrosoft(text: string, lang: LangCode): Promise<string> {
    const [made] = await translateTexts([text], lang, "microsoft", { fetchImpl: doFetch, timeoutMs: options.timeoutMs ?? TIMEOUT_MS });
    const translation = made?.text.trim() ?? "";
    if (translation === "") throw new TranslateError("Microsoft returned no translation");
    return translation;
  }

  const translate: QuickTranslate = async (text, lang) => {
    const entries = (cache ??= await load());
    const key = `${lang}\n${text.replace(/\s+/g, " ").trim()}`;
    const hit = entries.get(key);
    if (hit !== undefined) return hit;

    let translation: string;
    try {
      translation = await fromGoogle(text, lang);
    } catch (google) {
      try {
        translation = await fromMicrosoft(text, lang);
      } catch (microsoft) {
        const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));
        throw new TranslateError(`${reason(google)}; ${reason(microsoft)}`);
      }
    }

    entries.set(key, translation);
    dirty = true;
    if (entries.size > MAX_CACHED) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
    scheduleSave(entries);
    return translation;
  };

  return {
    translate,
    async flush() {
      clearTimeout(saveTimer);
      if (cache && dirty) await save(cache);
      await saving;
    },
  };
}
