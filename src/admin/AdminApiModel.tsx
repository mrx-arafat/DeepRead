import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { OPENROUTER_BASE_URL } from "../../shared/types.ts";
import type { AdminProfile, OpenRouterAdminView, OpenRouterModel, OpenRouterPatch, OpenRouterTest } from "../../shared/types.ts";
import { api } from "../api.ts";
import { ServiceEditor } from "./AdminApiService.tsx";
import { ApiModelReaders } from "./ApiModelReaders.tsx";
import { ApiModelStats } from "./ApiModelStats.tsx";
import { introText, noKeyText, serviceAt } from "./apiServices.ts";
import { reason } from "./profileText.ts";

type Props = {
  profiles: AdminProfile[];
  /** The profile as it is now, after the admin gave or took back the API Model. */
  onProfileChanged: (profile: AdminProfile) => void;
  /** The service, key or model changed, so what this server can answer with may have too. */
  onChanged: () => void;
};

/** The setting whose editor is open: one at a time, each opened only to change it. */
type Row = "service" | "key" | "model" | "limit";

const SOURCE = { admin: "saved here", env: "from .env" } as const;

/** A model in the list to choose from: its name where it has one apart from its id, and its price where the service gives one. */
const modelLabel = (one: OpenRouterModel): string =>
  `${one.name === one.id ? "" : one.name}${one.free ? " (free)" : one.promptPerMillion !== null ? ` ($${one.promptPerMillion}/M in)` : ""}`.trim();

/**
 * The API Model the admin can give to readers, as one card: whether it works, what it costs and how much it has been used,
 * the service it is asked at, its key, model and daily limit (each opened only to change it), and the readers, who can be
 * given it or have it taken back, or have asked for it and wait for an answer here. It answers through an API call on the
 * admin's key, or a model on the admin's own computer, so it uses nobody's Claude Code or Codex sign-in.
 */
