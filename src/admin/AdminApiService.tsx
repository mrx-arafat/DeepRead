import { useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { API_SERVICES, cleanAddress, isNearby, sameAddress, serviceAt } from "./apiServices.ts";
import type { ServiceId } from "./apiServices.ts";

type Props = {
  /** The address in use now. */
  baseUrl: string;
  saving: boolean;
  disabled: boolean;
  /** The address to ask from now on; null goes back to OpenRouter, the default. */
  onSave: (baseUrl: string | null) => void;
  onCancel: () => void;
};

/**
 * The API Model's service, chosen from a list of the ones DeepRead knows by name or as any other OpenAI-compatible
 * address. A service on a computer of the admin's is asked by the server, so the admin is told it must reach it from there.
 */
export function ServiceEditor({ baseUrl, saving, disabled, onSave, onCancel }: Props) {
  const id = useId();
  const current = serviceAt(baseUrl);
  const [choice, setChoice] = useState<ServiceId | "custom">(current.id);
  const [custom, setCustom] = useState(current.id === "custom" ? baseUrl : "");
  const [problem, setProblem] = useState<string | null>(null);
  const customInput = useRef<HTMLInputElement>(null);

  const preset = API_SERVICES.find((service) => service.id === choice);
  const target = preset ? preset.url : (cleanAddress(custom) ?? custom.trim());
  const unchanged = sameAddress(target, baseUrl);
  const nearby = preset ? preset.local : isNearby(target);
  const nearbyId = `${id}-nearby`;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (preset) {
      onSave(preset.id === "openrouter" ? null : preset.url);
      return;
    }
    const address = cleanAddress(custom);
    if (address === null) {
      setProblem("That is not an address DeepRead can use. It starts with http:// or https://, for example https://example.com/v1.");
      customInput.current?.focus();
      return;
    }
    onSave(address);
  }

  function choose(next: ServiceId | "custom") {
    setChoice(next);
    setProblem(null);
  }

  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") onCancel();
  };

  return (
    <form className="api-edit" noValidate onSubmit={submit} onKeyDown={escape}>
      <fieldset className="api-choices">
        <legend className="visually-hidden">Service</legend>
        <div className="api-choice-grid">
          {API_SERVICES.map((service) => (
            <div key={service.id} className="api-choice">
              <label className="api-choice-pick">
                <input
                  type="radio"
                  name={`${id}-service`}
                  value={service.id}
                  checked={choice === service.id}
                  autoFocus={choice === service.id}
                  aria-labelledby={`${id}-${service.id}`}
                  aria-describedby={[`${id}-${service.id}-about`, service.local && nearby ? nearbyId : ""].join(" ").trim()}
                  onChange={() => choose(service.id)}
                />
                <span id={`${id}-${service.id}`} className="api-choice-name">
                  {service.name}
                  {service.id === "openrouter" && <span className="api-choice-tag">Default</span>}
                </span>
                <span id={`${id}-${service.id}-about`} className="api-choice-about">
                  {service.about}
                </span>
                <span className="api-choice-address">{service.url}</span>
              </label>
            </div>
          ))}
          <div className="api-choice api-choice-wide">
            <label className="api-choice-pick">
              <input
                type="radio"
                name={`${id}-service`}
                value="custom"
                checked={choice === "custom"}
                autoFocus={choice === "custom"}
                aria-labelledby={`${id}-custom`}
                aria-describedby={`${id}-custom-about`}
                onChange={() => choose("custom")}
              />
              <span id={`${id}-custom`} className="api-choice-name">
                Custom
              </span>
              <span id={`${id}-custom-about`} className="api-choice-about">
                Any other service that answers the way OpenAI&apos;s API does.
              </span>
            </label>
            {choice === "custom" && (
              <div className="shelf-field api-choice-field">
                <label htmlFor={`${id}-address`}>Address</label>
                <input
                  ref={customInput}
                  id={`${id}-address`}
                  type="url"
                  inputMode="url"
                  value={custom}
                  placeholder="https://example.com/v1"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={problem !== null}
                  aria-describedby={[problem ? `${id}-problem` : "", `${id}-address-hint`, nearby ? nearbyId : ""].join(" ").trim()}
                  onChange={(event) => {
                    setCustom(event.target.value);
                    setProblem(null);
                  }}
                />
                <p id={`${id}-address-hint`} className="admin-hint">
                  The part before /chat/completions.
                </p>
                {problem && (
                  <p id={`${id}-problem`} className="inline-error" role="alert">
                    {problem}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </fieldset>
      {nearby && (
        <p id={nearbyId} className="admin-hint api-nearby">
          The server running DeepRead asks this address, not your browser, so the server must be able to reach it. 127.0.0.1
          means that same server.
        </p>
      )}
      <div className="api-edit-actions">
        <button type="submit" className="button" disabled={disabled || unchanged || target === ""}>
          {saving ? "Saving..." : "Use this service"}
        </button>
        <button type="button" className="quiet-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
