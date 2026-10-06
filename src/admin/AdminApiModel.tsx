import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import type { AdminProfile, OpenRouterAdminView, OpenRouterModel, OpenRouterPatch, OpenRouterTest } from "../../shared/types.ts";
import { api } from "../api.ts";
import { reason } from "./profileText.ts";

/** "$0", "under $0.001", "$0.042", "$2.00": the key's cost is small, so a rounded-down zero would mislead. */
const dollars = (amount: number): string =>
  amount === 0 ? "$0" : amount < 0.001 ? "under $0.001" : `$${amount.toFixed(amount < 1 ? 3 : 2)}`;

/**
 * The API model the admin can give to readers: an API key and one model, which they choose for everyone, a daily limit per
 * reader, and a test that asks the model for one word. It answers through an API call paid with this key, so it never uses
 * anyone's Claude Code or Codex sign-in. A reader gets it only when the admin switches it on for them, on their row.
 */
export function AdminApiModel({ profiles }: { profiles: AdminProfile[] }) {
  const ids = { key: useId(), model: useId(), models: useId(), limit: useId() };
  const [view, setView] = useState<OpenRouterAdminView | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [limit, setLimit] = useState("");
  const [models, setModels] = useState<OpenRouterModel[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<OpenRouterTest | null>(null);

  useEffect(() => {
    let current = true;
    api
      .adminApiModel()
      .then((found) => {
        if (!current) return;
        setView(found);
        setModel(found.model ?? "");
        setLimit(String(found.dailyLimit));
      })
      .catch((err: unknown) => current && setError(reason(err, "The API model settings could not be loaded.")));
    return () => {
      current = false;
    };
  }, []);

  async function save(name: string, patch: OpenRouterPatch, done?: () => void) {
    setBusy(name);
    setError(null);
    setTested(null);
    try {
      const next = await api.saveApiModel(patch);
      setView(next);
      setModel(next.model ?? "");
      setLimit(String(next.dailyLimit));
      done?.();
    } catch (err) {
      setError(reason(err, "That could not be saved. Please try again."));
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    setError(null);
    try {
      setTested(await api.testApiModel());
    } catch (err) {
      setError(reason(err, "The test could not be run."));
    } finally {
      setBusy(null);
    }
  }

  // The list is long (hundreds of models), so it is fetched when the admin first goes to choose from it.
  function loadModels() {
    if (models) return;
    api
      .apiModelList()
      .then(setModels)
      .catch(() => setModels([]));
  }

  const names = new Map(profiles.map((profile) => [profile.id, profile.name]));
  const used = Object.entries(view?.usedToday ?? {}).filter(([, count]) => count > 0);
  const submit = (event: FormEvent, work: () => void) => {
    event.preventDefault();
    work();
  };

  return (
    <section className="admin-api-model" aria-labelledby="admin-api-model-heading">
      <h2 id="admin-api-model-heading" className="sharing-heading">
        API Model
      </h2>
      <p className="admin-hint api-model-intro">
        Explanations through an API call to an AI model, on your API key from OpenRouter. It uses nobody&apos;s Claude Code or Codex
        sign-in, and it is yours to give: a reader gets it only when you switch it on for them in their row above.
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}

      <form className="shelf-edit api-model-form" onSubmit={(event) => submit(event, () => void save("key", { apiKey }, () => setApiKey("")))}>
        <div className="shelf-field">
          <label htmlFor={ids.key}>API key</label>
          <input id={ids.key} type="password" value={apiKey} autoComplete="off" placeholder="sk-or-..." onChange={(event) => setApiKey(event.target.value)} />
          <p className="admin-hint">
            {view === null
              ? "Looking..."
              : view.keySet
                ? `A key is set (${view.keySource === "env" ? "from .env" : "saved here"}), ending ${view.keyHint}. It is never shown again.`
                : "No key yet. Make one at openrouter.ai/keys, or set OPENROUTER_API_KEY in .env."}
          </p>
        </div>
        <div className="api-model-actions">
          <button type="submit" className="quiet-button" disabled={busy !== null || apiKey.trim() === ""}>
            {busy === "key" ? "Saving..." : view?.keySet ? "Replace key" : "Save key"}
          </button>
          {view?.keySource === "admin" && (
            <button type="button" className="quiet-button" disabled={busy !== null} onClick={() => void save("remove-key", { apiKey: null })}>
              Remove saved key
            </button>
          )}
        </div>
      </form>

      <form className="shelf-edit api-model-form" onSubmit={(event) => submit(event, () => void save("model", { model }))}>
        <div className="shelf-field">
          <label htmlFor={ids.model}>Model</label>
          <input
            id={ids.model}
            list={ids.models}
            value={model}
            autoComplete="off"
            placeholder="vendor/model-name"
            onFocus={loadModels}
            onChange={(event) => setModel(event.target.value)}
          />
          <datalist id={ids.models}>
            {models?.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
                {one.free ? " (free)" : one.promptPerMillion !== null ? ` ($${one.promptPerMillion}/M in)` : ""}
              </option>
            ))}
          </datalist>
          <p className="admin-hint">
            {view?.model
              ? `Answering with ${view.model} (${view.modelSource === "env" ? "from .env" : "chosen here"}).`
              : "None chosen yet."}{" "}
            One model answers for everyone, and the list shows what each costs. A cheaper one keeps the bill down.
          </p>
        </div>
        <div className="api-model-actions">
          <button type="submit" className="quiet-button" disabled={busy !== null || model.trim() === "" || model.trim() === view?.model}>
            {busy === "model" ? "Saving..." : "Use this model"}
          </button>
        </div>
      </form>

      <form className="shelf-edit api-model-form" onSubmit={(event) => submit(event, () => void save("limit", { dailyLimit: Number(limit) }))}>
        <div className="shelf-field">
          <label htmlFor={ids.limit}>Requests a reader may make each day</label>
          <input id={ids.limit} type="number" min={0} max={100000} step={1} inputMode="numeric" value={limit} onChange={(event) => setLimit(event.target.value)} />
          <p className="admin-hint">0 means no limit. Yours are never counted. It keeps one reader from using up your credit.</p>
        </div>
        <div className="api-model-actions">
          <button type="submit" className="quiet-button" disabled={busy !== null || limit.trim() === "" || Number(limit) === view?.dailyLimit}>
            {busy === "limit" ? "Saving..." : "Save limit"}
          </button>
        </div>
      </form>

      <div className="api-model-actions api-model-test">
        <button type="button" className="button" disabled={busy !== null || !view?.keySet || !view.model} onClick={() => void test()}>
          {busy === "test" ? "Testing..." : "Test it"}
        </button>
        <p className="admin-hint" role="status">
          {tested === null
            ? "Asks the model for one word: it costs a fraction of a cent."
            : tested.ok
              ? `Works. ${tested.model} answered in ${(tested.ms / 1000).toFixed(1)} s.${
                  tested.balance
                    ? ` This key has used ${dollars(tested.balance.used)}${tested.balance.limit !== null ? ` of ${dollars(tested.balance.limit)}` : ""}.`
                    : ""
                }`
              : tested.message}
        </p>
      </div>

      {used.length > 0 && (
        <ul className="api-model-usage" aria-label="Requests today">
          {used.map(([id, count]) => (
            <li key={id}>
              {names.get(id) ?? "A removed profile"}: {count}
              {view && view.dailyLimit > 0 ? ` of ${view.dailyLimit}` : ""} today
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
