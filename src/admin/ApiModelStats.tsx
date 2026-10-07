import { Fragment } from "react";
import type { ReactNode } from "react";
import type { OpenRouterAdminView, OpenRouterModel } from "../../shared/types.ts";
import type { ServiceInUse } from "./apiServices.ts";

type Props = {
  view: OpenRouterAdminView | null;
  /** The service the view's address belongs to; null until the view has come. */
  service: ServiceInUse | null;
  /** The model in use, as the service's list has it, once the list has been fetched. */
  chosen: OpenRouterModel | undefined;
};

/** "$0", "under $0.001", "$0.042", "$2.00": the key's cost is small, so a rounded-down zero would mislead. */
const dollars = (amount: number): string =>
  amount === 0 ? "$0" : amount < 0.001 ? "under $0.001" : `$${amount.toFixed(amount < 1 ? 3 : 2)}`;

/** A model id with a chance to break after each slash, so "vendor/long-name" wraps between the two and not in the middle of a word. */
const modelName = (id: string | null): ReactNode =>
  id === null
    ? "None chosen"
    : id.split("/").map((part, index) => (index === 0 ? part : <Fragment key={index}>/<wbr />{part}</Fragment>));

/**
 * The API Model at a glance: the model that answers, what it costs (OpenRouter says what the key has spent; a model on the
 * admin's computer costs nothing; other services do not say), and how many requests readers made today.
 */
export function ApiModelStats({ view, service, chosen }: Props) {
  const openRouter = (service?.id ?? "openrouter") === "openrouter";
  const usedToday = Object.values(view?.usedToday ?? {}).reduce((sum, count) => sum + count, 0);
  return (
    <dl className="api-stats">
      <div className="api-stat">
        <dt>Model</dt>
        <dd className="api-model-name">{modelName(view?.model ?? null)}</dd>
        <dd className="api-stat-sub">
          {!view?.model
            ? "Choose one below"
            : chosen?.free
              ? "Free"
              : chosen && chosen.promptPerMillion !== null
                ? `$${chosen.promptPerMillion} per million tokens in`
                : chosen && openRouter
                  ? "Priced by use"
                  : view.modelSource === "env"
                    ? "From .env"
                    : "Chosen here"}
        </dd>
      </div>
      {openRouter ? (
        <div className="api-stat">
          <dt>Credit used</dt>
          <dd>{view?.balance ? dollars(view.balance.used) : "Not shown"}</dd>
          <dd className="api-stat-sub">
            {view?.balance ? (view.balance.limit !== null ? `of ${dollars(view.balance.limit)} on this key` : "no limit on this key") : view ? "OpenRouter did not say" : "Looking..."}
          </dd>
          {view?.balance && view.balance.limit !== null && view.balance.limit > 0 && (
            <dd className="api-meter" aria-hidden>
              <span style={{ width: `${Math.min(100, (view.balance.used / view.balance.limit) * 100)}%` }} />
            </dd>
          )}
        </div>
      ) : service?.local ? (
        <div className="api-stat">
          <dt>Cost</dt>
          <dd>Free</dd>
          <dd className="api-stat-sub">on a computer of yours</dd>
        </div>
      ) : (
        <div className="api-stat">
          <dt>Credit used</dt>
          <dd>Not shown</dd>
          <dd className="api-stat-sub">Not reported by {service?.who}</dd>
        </div>
      )}
      <div className="api-stat">
        <dt>Requests today</dt>
        <dd>{usedToday}</dd>
        <dd className="api-stat-sub">{view && view.dailyLimit > 0 ? `up to ${view.dailyLimit} each reader` : "no limit per reader"}</dd>
      </div>
    </dl>
  );
}
