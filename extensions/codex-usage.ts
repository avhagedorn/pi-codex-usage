import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

type JsonObject = Record<string, unknown>;

type CodexAppServerMessage = {
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type CodexUsageRaw = {
  account?: unknown;
  response: JsonObject;
};

type UsageWindow = {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt?: number;
  resetsText?: string;
  windowMinutes?: number;
};

type UsageSummary = {
  fetchedAt: string;
  statusText: string;
  markdown: string;
  widgetLines: string[];
  windows: UsageWindow[];
  credits?: string;
  resetCredits?: string;
  plan?: string;
};

const EXTENSION_VERSION = "0.3.0";
const STATUS_KEY = "codex-usage";
const WIDGET_KEY = "codex-usage";
const STATUS_REFRESH_INTERVAL_MS = 60_000;
const APP_SERVER_TIMEOUT_MS = 20_000;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  removeAbortListener?: () => void;
};

let appServer: CodexAppServerClient | undefined;
let cachedSummary: UsageSummary | undefined;
let refreshInFlight: Promise<UsageSummary> | undefined;
let statusAutoRefreshTimer: NodeJS.Timeout | undefined;
let uiRequestId = 0;

type RefreshView = "widget" | "status";

export default function codexUsageExtension(pi: ExtensionAPI) {
  pi.registerCommand("codex-usage", {
    description:
      "Show Codex ChatGPT subscription usage windows, remaining percentage, credits, and reset times",
    getArgumentCompletions(prefix: string) {
      return ["refresh", "status", "hide", "help"]
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      if (action === "help" || action === "--help" || action === "-h") {
        showHelp(ctx);
        return;
      }

      if (["hide", "clear", "off"].includes(action)) {
        clearUsageUi(ctx);
        if (ctx.hasUI) ctx.ui.notify("Codex usage display hidden", "info");
        return;
      }

      const requestId = ++uiRequestId;
      const view: RefreshView = action === "status" ? "status" : "widget";
      const cached = cachedSummary;

      if (view === "status") {
        startStatusAutoRefresh(ctx, requestId);
      } else {
        stopStatusAutoRefresh();
      }

      if (ctx.hasUI) {
        if (view === "widget") {
          ctx.ui.setWidget(WIDGET_KEY, cached?.widgetLines ?? [
            "Codex usage",
            "Refreshing…",
          ]);
        } else {
          ctx.ui.setStatus(STATUS_KEY, "Codex usage: refreshing…");
        }
      }

      // Render the cached value immediately, then replace it when the refresh
      // completes. The command no longer waits for app-server startup/network I/O.
      void refreshAndRender(ctx, { view, requestId, notify: true }).catch(() => undefined);
    },
  });

  pi.registerTool({
    name: "codex_usage",
    label: "Codex Usage",
    description:
      "Check current Codex ChatGPT subscription usage limits, remaining percentages, credits, and reset times via the local Codex CLI app-server.",
    promptSnippet: "Check current Codex subscription rate-limit windows and reset times",
    promptGuidelines: [
      "Use codex_usage when the user asks how much Codex subscription usage, weekly usage, 5-hour usage, credits, or reset time remains.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const raw = await fetchCodexUsage(signal);
      const summary = summarizeUsage(raw);
      return {
        content: [{ type: "text", text: summary.markdown }],
        details: summary,
      };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    cachedSummary = undefined;
    refreshInFlight = undefined;
    uiRequestId = 0;
    appServer = ctx.hasUI ? new CodexAppServerClient() : undefined;
    if (ctx.hasUI) clearUsageUi(ctx);

    // Warm the persistent app-server connection in the background. The first
    // command is then normally served from the cache instead of waiting for
    // process startup and the rate-limits request.
    if (ctx.hasUI) void refreshUsage().catch(() => undefined);
  });

  pi.on("input", (_event, ctx) => {
    // Usage is a transient view: clear it when the user starts the next prompt.
    // Bump the request id so an older refresh cannot put the widget back.
    if (ctx.hasUI) clearUsageUi(ctx);
  });

  pi.on("session_shutdown", () => {
    uiRequestId++;
    stopStatusAutoRefresh();
    appServer?.close();
    appServer = undefined;
    refreshInFlight = undefined;
  });
}

function showHelp(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, [
    "Codex usage commands",
    "  /codex-usage          refresh and show usage above the editor",
    "  /codex-usage status   refresh footer status every 60 seconds",
    "  /codex-usage hide     clear footer/widget status",
    "",
    "Uses `codex app-server --listen stdio://` and `account/rateLimits/read`.",
    "If auth is expired, run `codex login` and retry.",
  ]);
}

