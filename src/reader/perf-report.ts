// Explicitly opt-in, local-only field diagnostics. Never imported on the normal reader path.
interface ScriptTiming {
  sourceURL?: string;
  sourceFunctionName?: string;
  invoker?: string;
  duration?: number;
  forcedStyleAndLayoutDuration?: number;
}

interface TimingEntry extends PerformanceEntry {
  blockingDuration?: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  scripts?: ScriptTiming[];
  processingStart?: number;
  processingEnd?: number;
}

const LIMIT = 400;

/** Starts a bounded recorder and copy control; returns full observer, timer and UI cleanup. */
export function startPerfReport(): () => void {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const frames: object[] = [];
  const events: object[] = [];
  const samples: object[] = [];
  const observers: PerformanceObserver[] = [];
  const support: Record<string, string> = {};
  const nav = navigator as Navigator & { deviceMemory?: number };
  const device = {
    deviceMemory: nav.deviceMemory ?? null,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    userAgent: nav.userAgent,
    dpr: window.devicePixelRatio,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
  const append = (buffer: object[], entry: object): void => {
    buffer.push(entry);
    if (buffer.length > LIMIT) buffer.shift();
  };
  const observe = (type: string, receive: (entry: TimingEntry) => void): boolean => {
    if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes.includes(type)) {
      support[type] = "unsupported";
      return false;
    }
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (entry.startTime >= started) receive(entry);
    });
    try {
      observer.observe({ type, ...(type === "event" ? { durationThreshold: 100 } : {}) });
      observers.push(observer);
      support[type] = "recording";
      return true;
    } catch (error) {
      observer.disconnect();
      support[type] = error instanceof Error ? error.message : String(error);
      return false;
    }
  };
  if (!observe("long-animation-frame", (entry) => append(frames, {
    startTime: entry.startTime,
    duration: entry.duration,
    blockingDuration: entry.blockingDuration,
    renderStart: entry.renderStart,
    styleAndLayoutStart: entry.styleAndLayoutStart,
    scripts: (entry.scripts ?? []).slice(0, 100).map((script) => ({
      sourceURL: script.sourceURL?.slice(0, 2048),
      sourceFunctionName: script.sourceFunctionName?.slice(0, 512),
      invoker: script.invoker?.slice(0, 512),
      duration: script.duration,
      forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration,
    })),
  }))) observe("longtask", (entry) => append(frames, { startTime: entry.startTime, duration: entry.duration, name: entry.name }));
  observe("event", (entry) => {
    if (entry.duration <= 100) return;
    append(events, {
      name: entry.name,
      startTime: entry.startTime,
      duration: entry.duration,
      processingTime: (entry.processingEnd ?? 0) - (entry.processingStart ?? 0),
    });
  });

  const sample = (): void => {
    const chunks = document.querySelectorAll(".text-chunk");
    const placeholders = document.querySelectorAll(".text-chunk[data-placeholder]").length;
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;
    append(samples, {
      time: performance.now(),
      domNodes: document.getElementsByTagName("*").length,
      chunks: { mounted: chunks.length - placeholders, placeholders },
      mountedChapters: document.querySelectorAll("[data-chapter]").length,
      memory: memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize, jsHeapSizeLimit: memory.jsHeapSizeLimit } : null,
      tier: document.documentElement.dataset.tier ?? null,
      scroll: { x: window.scrollX, y: window.scrollY },
    });
  };

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Copy report";
  button.style.cssText = "position:fixed;right:12px;bottom:80px;z-index:2147483647;min-height:44px;padding:8px 12px;background:#fff;color:#111;border:1px solid #111;border-radius:4px;font:16px sans-serif;";
  button.setAttribute("aria-live", "polite");
  document.body.append(button);
  let fallback: HTMLTextAreaElement | null = null;
  let stopped = false;
  button.onclick = async () => {
    sample();
    const json = JSON.stringify({ schemaVersion: 1, startedAt, timeOrigin: performance.timeOrigin, capturedAt: new Date().toISOString(), elapsedMs: performance.now() - started, bufferLimit: LIMIT, scriptLimitPerFrame: 100, device, support, frames, events, samples }, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      if (!stopped) button.textContent = "Report copied";
    } catch {
      if (stopped) return;
      fallback?.remove();
      fallback = document.createElement("textarea");
      fallback.setAttribute("aria-label", "Performance report JSON - select and copy");
      fallback.value = json;
      fallback.readOnly = true;
      fallback.style.cssText = "position:fixed;inset:15%;width:70%;height:60%;z-index:2147483647;background:#fff;color:#111;font:16px monospace;";
      document.body.append(fallback);
      fallback.focus();
      fallback.select();
      button.textContent = "Select and copy report";
    }
  };
  sample();
  const timer = window.setInterval(sample, 2000);
  return () => {
    stopped = true;
    window.clearInterval(timer);
    for (const observer of observers) observer.disconnect();
    button.remove();
    fallback?.remove();
  };
}
