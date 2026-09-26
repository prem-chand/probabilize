// The Build's Python worker. Created by build-runtime.ts with
// `new Worker(new URL("./build-worker.ts", import.meta.url))`, which Turbopack
// bundles as a classic worker, so Pyodide arrives through importScripts.
// Contract: docs/THE-BUILD.md § Runtime.

import { appendCapped } from "./build-state.mjs";
import type { CheckResult } from "./build-state.mjs";

const PYODIDE_VERSION = "0.27.0";
const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
// Same pin as the Lesson runtime (src/lib/pyodide-runtime.ts).
const PYODIDE_SRI = "sha384-Jbsp01bfi5QMUu9TQeO+5kXvBTqk5CQkcSgbSP9rSEDuQnaamwBF7YDKrSsBmfXw";

const OUTPUT_BATCH_MS = 100;
const FRAME_INTERVAL_MS = 50;
const MAX_FRAME_SIZE = 256;
const MAX_SUMMARY_CHARS = 20_000;
const MOUNTABLE = /^(mine|world|artifacts)\/[a-z0-9_]+(\/[a-z0-9_]+)*\.(py|json)$/;

/** Workspace path → file text, mounted under /home/pyodide before every run. */
export type Tree = Record<string, string>;

export type WorkerRequest =
  | { type: "init"; generation: number; interrupt: SharedArrayBuffer | null }
  | { type: "scratch"; generation: number; runId: number; rung: number; code: string; tree: Tree }
  | { type: "check"; generation: number; runId: number; source: string; tree: Tree }
  | { type: "reset"; generation: number };

export type WorkerOutcome =
  | { kind: "ok" }
  | { kind: "checked"; result: CheckResult }
  | { kind: "error"; message: string }
  | { kind: "interrupted" };

export type WorkerMessage =
  | { type: "ready"; generation: number; loadMs: number }
  | { type: "load-failed"; generation: number; message: string }
  | { type: "output"; generation: number; runId: number; text: string; truncated: boolean }
  | { type: "frame"; generation: number; runId: number; labels: Uint8Array; size: number; summary: string }
  | { type: "done"; generation: number; runId: number; outcome: WorkerOutcome };

interface PyProxy {
  toJs(): unknown;
  destroy(): void;
  get(key: string): unknown;
}

interface Pyodide {
  loadPackage(names: string[], options?: { messageCallback?: (message: string) => void }): Promise<void>;
  runPython(code: string, options?: { globals?: PyProxy }): unknown;
  runPythonAsync(code: string, options?: { globals?: PyProxy }): Promise<unknown>;
  setStdout(options: { batched: (line: string) => void }): void;
  setStderr(options: { batched: (line: string) => void }): void;
  setInterruptBuffer(buffer: Int32Array): void;
  registerJsModule(name: string, module: object): void;
  toPy(value: unknown): PyProxy;
  globals: PyProxy;
}

interface WorkerScope {
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  loadPyodide(options: { indexURL: string }): Promise<Pyodide>;
}

declare function importScripts(...urls: string[]): void;

const scope = self as unknown as WorkerScope;

// The prepare step: rewrite the authoritative tree, forget imported learner and
// world modules, and never trust bytecode, so a same-length edit inside one
// mtime tick still takes effect.
const PRELUDE = `
import importlib, os, shutil, sys
sys.dont_write_bytecode = True
_BUILD_HOME = "/home/pyodide"
if _BUILD_HOME not in sys.path:
    sys.path.insert(0, _BUILD_HOME)

def _build_prepare(tree):
    for root in ("mine", "world", "artifacts"):
        shutil.rmtree(os.path.join(_BUILD_HOME, root), ignore_errors=True)
    for path, source in tree.items():
        full = os.path.join(_BUILD_HOME, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as handle:
            handle.write(source)
    for name in list(sys.modules):
        if name in ("mine", "world") or name.startswith(("mine.", "world.")):
            del sys.modules[name]
    importlib.invalidate_caches()
    os.chdir(_BUILD_HOME)
`;

const CHECK_CODE = `
import json
from world.check import run_check
json.dumps(run_check(_build_check_source))
`;

let generation = 0;
let pyodide: Pyodide | null = null;
let interrupt: Int32Array | null = null;
const namespaces = new Map<number, PyProxy>();
// A reset that arrives while an awaiting run still holds its namespace waits
// for that run to finish.
let resetPending = false;

/** Output and frame state for the run in progress. */
let run: {
  runId: number;
  output: string;
  pending: string;
  lastFlush: number;
  truncated: boolean;
  frame: { labels: Uint8Array; size: number; summary: string } | null;
  lastFrame: number;
} | null = null;

function post(message: WorkerMessage, transfer: Transferable[] = []) {
  scope.postMessage(message, transfer);
}

function flushOutput(force: boolean) {
  if (!run || !run.pending) return;
  const now = Date.now();
  if (!force && now - run.lastFlush < OUTPUT_BATCH_MS) return;
  post({ type: "output", generation, runId: run.runId, text: run.pending, truncated: run.truncated });
  run.pending = "";
  run.lastFlush = now;
}

function write(line: string) {
  if (!run || run.truncated) return;
  const next = appendCapped(run.output, `${line}\n`);
  run.pending += next.text.slice(run.output.length);
  run.output = next.text;
  run.truncated = next.truncated;
  flushOutput(run.truncated);
}