function clearUsageUi(ctx: ExtensionContext) {
  uiRequestId++;
  stopStatusAutoRefresh();
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, undefined);
  ctx.ui.setWidget(WIDGET_KEY, undefined);
}

function startStatusAutoRefresh(ctx: ExtensionContext, requestId: number) {
  stopStatusAutoRefresh();
  if (!ctx.hasUI) return;

  statusAutoRefreshTimer = setInterval(() => {
    if (requestId !== uiRequestId) {
      stopStatusAutoRefresh();
      return;
    }

    void refreshAndRender(ctx, {
      view: "status",
      requestId,
      notify: false,
    }).catch(() => undefined);
  }, STATUS_REFRESH_INTERVAL_MS);
}

function stopStatusAutoRefresh() {
  if (statusAutoRefreshTimer) {
    clearInterval(statusAutoRefreshTimer);
    statusAutoRefreshTimer = undefined;
  }
}

async function refreshAndRender(
  ctx: ExtensionContext,
  options: { view: RefreshView; requestId: number; notify: boolean },
): Promise<UsageSummary> {
  const summary = await refreshUsage(ctx.signal).catch((error) => {
    const message = friendlyError(error);
    if (ctx.hasUI && options.requestId === uiRequestId) {
      if (options.view === "status") {
        ctx.ui.setStatus(STATUS_KEY, "Codex usage: unavailable");
        if (options.notify) ctx.ui.notify(message, "error");
      } else {
        ctx.ui.setWidget(WIDGET_KEY, [
          "Codex usage unavailable",
          message,
          "",
          "Try: `codex login`, then `/codex-usage`.",
        ]);
      }
    }
    throw error;
  });

  if (ctx.hasUI && options.requestId === uiRequestId) {
    if (options.view === "status") {
      ctx.ui.setStatus(STATUS_KEY, summary.statusText);
      if (options.notify) ctx.ui.notify("Codex usage updated", "info");
    } else {
      ctx.ui.setWidget(WIDGET_KEY, summary.widgetLines);
    }
  }

  return summary;
}

function refreshUsage(signal?: AbortSignal): Promise<UsageSummary> {
  if (!refreshInFlight) {
    refreshInFlight = fetchCodexUsage(signal)
      .then(summarizeUsage)
      .then((summary) => {
        cachedSummary = summary;
        return summary;
      })
      .finally(() => {
        refreshInFlight = undefined;
      });
  }
  return refreshInFlight;
}

function fetchCodexUsage(signal?: AbortSignal): Promise<CodexUsageRaw> {
  const client = appServer ??= new CodexAppServerClient();
  return client.readUsage(signal);
}