export function AdminApiModel({ profiles, onProfileChanged, onChanged }: Props) {
  const ids = { key: useId(), model: useId(), models: useId(), modelNote: useId(), listProblem: useId(), limit: useId() };
  const [view, setView] = useState<OpenRouterAdminView | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [limit, setLimit] = useState("");
  const [models, setModels] = useState<OpenRouterModel[] | null>(null);
  // Said in the model's editor: what to do after the service changed, and why there is no list to choose from.
  const [modelNote, setModelNote] = useState<string | null>(null);
  const [listProblem, setListProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<OpenRouterTest | null>(null);
  // Each row's Change button, which takes the focus back when its editor closes, once nothing is being saved.
  const toggles = useRef<Partial<Record<Row, HTMLButtonElement | null>>>({});
  const [refocus, setRefocus] = useState<Row | null>(null);
  // Only the newest list counts: a slower one asked of the service before would offer models it does not have.
  const listAsked = useRef(0);

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

  useEffect(() => {
    if (refocus === null || busy !== null) return;
    toggles.current[refocus]?.focus();
    setRefocus(null);
  }, [refocus, busy]);

  const service = view ? serviceAt(view.baseUrl) : null;
  const openRouter = (service?.id ?? "openrouter") === "openrouter";
  const keyReady = view?.keySet === true || service?.needsKey === false;
  const ready = keyReady && view !== null && view.model !== null;
  const chip = ready ? { tone: "ready", label: "Ready" } : { tone: "warn", label: keyReady ? "Needs a model" : "Needs an API key" };
  const readers = profiles.filter((profile) => !profile.admin);
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

  function close(row: Row) {
    setEditing(null);
    setModelNote(null);
    setRefocus(row);
  }

  const save = (row: Row, name: string, patch: OpenRouterPatch) =>
    run(name, async () => {
      setTested(null);
      setView(await api.saveApiModel(patch));
      close(row);
      setApiKey("");
      onChanged();
    });

  const saveService = (baseUrl: string | null) =>
    run("service", async () => {
      setTested(null);
      let next = await api.saveApiModel({ baseUrl });
      // With nothing saved the server goes back to the address in .env, which may be another service's.
      if (baseUrl === null && serviceAt(next.baseUrl).id !== "openrouter") next = await api.saveApiModel({ baseUrl: OPENROUTER_BASE_URL });
      setView(next);
      onChanged();
      // The model chosen at the old service is seldom one the new service has, so the admin is asked for one at once,
      // from an empty field: the list offers only what matches what is typed in it.
      openModel(null, true);
      setModelNote(`Choose a model ${serviceAt(next.baseUrl).who} offers.`);
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

  // The list can be long (hundreds of models on OpenRouter), so it is fetched when the admin first goes to choose from it,
  // and again after the service changed.
  function openModel(current: string | null = view?.model ?? null, fresh = false) {
    setModel(current ?? "");
    setModelNote(null);
    setEditing("model");
    if (models && !fresh) return;
    const asked = ++listAsked.current;
    setModels(null);
    setListProblem(null);
    api
      .apiModelList()
      .then((found) => asked === listAsked.current && setModels(found))
      .catch((err: unknown) => {
        if (asked !== listAsked.current) return;
        setModels([]);
        setListProblem(`${reason(err, "The list of models could not be loaded.")} You can still type the model's name.`);
      });
  }

  const toggle = (row: Row, open: () => void) => (editing === row ? close(row) : open());
  const toggleProps = (row: Row) => ({
    ref: (button: HTMLButtonElement | null) => {
      toggles.current[row] = button;
    },
    "aria-expanded": editing === row,
  });
  const form = (event: FormEvent, work: () => void) => {
    event.preventDefault();
    work();
  };
  const escape = (row: Row) => (event: KeyboardEvent) => {
    if (event.key === "Escape") close(row);
  };
  const changing = busy !== null;

  return (
    <section id="api-model" className="api-card" aria-labelledby="api-model-heading">
      <header className="api-card-head">
        <div>
          <h2 id="api-model-heading">API Model</h2>
          <p className="admin-hint api-card-intro">{introText(service)}</p>
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

      <ApiModelStats view={view} service={service} chosen={chosen} />

      <ul className="api-settings">
        <li className="api-setting">
          <div className="api-setting-row">
            <div>
              <h3>Service</h3>
              <p className="admin-hint">
                {view === null || service === null ? (
                  "Looking..."
                ) : (
                  <>
                    {service.id === "custom" ? "A custom service" : service.name} at <span className="api-address">{view.baseUrl}</span> (
                    {view.baseUrlSource ? SOURCE[view.baseUrlSource] : "default"})
                  </>
                )}
              </p>
            </div>
            <div className="api-setting-actions">
              <button
                type="button"
                className="quiet-button"
                disabled={changing || view === null}
                {...toggleProps("service")}
                onClick={() => toggle("service", () => setEditing("service"))}
              >
                Change
              </button>
            </div>
          </div>
          {editing === "service" && view && (
            <ServiceEditor
              baseUrl={view.baseUrl}
              saving={busy === "service"}
              disabled={changing}
              onSave={(baseUrl) => void saveService(baseUrl)}
              onCancel={() => close("service")}
            />
          )}
        </li>

        <li className="api-setting">
          <div className="api-setting-row">
            <div>
              <h3>API key</h3>
              <p className="admin-hint">
                {view === null || service === null
                  ? "Looking..."
                  : view.keySet
                    ? `Set (${view.keySource === "env" ? "from .env" : "saved here"}), ending ${view.keyHint}.`
                    : noKeyText(service)}
              </p>
            </div>
            <div className="api-setting-actions">
              <button
                type="button"
                className="quiet-button"
                disabled={changing}
                {...toggleProps("key")}
                onClick={() => toggle("key", () => setEditing("key"))}
              >
                {view?.keySet ? "Replace" : "Add key"}
              </button>
              {view?.keySource === "admin" && (
                <button type="button" className="quiet-button" disabled={changing} onClick={() => void save("key", "remove-key", { apiKey: null })}>
                  Remove saved
                </button>
              )}
            </div>
          </div>
          {editing === "key" && (
            <form className="api-edit" onSubmit={(event) => form(event, () => void save("key", "key", { apiKey }))} onKeyDown={escape("key")}>
              <label htmlFor={ids.key} className="visually-hidden">
                API key
              </label>
              <input
                id={ids.key}
                type="password"
                value={apiKey}
                autoComplete="off"
                placeholder={openRouter ? "sk-or-..." : "Paste the key"}
                autoFocus
                onChange={(event) => setApiKey(event.target.value)}
              />
              <button type="submit" className="button" disabled={changing || apiKey.trim() === ""}>
                {busy === "key" ? "Saving..." : "Save key"}
              </button>
              <button type="button" className="quiet-button" onClick={() => close("key")}>
                Cancel
              </button>
            </form>
          )}
        </li>

        <li className="api-setting">
          <div className="api-setting-row">
            <div>
              <h3>Model</h3>
              <p className="admin-hint">
                {service?.local
                  ? "One model answers for everyone. A smaller one answers sooner on an ordinary computer."
                  : "One model answers for everyone. A cheaper one keeps the bill down."}
              </p>
            </div>
            <div className="api-setting-actions">
              <button type="button" className="quiet-button" disabled={changing} {...toggleProps("model")} onClick={() => toggle("model", () => openModel())}>
                Change
              </button>
            </div>
          </div>
          {editing === "model" && (
            <form className="api-edit" onSubmit={(event) => form(event, () => void save("model", "model", { model }))} onKeyDown={escape("model")}>
              {modelNote && (
                <p id={ids.modelNote} className="admin-hint api-edit-note">
                  {modelNote}
                </p>
              )}
              {listProblem && (
                <p id={ids.listProblem} className="admin-hint api-edit-note">
                  {listProblem}
                </p>
              )}
              <label htmlFor={ids.model} className="visually-hidden">
                Model
              </label>
              <input
                id={ids.model}
                list={ids.models}
                value={model}
                autoComplete="off"
                spellCheck={false}
                placeholder={openRouter ? "vendor/model-name" : "model name"}
                aria-describedby={[modelNote ? ids.modelNote : "", listProblem ? ids.listProblem : ""].join(" ").trim() || undefined}
                autoFocus
                onChange={(event) => setModel(event.target.value)}
              />
              <datalist id={ids.models}>
                {models?.map((one) => (
                  <option key={one.id} value={one.id}>
                    {modelLabel(one)}
                  </option>
                ))}
              </datalist>
              <button type="submit" className="button" disabled={changing || model.trim() === "" || model.trim() === view?.model}>
                {busy === "model" ? "Saving..." : "Use this model"}
              </button>
              <button type="button" className="quiet-button" onClick={() => close("model")}>
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
                {...toggleProps("limit")}
                onClick={() =>
                  toggle("limit", () => {
                    setLimit(String(view?.dailyLimit ?? 100));
                    setEditing("limit");
                  })
                }
              >
                Change
              </button>
            </div>
          </div>
          {editing === "limit" && (
            <form
              className="api-edit"
              onSubmit={(event) => form(event, () => void save("limit", "limit", { dailyLimit: Number(limit) }))}
              onKeyDown={escape("limit")}
            >
              <label htmlFor={ids.limit} className="visually-hidden">
                Requests a reader may make each day
              </label>
              <input id={ids.limit} type="number" min={0} max={100000} step={1} inputMode="numeric" value={limit} autoFocus onChange={(event) => setLimit(event.target.value)} />
              <button type="submit" className="button" disabled={changing || limit.trim() === "" || Number(limit) === view?.dailyLimit}>
                {busy === "limit" ? "Saving..." : "Save limit"}
              </button>
              <button type="button" className="quiet-button" onClick={() => close("limit")}>
                Cancel
              </button>
              <span className="admin-hint">0 means no limit.</span>
            </form>
          )}
        </li>
      </ul>

      <h3 className="api-subhead">Readers</h3>
      <ApiModelReaders
        readers={readers}
        view={view}
        ready={ready}
        busy={busy}
        onGive={(reader) => void give(reader)}
        onTakeBack={(reader) => void takeBack(reader)}
        onTurnDown={(reader) => void turnDown(reader)}
      />
      {!ready && view && readers.length > 0 && <p className="admin-hint">{chip.label}: set it up above before giving it to readers.</p>}
    </section>
  );
}
