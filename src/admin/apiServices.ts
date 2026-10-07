import { OPENROUTER_BASE_URL } from "../../shared/types.ts";

export type ServiceId = "openrouter" | "openai" | "deepseek" | "groq" | "ollama" | "lmstudio";

export type ApiService = {
  id: ServiceId;
  name: string;
  /** The address of its OpenAI-compatible Chat Completions API, without /chat/completions. */
  url: string;
  /** One line for the admin choosing it. */
  about: string;
  /** Whether it answers only with a key. A model on the admin's own computer needs none. */
  needsKey: boolean;
  /** It runs on a computer of the admin's, so it costs nothing to ask. */
  local: boolean;
};

/** The services the admin can pick by name, OpenRouter first as the default. Any other address is a custom one. */
export const API_SERVICES: readonly ApiService[] = [
  { id: "openrouter", name: "OpenRouter", url: OPENROUTER_BASE_URL, about: "Hundreds of models from many makers, on one key.", needsKey: true, local: false },
  { id: "openai", name: "OpenAI", url: "https://api.openai.com/v1", about: "OpenAI's own models, on an OpenAI key.", needsKey: true, local: false },
  { id: "deepseek", name: "DeepSeek", url: "https://api.deepseek.com/v1", about: "DeepSeek's models, on a DeepSeek key.", needsKey: true, local: false },
  { id: "groq", name: "Groq", url: "https://api.groq.com/openai/v1", about: "Open models that answer quickly, on a Groq key.", needsKey: true, local: false },
  {
    id: "ollama",
    name: "Ollama",
    url: "http://127.0.0.1:11434/v1",
    about: "A free model on a computer of yours, for example TranslateGemma. No key.",
    needsKey: false,
    local: true,
  },
  { id: "lmstudio", name: "LM Studio", url: "http://127.0.0.1:1234/v1", about: "A free model on a computer of yours. No key.", needsKey: false, local: true },
];

/** The service an address belongs to, as the admin page speaks of it. */
export type ServiceInUse = {
  id: ServiceId | "custom";
  /** "OpenRouter", or "Custom" for an address that is none of the named ones. */
  name: string;
  /** How a sentence names it: the service's name, or the host of a custom address ("10.0.0.5:8080"). */
  who: string;
  needsKey: boolean;
  local: boolean;
};

/** One address however it was written: lower-case host, localhost as 127.0.0.1, no trailing slash. Null when it is no URL. */
function canonical(address: string): string | null {
  try {
    const url = new URL(address.trim());
    const host = url.hostname === "localhost" ? `127.0.0.1${url.port ? `:${url.port}` : ""}` : url.host;
    return `${url.protocol}//${host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Whether two addresses name the same API. */
export function sameAddress(a: string, b: string): boolean {
  const one = canonical(a);
  return one !== null && one === canonical(b);
}

/** The named service at this address, or a custom one shown by its host. */
export function serviceAt(address: string): ServiceInUse {
  const preset = API_SERVICES.find((service) => sameAddress(service.url, address));
  if (preset) return { id: preset.id, name: preset.name, who: preset.name, needsKey: preset.needsKey, local: preset.local };
  let host = address;
  try {
    host = new URL(address).host || address;
  } catch {
    // Not a URL: the address itself is the best name there is.
  }
  return { id: "custom", name: "Custom", who: host, needsKey: false, local: false };
}

/** Under the card's heading: what the API Model is, said of the service it is at. */
export function introText(service: ServiceInUse | null): string {
  const what =
    service === null
      ? "An API call to an AI model."
      : service.local
        ? `An API call to a model in ${service.name}, on a computer of yours.`
        : service.id === "custom"
          ? `An API call to an AI model at ${service.who}.`
          : `An API call to an AI model on your ${service.name} key.`;
  return `${what} It uses nobody's Claude Code or Codex sign-in, and a reader gets it only when you give it to them.`;
}

/** What the API key row says when no key is set, which depends on whether the service needs one. */
export function noKeyText(service: ServiceInUse): string {
  if (service.id === "openrouter") return "None yet. Make one at openrouter.ai/keys, or set OPENROUTER_API_KEY in .env.";
  if (service.local) return "Not needed for a model on your own computer.";
  if (service.id === "custom") return "None. Add one if the service asks for it.";
  return `None yet. Make one in your ${service.name} account.`;
}

/**
 * An address as typed, made into one the server keeps: http or https, no query, fragment or sign-in in it, and without a
 * trailing /chat/completions, which the admin may paste from a service's own example. Null when it cannot be one.
 */
export function cleanAddress(typed: string): string | null {
  const trimmed = typed.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const plain = (url.protocol === "http:" || url.protocol === "https:") && !/[?#]/.test(trimmed) && url.username === "" && url.password === "";
  if (!plain) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
}

/**
 * Whether the server, and not the admin's browser, may be unable to reach the address: one on the server itself
 * (127.0.0.1) or on a home or office network.
 */
export function isNearby(address: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(address.trim()).hostname;
  } catch {
    return false;
  }
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".local") ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}