class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private initPromise: Promise<void> | undefined;
  private nextRequestId = 1;
  private output: Interface | undefined;
  private stderrBuffer = "";
  private pending = new Map<number, PendingRequest>();
  private closed = false;

  async readUsage(signal?: AbortSignal): Promise<CodexUsageRaw> {
    await this.initialize(signal);
    const [account, response] = await Promise.all([
      this.request("account/read", { refreshToken: false }, signal),
      this.request("account/rateLimits/read", {}, signal),
    ]);
    return { account, response: asObject(response) ?? {} };
  }

  close(): void {
    this.closed = true;
    const error = new Error("Codex app-server closed");
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.removeAbortListener?.();
      request.reject(error);
    }
    this.pending.clear();
    this.initPromise = undefined;
    this.output?.close();
    this.output = undefined;
    this.child?.kill();
    this.child = undefined;
  }

  private initialize(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Codex app-server client is closed"));
    if (this.child && this.initPromise) return this.initPromise;

    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        RUST_LOG: process.env.RUST_LOG ?? "error",
      },
    });
    this.child = child;
    this.stderrBuffer = "";
    this.output = createInterface({ input: child.stdout });
    this.output.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString("utf8");
      if (this.stderrBuffer.length > 8_000) this.stderrBuffer = this.stderrBuffer.slice(-8_000);
    });
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, maybeSignal) => {
      if (!this.closed && this.child === child) {
        this.fail(new Error(
          `Codex app-server exited early (${maybeSignal ?? `code ${code}`})${
            this.stderrBuffer.trim() ? `: ${this.stderrBuffer.trim()}` : ""
          }`,
        ));
      }
      if (this.child === child) this.child = undefined;
    });

    this.initPromise = this.request("initialize", {
      clientInfo: {
        name: "pi_codex_usage",
        title: "pi Codex Usage",
        version: EXTENSION_VERSION,
      },
      capabilities: {
        optOutNotificationMethods: ["remoteControl/status/changed"],
      },
    }, signal).then(() => {
      this.send({ method: "initialized", params: {} });
    }).catch((error) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    });

    return this.initPromise;
  }

  private request(method: string, params: JsonObject, signal?: AbortSignal): Promise<unknown> {
    const child = this.child;
    if (!child || this.closed) return Promise.reject(new Error("Codex app-server is not running"));
    if (signal?.aborted) return Promise.reject(new Error("Cancelled"));

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        request.removeAbortListener?.();
        reject(new Error(`Timed out after ${APP_SERVER_TIMEOUT_MS / 1000}s waiting for ${method}`));
      }, APP_SERVER_TIMEOUT_MS);
      const pending: PendingRequest = { resolve, reject, timeout };

      if (signal) {
        const onAbort = () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timeout);
          reject(new Error("Cancelled"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }

      this.pending.set(id, pending);
      try {
        this.send({ method, id, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        pending.removeAbortListener?.();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private send(message: JsonObject): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error("Codex app-server stdin is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line) as CodexAppServerMessage;
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      pending.removeAbortListener?.();
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex app-server request failed"));
      } else {
        pending.resolve(message.result);
      }
    } catch {
      // Ignore non-JSON output; the app-server protocol is line-delimited JSON.
    }
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.removeAbortListener?.();
      request.reject(error);
    }
    this.pending.clear();
    this.initPromise = undefined;
    this.output?.close();
    this.output = undefined;
    if (this.child) {
      this.child.kill();
      this.child = undefined;
    }
  }
}

function summarizeUsage(raw: CodexUsageRaw): UsageSummary {
  const response = raw.response;
  const snapshots = collectSnapshots(response);
  const windows: UsageWindow[] = [];
  const creditLines: string[] = [];
  let plan = extractPlan(raw.account, snapshots);
  let individualLimitLine: string | undefined;

  for (const snapshot of snapshots) {
    const limitName = stringValue(snapshot.limitName ?? snapshot.limit_name) ?? stringValue(snapshot.limitId ?? snapshot.limit_id);
    const prefix = limitName && limitName !== "codex" ? `${limitName} ` : "";

    const primary = asObject(snapshot.primary);
    const secondary = asObject(snapshot.secondary);
    const primaryWindow = primary
      ? makeWindow(
          `${prefix}${durationLabel(numberValue(primary.windowDurationMins ?? primary.window_minutes), "5h")} limit`,
          primary,
        )
      : undefined;
    const secondaryWindow = secondary
      ? makeWindow(
          `${prefix}${durationLabel(numberValue(secondary.windowDurationMins ?? secondary.window_minutes), "weekly")} limit`,
          secondary,
        )
      : undefined;
    if (primaryWindow) windows.push(primaryWindow);
    if (secondaryWindow) windows.push(secondaryWindow);

    const credits = asObject(snapshot.credits);
    const creditLine = formatCredits(credits);
    if (creditLine) creditLines.push(creditLine);

    const individualLimit = asObject(snapshot.individualLimit ?? snapshot.individual_limit);
    if (individualLimit) {
      individualLimitLine = formatIndividualLimit(individualLimit);
    }

    plan = plan ?? stringValue(snapshot.planType ?? snapshot.plan_type);
  }

  const resetCredits = formatResetCredits(asObject(response.rateLimitResetCredits ?? response.rate_limit_reset_credits));
  const credits = unique(creditLines).join("; ") || undefined;
  const fetchedAt = new Date().toLocaleString();

  const lines: string[] = [];
  lines.push(`Codex usage — updated ${fetchedAt}`);
  if (plan) lines.push(`Plan: ${plan}`);

  if (windows.length === 0) {
    lines.push("Limits: not available for this account");
  } else {
    const labelWidth = Math.max(...windows.map((window) => window.label.length));
    for (const window of windows) {
      lines.push(formatWindowLine(window, labelWidth));
    }
  }

  if (individualLimitLine) lines.push(individualLimitLine);
  if (credits) lines.push(`Credits: ${credits}`);
  if (resetCredits) lines.push(`Banked resets: ${resetCredits}`);

  const markdown = [
    "# Codex usage",
    "",
    ...(plan ? [`- Plan: ${plan}`] : []),
    ...windows.map((window) => `- ${window.label}: ${window.usedPercent.toFixed(0)}% used · ${window.remainingPercent.toFixed(0)}% left${window.resetsText ? ` — resets ${window.resetsText}` : ""}`),
    ...(individualLimitLine ? [`- ${individualLimitLine}`] : []),
    ...(credits ? [`- Credits: ${credits}`] : []),
    ...(resetCredits ? [`- Banked resets: ${resetCredits}`] : []),
    "",
    `Fetched: ${fetchedAt}`,
  ].join("\n");

  return {
    fetchedAt,
    statusText: compactStatus(windows, credits),
    markdown,
    widgetLines: lines,
    windows,
    credits,
    resetCredits,
    plan,
  };
}

