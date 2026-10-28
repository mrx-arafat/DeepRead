#!/usr/bin/env node
// Summarises a Chrome performance trace (trace.json or trace.json.gz) for the reader's main thread:
// busy time per second, long tasks, time by category, and the hottest functions (self time) with file:line.
// Usage: node e2e/perf/trace-summary.mjs <trace.json[.gz]> [--top 20] [--filter src/]
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.log("usage: node e2e/perf/trace-summary.mjs <trace.json[.gz]> [--top N] [--filter text]");
  process.exit(2);
}
const option = (name, fallback) => {
  const at = rest.indexOf(name);
  return at >= 0 ? rest[at + 1] : fallback;
};
const top = Number(option("--top", 20));
const filter = option("--filter", "");

const raw = readFileSync(file);
const text = file.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
const parsed = JSON.parse(text);
const events = Array.isArray(parsed) ? parsed : parsed.traceEvents;

// The renderer main thread of the page: the thread named CrRendererMain with the most work on it.
const threadNames = new Map();
for (const event of events) if (event.ph === "M" && event.name === "thread_name") threadNames.set(`${event.pid}:${event.tid}`, event.args?.name);
const mainThreads = [...threadNames].filter(([, name]) => name === "CrRendererMain").map(([key]) => key);
const workBy = new Map();
for (const event of events) {
  const key = `${event.pid}:${event.tid}`;
  if (!mainThreads.includes(key) || event.ph !== "X") continue;
  workBy.set(key, (workBy.get(key) ?? 0) + (event.dur ?? 0));
}
const main = [...workBy].sort((a, b) => b[1] - a[1])[0]?.[0];
if (!main) {
  console.log("no renderer main thread found");
  process.exit(1);
}
const [pid, tid] = main.split(":").map(Number);
const onMain = events.filter((event) => event.pid === pid && event.tid === tid);

// Top-level tasks: everything the main thread runs is inside a RunTask.
const TASK = new Set(["RunTask", "ThreadControllerImpl::RunTask"]);
const tasks = onMain.filter((event) => event.ph === "X" && TASK.has(event.name) && event.dur !== undefined);
let start = Infinity;
let end = -Infinity;
for (const event of onMain) {
  if (!event.ts) continue;
  if (event.ts < start) start = event.ts;
  if (event.ts + (event.dur ?? 0) > end) end = event.ts + (event.dur ?? 0);
}
const seconds = Math.max(1, Math.ceil((end - start) / 1e6));
const busyPerSecond = new Array(seconds).fill(0);
for (const task of tasks) {
  // Split a task over the seconds it spans.
  let from = task.ts;
  const until = task.ts + task.dur;
  while (from < until) {
    const bucket = Math.min(seconds - 1, Math.floor((from - start) / 1e6));
    const bucketEnd = start + (bucket + 1) * 1e6;
    const slice = Math.min(until, bucketEnd) - from;
    busyPerSecond[bucket] += slice;
    from += slice;
  }
}
const busyMs = tasks.reduce((sum, task) => sum + task.dur, 0) / 1000;
const longTasks = tasks.filter((task) => task.dur >= 50_000).map((task) => Math.round(task.dur / 1000)).sort((a, b) => b - a);

// Time by category: nested X events under the tasks, by name (self time, so children are not counted twice).
const nested = onMain.filter((event) => event.ph === "X" && event.dur !== undefined && !TASK.has(event.name)).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
const byName = new Map();
const stack = [];
for (const event of nested) {
  while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= event.ts) stack.pop();
  const parent = stack.at(-1);
  if (parent) parent.children = (parent.children ?? 0) + event.dur;
  stack.push(event);
}
for (const event of nested) {
  const self = Math.max(0, event.dur - (event.children ?? 0));
  byName.set(event.name, (byName.get(event.name) ?? 0) + self);
}
const categories = [...byName].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, us]) => `${name}: ${Math.round(us / 1000)} ms`);