function flushFrame(force: boolean) {
  if (!run?.frame) return;
  const now = Date.now();
  if (!force && now - run.lastFrame < FRAME_INTERVAL_MS) return;
  const { labels, size, summary } = run.frame;
  post({ type: "frame", generation, runId: run.runId, labels, size, summary }, [labels.buffer]);
  run.frame = null;
  run.lastFrame = now;
}

/** `buildhost.frame(bytes, size, summary_json)`, called by world/build.py's show(). */
function frame(bytes: unknown, size: unknown, summary: unknown) {
  let labels: Uint8Array | null = null;
  const proxy = bytes as Partial<PyProxy> | null;
  if (proxy && typeof proxy.toJs === "function") {
    const converted = proxy.toJs();
    proxy.destroy?.();
    if (converted instanceof Uint8Array) labels = new Uint8Array(converted);
  } else if (bytes instanceof Uint8Array) {
    labels = new Uint8Array(bytes);
  }
  const n = Number(size);
  if (!run || !labels || !Number.isInteger(n) || n < 1 || n > MAX_FRAME_SIZE || labels.length !== n * n) return;
  run.frame = { labels, size: n, summary: String(summary ?? "").slice(0, MAX_SUMMARY_CHARS) };
  flushFrame(false);
}

async function loadRuntime(): Promise<Pyodide> {
  const response = await fetch(`${PYODIDE_INDEX_URL}pyodide.js`, { mode: "cors", credentials: "omit" });
  if (!response.ok) throw new Error(`The Python runtime download failed (HTTP ${response.status}).`);
  const bytes = await response.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-384", bytes));
  const actual = `sha384-${btoa(String.fromCharCode(...digest))}`;
  if (actual !== PYODIDE_SRI) throw new Error("The Python runtime failed its integrity check, so it was not run.");
  const url = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
  try {
    importScripts(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const py = await scope.loadPyodide({ indexURL: PYODIDE_INDEX_URL });
  await py.loadPackage(["numpy"], { messageCallback: () => {} });
  if (interrupt) py.setInterruptBuffer(interrupt);
  py.registerJsModule("buildhost", { frame });
  py.setStdout({ batched: write });
  py.setStderr({ batched: write });
  py.runPython(PRELUDE);
  return py;
}

function mount(py: Pyodide, tree: Tree) {
  const safe = Object.fromEntries(Object.entries(tree).filter(([path]) => MOUNTABLE.test(path)));
  const dict = py.toPy(safe);
  try {
    (py.globals.get("_build_prepare") as (tree: PyProxy) => void)(dict);
  } finally {
    dict.destroy();
  }
}

function namespaceFor(py: Pyodide, rung: number): PyProxy {
  let ns = namespaces.get(rung);
  if (!ns) {
    ns = py.toPy({ __name__: "__main__" });
    namespaces.set(rung, ns);
  }
  return ns;
}

function resetNamespaces() {
  if (run) {
    resetPending = true;
    return;
  }
  resetPending = false;
  for (const ns of namespaces.values()) ns.destroy();
  namespaces.clear();
}

function parseCheckResult(raw: unknown): CheckResult | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    if (typeof value.ok !== "boolean") return null;
    return {
      ok: value.ok,
      message: text(value.message) ?? "",
      file: text(value.file),
      symbol: text(value.symbol),
      traceback: text(value.traceback),
    };
  } catch {
    return null;
  }
}

function describe(err: unknown): WorkerOutcome {
  const type = (err as { type?: string } | null)?.type;
  if (type === "KeyboardInterrupt") return { kind: "interrupted" };
  return { kind: "error", message: err instanceof Error ? err.message : String(err) };
}

async function execute(runId: number, body: (py: Pyodide) => Promise<WorkerOutcome>) {
  const py = pyodide;
  if (!py) {
    post({ type: "done", generation, runId, outcome: { kind: "error", message: "Python is not loaded." } });
    return;
  }
  run = { runId, output: "", pending: "", lastFlush: Date.now(), truncated: false, frame: null, lastFrame: 0 };
  if (interrupt) Atomics.store(interrupt, 0, 0);
  let outcome: WorkerOutcome;
  try {
    outcome = await body(py);
  } catch (err) {
    outcome = describe(err);
  } finally {
    if (interrupt) Atomics.store(interrupt, 0, 0);
  }
  flushOutput(true);
  flushFrame(true);
  run = null;
  if (resetPending) resetNamespaces();
  post({ type: "done", generation, runId, outcome });
}

scope.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case "init": {
      generation = message.generation;
      interrupt = message.interrupt ? new Int32Array(message.interrupt) : null;
      const started = Date.now();
      loadRuntime().then(
        (py) => {
          pyodide = py;
          post({ type: "ready", generation, loadMs: Date.now() - started });
        },
        (err) => post({ type: "load-failed", generation, message: err instanceof Error ? err.message : String(err) }),
      );
      return;
    }
    case "scratch":
      void execute(message.runId, async (py) => {
        mount(py, message.tree);
        await py.runPythonAsync(message.code, { globals: namespaceFor(py, message.rung) });
        return { kind: "ok" };
      });
      return;
    case "check":
      void execute(message.runId, async (py) => {
        mount(py, message.tree);
        const globals = py.toPy({ __name__: "__main__", _build_check_source: message.source });
        try {
          const result = parseCheckResult(await py.runPythonAsync(CHECK_CODE, { globals }));
          if (!result) return { kind: "error", message: "The check harness returned something other than a result." };
          return { kind: "checked", result };
        } finally {
          globals.destroy();
        }
      });
      return;
    case "reset":
      resetNamespaces();
      return;
  }
};