function collectSnapshots(response: JsonObject): JsonObject[] {
  const byId = asObject(response.rateLimitsByLimitId ?? response.rate_limits_by_limit_id);
  if (byId) {
    const values = Object.values(byId).map(asObject).filter(Boolean) as JsonObject[];
    if (values.length > 0) return values;
  }

  const single = asObject(response.rateLimits ?? response.rate_limits);
  return single ? [single] : [];
}

function makeWindow(label: string, window: JsonObject): UsageWindow | undefined {
  const used = numberValue(window.usedPercent ?? window.used_percent);
  if (used === undefined) return undefined;
  const usedPercent = clamp(used, 0, 100);
  const remainingPercent = clamp(100 - usedPercent, 0, 100);
  const resetsAt = numberValue(window.resetsAt ?? window.resets_at ?? window.resetAt ?? window.reset_at);
  const windowMinutes = numberValue(window.windowDurationMins ?? window.window_minutes);
  return {
    label: capitalizeLabel(label),
    usedPercent,
    remainingPercent,
    resetsAt,
    resetsText: resetsAt ? formatReset(resetsAt) : undefined,
    windowMinutes,
  };
}

function formatWindowLine(window: UsageWindow, labelWidth: number): string {
  const label = `${window.label}:`.padEnd(labelWidth + 1);
  const bar = progressBar(window.usedPercent);
  const reset = window.resetsText ? ` · resets ${window.resetsText}` : "";
  return `${label} ${bar} ${window.usedPercent.toFixed(0)}% used · ${window.remainingPercent.toFixed(0)}% left${reset}`;
}

function compactStatus(windows: UsageWindow[], credits?: string): string {
  if (windows.length === 0) return credits ? `Codex usage: ${credits}` : "Codex usage: n/a";

  // The API has changed which window is primary over time. Use the duration
  // instead of assuming the first window is always the 5-hour limit.
  const short = windows.find((window) => (window.windowMinutes ?? Infinity) < 10_000);
  const weekly = windows.find(
    (window) => (window.windowMinutes ?? 0) >= 10_000 || /week/i.test(window.label),
  );
  const parts: string[] = [];
  if (short) parts.push(`${compactWindowLabel(short)} ${short.usedPercent.toFixed(0)}% used`);
  if (weekly && weekly !== short) parts.push(`wk ${weekly.usedPercent.toFixed(0)}% used`);
  if (parts.length === 0) {
    const first = windows[0];
    parts.push(`${compactWindowLabel(first)} ${first.usedPercent.toFixed(0)}% used`);
  }
  return `Codex ${parts.join(" · ")}`;
}

function compactWindowLabel(window: UsageWindow): string {
  if (window.windowMinutes === 300) return "5h";
  if (window.windowMinutes !== undefined && window.windowMinutes >= 10_000) return "wk";
  return window.label.replace(/\s+limit$/i, "");
}