// CPU profile samples: self time per call frame.
// Profile chunks carry the sampled thread in their id, not always its tid: take every chunk of the page process.
const profiles = events.filter((event) => event.pid === pid && (event.name === "Profile" || event.name === "ProfileChunk")).sort((a, b) => a.ts - b.ts);
const nodes = new Map();
const self = new Map();
let lastTime = null;
for (const event of profiles) {
  const data = event.args?.data;
  if (!data) continue;
  const profile = data.cpuProfile ?? data;
  for (const node of profile.nodes ?? []) nodes.set(node.id, node);
  if (!profile.samples) continue;
  const deltas = data.timeDeltas ?? profile.timeDeltas ?? [];
  for (let at = 0; at < profile.samples.length; at++) {
    const delta = deltas[at] ?? 0;
    const node = nodes.get(profile.samples[at]);
    if (!node) continue;
    const frame = node.callFrame ?? {};
    const name = frame.functionName || "(anonymous)";
    const where = frame.url ? `${frame.url.replace(/^https?:\/\/[^/]+/, "")}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1}` : "";
    const key = `${name} ${where}`;
    self.set(key, (self.get(key) ?? 0) + delta);
  }
  lastTime = event.ts;
}
// The longest tasks, each with its start offset and the functions that filled it: what a single spike is made of.
const sampleTimes = [];
{
  let clock = null;
  for (const event of profiles) {
    const data = event.args?.data;
    if (!data) continue;
    if (event.name === "Profile") { clock = data.startTime ?? event.ts; continue; }
    const profile = data.cpuProfile ?? data;
    if (!profile.samples) continue;
    const deltas = data.timeDeltas ?? profile.timeDeltas ?? [];
    if (clock === null) clock = event.ts;
    for (let at = 0; at < profile.samples.length; at++) {
      clock += deltas[at] ?? 0;
      sampleTimes.push({ t: clock, node: profile.samples[at], d: deltas[at] ?? 0 });
    }
  }
}
const biggest = tasks.filter((task) => task.dur >= 1_000_000).sort((a, b) => b.dur - a.dur).slice(0, 6);
const spikes = biggest.map((task) => {
  const inside = new Map();
  for (const sample of sampleTimes) {
    if (sample.t < task.ts || sample.t > task.ts + task.dur) continue;
    const frame = nodes.get(sample.node)?.callFrame ?? {};
    const name = frame.functionName || "(anonymous)";
    const where = frame.url ? `${frame.url.replace(/^https?:\/\/[^/]+/, "")}:${(frame.lineNumber ?? 0) + 1}` : "";
    const key = `${name} ${where}`.trim();
    inside.set(key, (inside.get(key) ?? 0) + sample.d);
  }
  const top5 = [...inside].filter(([key]) => !key.startsWith("(")).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, us]) => `${Math.round(us / 1000)} ms ${key}`);
  return `  at +${Math.round((task.ts - start) / 1000)} ms, ${Math.round(task.dur / 1000)} ms: ${top5.join(" | ")}`;
});
const hot = [...self]
  .filter(([key]) => !["(program)", "(idle)", "(garbage collector)", "(root)"].some((skip) => key.startsWith(skip)))
  .filter(([key]) => !filter || key.includes(filter))
  .sort((a, b) => b[1] - a[1])
  .slice(0, top)
  .map(([key, us]) => `${Math.round(us / 1000)} ms  ${key}`);
const sampled = [...self].reduce((sum, [, us]) => sum + us, 0) / 1000;
const idle = self.get("(idle) ") ?? 0;

console.log(`trace: ${file}`);
console.log(`main thread: pid ${pid} tid ${tid}; window ${Math.round((end - start) / 1000)} ms; tasks ${tasks.length}; busy ${Math.round(busyMs)} ms (${Math.round((busyMs / ((end - start) / 1000)) * 100)}%)`);
console.log(`long tasks (>=50 ms): ${longTasks.length}${longTasks.length ? `; top: ${longTasks.slice(0, 8).join(", ")} ms` : ""}`);
console.log(`busy ms per second: ${busyPerSecond.map((us) => Math.round(us / 1000)).join(" ")}`);
console.log(`categories (self): ${categories.join(" | ")}`);
console.log(`profile: ${Math.round(sampled)} ms sampled, ${Math.round(idle / 1000)} ms idle`);
console.log(`hot functions (self time)${filter ? ` matching ${filter}` : ""}:`);
for (const line of hot) console.log(`  ${line}`);
if (spikes.length) { console.log("spikes (tasks of 1 s or more):"); for (const line of spikes) console.log(line); }
