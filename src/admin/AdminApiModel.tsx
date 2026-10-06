import { Check } from "lucide-react";
import { Fragment, useEffect, useId, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { AdminProfile, OpenRouterAdminView, OpenRouterModel, OpenRouterPatch, OpenRouterTest } from "../../shared/types.ts";
import { api } from "../api.ts";
import { Avatar } from "../profiles/Avatar.tsx";
import { reason } from "./profileText.ts";

type Props = {
  profiles: AdminProfile[];
  /** The profile as it is now, after the admin gave or took back the API Model. */
  onProfileChanged: (profile: AdminProfile) => void;
  /** The key or model changed, so what this server can answer with may have too. */
  onChanged: () => void;
};

type Editing = "key" | "model" | "limit" | null;

/** "$0", "under $0.001", "$0.042", "$2.00": the key's cost is small, so a rounded-down zero would mislead. */
const dollars = (amount: number): string =>
  amount === 0 ? "$0" : amount < 0.001 ? "under $0.001" : `$${amount.toFixed(amount < 1 ? 3 : 2)}`;

/** A model id with a chance to break after each slash, so "vendor/long-name" wraps between the two and not in the middle of a word. */
const modelName = (id: string | null): ReactNode =>
  id === null
    ? "None chosen"
    : id.split("/").map((part, index) => (index === 0 ? part : <Fragment key={index}>/<wbr />{part}</Fragment>));

/**
 * The API Model the admin can give to readers, as one card: whether it works, what it costs and how much it has been used,
 * its key, model and daily limit (each opened only to change it), and the readers, who can be given it or have it taken
 * back, or have asked for it and wait for an answer here. It answers through an API call on the admin's key, so it uses
 * nobody's Claude Code or Codex sign-in.
 */
export function AdminApiModel({ profiles, onProfileChanged, onChanged }: Props) {
  const ids = { key: useId(), model: useId(), models: useId(), limit: useId() };
  const [view, setView] = useState<OpenRouterAdminView | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
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
      .then((found) => current && setView(found))
      .catch((err: unknown) => current && setError(reason(err, "The API model settings could not be loaded.")));
    return () => {
      current = false;
    };
  }, []);

  const ready = view?.keySet === true && view.model !== null;
  const chip = ready ? { tone: "ready", label: "Ready" } : { tone: "warn", label: view?.keySet ? "Needs a model" : "Needs an API key" };
  const readers = profiles.filter((profile) => !profile.admin);
  const usedToday = Object.values(view?.usedToday ?? {}).reduce((sum, count) => sum + count, 0);
  const chosen = models?.find((one) => one.id === view?.model);

  async function run(name: string, work: () => Promise<void>) {
    setBusy(name);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(reason(err, "That could not be done. Please try again."));
    } finally {
      setBusy(null);
    }
  }

  const save = (name: string, patch: OpenRouterPatch) =>
    run(name, async () => {
      setTested(null);
      setView(await api.saveApiModel(patch));
      setEditing(null);
      setApiKey("");
      onChanged();
    });

  const test = () =>
    run("test", async () => {
      setTested(await api.testApiModel());
    });

  const give = (reader: AdminProfile) =>
    run(`give-${reader.id}`, async () => {
      onProfileChanged(await api.approveAiRequest(reader.id, "openrouter"));
    });

  const takeBack = (reader: AdminProfile) =>
    run(`take-${reader.id}`, async () => {
      onProfileChanged(await api.updateProfile(reader.id, { ai: reader.ai.filter((id) => id !== "openrouter") }));
    });

  const turnDown = (reader: AdminProfile) =>
    run(`no-${reader.id}`, async () => {
      onProfileChanged(await api.declineAiRequest(reader.id, "openrouter"));
    });

  // The list is long (hundreds of models), so it is fetched when the admin first goes to choose from it.
  function openModel() {
    setModel(view?.model ?? "");
    setEditing("model");
    if (!models) {
      api
        .apiModelList()
        .then(setModels)
        .catch(() => setModels([]));
    }
  }

  const form = (event: FormEvent, work: () => void) => {
    event.preventDefault();
    work();
  };
  const changing = busy !== null;

  return (
    <section id="api-model" className="api-card" aria-labelledby="api-model-heading">
      <header className="api-card-head">
        <div>
          <h2 id="api-model-heading">API Model</h2>
          <p className="admin-hint api-card-intro">
            An API call to an AI model on your OpenRouter key. It uses nobody&apos;s Claude Code or Codex sign-in, and a reader gets it only
            when you give it to them.
          </p>
        </div>
        <div className="api-card-actions">
          {view && (
            <span className="api-chip" data-tone={chip.tone}>
              {chip.label}
            </span>
          )}
          <button type="button" className="button" disabled={changing || !ready} onClick={() => void test()}>
            {busy === "test" ? "Testing..." : "Test it"}
          </button>
        </div>
      </header>

      <p className="admin-hint api-test" role="status">
        {tested === null
          ? ""
          : tested.ok
            ? `Works. ${tested.model} answered in ${(tested.ms / 1000).toFixed(1)} s.`
            : tested.message}
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}

      <dl className="api-stats">
        <div className="api-stat">
          <dt>Model</dt>
          <dd className="api-model-name">{modelName(view?.model ?? null)}</dd>
          <dd className="api-stat-sub">
            {chosen
              ? chosen.free
                ? "Free"
                : chosen.promptPerMillion !== null
                  ? `$${chosen.promptPerMillion} per million tokens in`
                  : "Priced by use"
              : view?.model
                ? view.modelSource === "env"
                  ? "From .env"
                  : "Chosen here"
                : "Choose one below"}
          </dd>
        </div>
        <div className="api-stat">
          <dt>Credit used</dt>
          <dd>{view?.balance ? dollars(view.balance.used) : "Not shown"}</dd>
          <dd className="api-stat-sub">
            {view?.balance ? (view.balance.limit !== null ? `of ${dollars(view.balance.limit)} on this key` : "no limit on this key") : "OpenRouter did not say"}
          </dd>
          {view?.balance && view.balance.limit !== null && view.balance.limit > 0 && (
            <dd className="api-meter" aria-hidden>
              <span style={{ width: `${Math.min(100, (view.balance.used / view.balance.limit) * 100)}%` }} />
            </dd>
          )}
        </div>
        <div className="api-stat">
          <dt>Requests today</dt>
          <dd>{usedToday}</dd>
          <dd className="api-stat-sub">{view && view.dailyLimit > 0 ? `up to ${view.dailyLimit} each reader` : "no limit per reader"}</dd>
        </div>
      </dl>

      <ul className="api-settings">
        <li className="api-setting">
          <div className="api-setting-row">
            <div>
              <h3>API key</h3>
              <p className="admin-hint">
                {view === null
                  ? "Looking..."
                  : view.keySet
                    ? `Set (${view.keySource === "env" ? "from .env" : "saved here"}), ending ${view.keyHint}.`
                    : "None yet. Make one at openrouter.ai/keys, or set OPENROUTER_API_KEY in .env."}
              </p>
            </div>
            <div className="api-setting-actions">
              <button type="button" className="quiet-button" disabled={changing} onClick={() => setEditing(editing === "key" ? null : "key")}>
                {view?.keySet ? "Replace" : "Add key"}
              </button>
              {view?.keySource === "admin" && (
                <button type="button" className="quiet-button" disabled={changing} onClick={() => void save("remove-key", { apiKey: null })}>
                  Remove saved
                </button>
              )}
            </div>
          </div>
          {editing === "key" && (
            <form className="api-edit" onSubmit={(event) => form(event, () => void save("key", { apiKey }))}>
              <label htmlFor={ids.key} className="visually-hidden">
                API key
              </label>
              <input id={ids.key} type="password" value={apiKey} autoComplete="off" placeholder="sk-or-..." autoFocus onChange={(event) => setApiKey(event.target.value)} />
              <button type="submit" className="button" disabled={changing || apiKey.trim() === ""}>
                {busy === "key" ? "Saving..." : "Save key"}
              </button>
              <button type="button" className="quiet-button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </form>
          )}
        </li>

        <li className="api-setting">
          <div className="api-setting-row">
            <div>
              <h3>Model</h3>
              <p className="admin-hint">One model answers for everyone. A cheaper one keeps the bill down.</p>
            </div>
            <div className="api-setting-actions">
              <button type="button" className="quiet-button" disabled={changing} onClick={() => (editing === "model" ? setEditing(null) : openModel())}>
                Change
              </button>
            </div>
          </div>
          {editing === "model" && (
            <form className="api-edit" onSubmit={(event) => form(event, () => void save("model", { model }))}>
              <label htmlFor={ids.model} className="visually-hidden">
                Model
              </label>
              <input
                id={ids.model}
                list={ids.models}
                value={model}
                autoComplete="off"
                placeholder="vendor/model-name"
                autoFocus
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
              <button type="submit" className="button" disabled={changing || model.trim() === "" || model.trim() === view?.model}>
                {busy === "model" ? "Saving..." : "Use this model"}
              </button>
              <button type="button" className="quiet-button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </form>
          )}
        </li>

        <li className="api-setting">
          <div className="api-setting-row">
            <div>
              <h3>Daily limit</h3>
              <p className="admin-hint">
                {view ? `Each reader may make ${view.dailyLimit > 0 ? view.dailyLimit : "any number of"} requests a day. Yours are never counted.` : "Looking..."}
              </p>
            </div>
            <div className="api-setting-actions">
              <button
                type="button"
                className="quiet-button"
                disabled={changing}
                onClick={() => {
                  setLimit(String(view?.dailyLimit ?? 100));
                  setEditing(editing === "limit" ? null : "limit");
                }}
              >
                Change
              </button>
            </div>
          </div>
          {editing === "limit" && (
            <form className="api-edit" onSubmit={(event) => form(event, () => void save("limit", { dailyLimit: Number(limit) }))}>
              <label htmlFor={ids.limit} className="visually-hidden">
                Requests a reader may make each day
              </label>
              <input id={ids.limit} type="number" min={0} max={100000} step={1} inputMode="numeric" value={limit} autoFocus onChange={(event) => setLimit(event.target.value)} />
              <button type="submit" className="button" disabled={changing || limit.trim() === "" || Number(limit) === view?.dailyLimit}>
                {busy === "limit" ? "Saving..." : "Save limit"}
              </button>
              <button type="button" className="quiet-button" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <span className="admin-hint">0 means no limit.</span>
            </form>
          )}
        </li>
      </ul>

      <h3 className="api-subhead">Readers</h3>
      {readers.length === 0 ? (
        <p className="admin-hint">Add a profile above, then give it the API Model here.</p>
      ) : (
        <ul className="api-readers">
          {readers.map((reader) => {
            const has = reader.ai.includes("openrouter");
            const asked = reader.aiRequested.includes("openrouter");
            const used = view?.usedToday[reader.id] ?? 0;
            const limitNow = view?.dailyLimit ?? 0;
            return (
              <li key={reader.id} className="api-reader" data-asked={asked || undefined}>
                <Avatar profile={reader} size={36} />
                <div className="api-reader-who">
                  <span className="api-reader-name">{reader.name}</span>
                  {asked ? (
                    <span className="api-reader-note api-reader-asked">Asked for the API Model</span>
                  ) : has ? (
                    <span className="api-reader-meter">
                      <span className="api-meter" aria-hidden>
                        <span style={{ width: limitNow > 0 ? `${Math.min(100, (used / limitNow) * 100)}%` : used > 0 ? "100%" : "0%" }} />
                      </span>
                      <span className="api-reader-note">
                        {used}
                        {limitNow > 0 ? ` of ${limitNow}` : ""} today
                      </span>
                    </span>
                  ) : (
                    <span className="api-reader-note">Cannot use it</span>
                  )}
                </div>
                {asked ? (
                  <div className="api-reader-actions">
                    <button type="button" className="button" disabled={changing || !ready} onClick={() => void give(reader)}>
                      <Check size={16} aria-hidden /> {busy === `give-${reader.id}` ? "Giving..." : "Approve"}
                    </button>
                    <button type="button" className="quiet-button" disabled={changing} onClick={() => void turnDown(reader)}>
                      Not now
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    role="switch"
                    className="switch"
                    aria-checked={has}
                    aria-label={`Let ${reader.name} use the API Model`}
                    disabled={changing || (!has && !ready)}
                    onClick={() => void (has ? takeBack(reader) : give(reader))}
                  >
                    <span className="switch-track" aria-hidden />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!ready && view && readers.length > 0 && <p className="admin-hint">{chip.label}: set it up above before giving it to readers.</p>}
    </section>
  );
}