function durationLabel(minutes: number | undefined, fallback: string): string {
  if (!minutes || !Number.isFinite(minutes)) return fallback;
  if (minutes === 300) return "5h";
  if (minutes === 60) return "1h";
  if (minutes === 1_440) return "daily";
  if (minutes >= 10_000 && minutes <= 10_200) return "weekly";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatCredits(credits?: JsonObject): string | undefined {
  if (!credits) return undefined;
  if (booleanValue(credits.hasCredits ?? credits.has_credits) === false) return undefined;
  if (booleanValue(credits.unlimited)) return "unlimited";
  const balance = stringValue(credits.balance);
  if (!balance || balance === "0") return undefined;
  return `${Math.round(Number(balance) || 0).toString()} credits`;
}

function formatResetCredits(summary?: JsonObject): string | undefined {
  if (!summary) return undefined;
  const count = numberValue(summary.availableCount ?? summary.available_count);
  if (!count || count <= 0) return undefined;
  const credits = Array.isArray(summary.credits) ? summary.credits : [];
  const expiry = credits
    .map(asObject)
    .map((credit) => numberValue(credit?.expiresAt ?? credit?.expires_at))
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b)[0];
  return `${count.toFixed(0)} available${expiry ? `, next expires ${formatReset(expiry)}` : ""}`;
}

function formatIndividualLimit(limit: JsonObject): string | undefined {
  const remaining = numberValue(limit.remainingPercent ?? limit.remaining_percent);
  const used = stringValue(limit.used);
  const total = stringValue(limit.limit);
  const resetsAt = numberValue(limit.resetsAt ?? limit.resets_at);
  const bits = [
    remaining !== undefined ? `${remaining.toFixed(0)}% left` : undefined,
    used && total ? `${used} used / ${total}` : undefined,
    resetsAt ? `resets ${formatReset(resetsAt)}` : undefined,
  ].filter(Boolean);
  return bits.length ? `Spend control: ${bits.join(" • ")}` : undefined;
}

function extractPlan(account: unknown, snapshots: JsonObject[]): string | undefined {
  const accountObj = asObject(account);
  const nestedAccount = asObject(accountObj?.account);
  const fromAccount = stringValue(nestedAccount?.planType ?? nestedAccount?.plan_type);
  if (fromAccount) return fromAccount;
  for (const snapshot of snapshots) {
    const plan = stringValue(snapshot.planType ?? snapshot.plan_type);
    if (plan) return plan;
  }
  return undefined;
}

function formatReset(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const absolute = date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const relative = relativeTime(date.getTime() - Date.now());
  return `${absolute}${relative ? ` (${relative})` : ""}`;
}

function relativeTime(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  const suffix = deltaMs >= 0 ? "from now" : "ago";
  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${deltaMs >= 0 ? "in " : ""}${minutes}m${deltaMs >= 0 ? "" : ` ${suffix}`}`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 48) return `${deltaMs >= 0 ? "in " : ""}${hours}h${mins ? ` ${mins}m` : ""}${deltaMs >= 0 ? "" : ` ${suffix}`}`;
  const days = Math.round(hours / 24);
  return `${deltaMs >= 0 ? "in " : ""}${days}d${deltaMs >= 0 ? "" : ` ${suffix}`}`;
}

function progressBar(percentUsed: number): string {
  const width = 12;
  const filled = Math.round((clamp(percentUsed, 0, 100) / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|spawn codex/i.test(message)) {
    return "Codex CLI was not found on PATH. Install Codex or make `codex` available to pi.";
  }
  if (/401|Unauthorized|token_expired|refresh token|session has ended|requiresOpenaiAuth/i.test(message)) {
    return "Codex ChatGPT auth is missing or expired. Run `codex login` (or `codex logout && codex login`) and retry `/codex-usage`.";
  }
  if (/method not found/i.test(message)) {
    return "This Codex version does not expose account/rateLimits/read. Update Codex and retry.";
  }
  return message.split("\n")[0] || "Failed to fetch Codex usage.";
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|1)$/i.test(value)) return true;
    if (/^(false|0)$/i.test(value)) return false;
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function capitalizeLabel(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}
