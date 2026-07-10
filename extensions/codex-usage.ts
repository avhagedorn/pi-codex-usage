import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

type JsonObject = Record<string, unknown>;

type CodexAppServerMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type CodexUsageRaw = {
  account?: unknown;
  response: JsonObject;
};

type UsageWindow = {
  label: string;
  limitName?: string;
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

const EXTENSION_VERSION = "0.1.0";
const STATUS_KEY = "codex-usage";
const WIDGET_KEY = "codex-usage";
const AUTO_REFRESH_MIN_MS = 5 * 60 * 1000;
const APP_SERVER_TIMEOUT_MS = 20_000;

let watchEnabled = false;
let lastRefreshAt = 0;
let refreshInFlight: Promise<UsageSummary> | undefined;

export default function codexUsageExtension(pi: ExtensionAPI) {
  pi.registerCommand("codex-usage", {
    description:
      "Show Codex ChatGPT subscription usage windows, remaining percentage, credits, and reset times",
    getArgumentCompletions(prefix: string) {
      return ["refresh", "status", "watch", "unwatch", "hide", "help"]
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      if (action === "help" || action === "--help" || action === "-h") {
        showHelp(pi, ctx);
        return;
      }

      if (["hide", "clear", "off"].includes(action)) {
        watchEnabled = false;
        clearUsageUi(ctx);
        ctx.ui.notify("Codex usage display hidden", "info");
        return;
      }

      if (["watch", "on", "auto"].includes(action)) {
        watchEnabled = true;
        await refreshAndRender(pi, ctx, { widget: true, notify: true, status: true }).catch(() => undefined);
        ctx.ui.notify("Codex usage auto-refresh enabled for this pi session", "info");
        return;
      }

      if (["unwatch", "stop", "auto-off"].includes(action)) {
        watchEnabled = false;
        ctx.ui.notify("Codex usage auto-refresh disabled", "info");
        return;
      }

      await refreshAndRender(pi, ctx, {
        widget: action !== "status",
        notify: action === "status",
        status: action === "status",
      }).catch(() => undefined);
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
    if (ctx.hasUI) clearUsageUi(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!watchEnabled || !ctx.hasUI) return;
    if (Date.now() - lastRefreshAt < AUTO_REFRESH_MIN_MS) return;
    await refreshAndRender(pi, ctx, { widget: false, notify: false, status: true }).catch(() => undefined);
  });
}

function showHelp(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  showTranscript(pi, [
    "Codex usage commands",
    "  /codex-usage          refresh and print usage here",
    "  /codex-usage status   refresh compact footer status only",
    "  /codex-usage watch    refresh after pi turns, at most every 5 minutes",
    "  /codex-usage unwatch  stop automatic refresh",
    "  /codex-usage hide     clear footer/widget status",
    "",
    "Uses `codex app-server --listen stdio://` and `account/rateLimits/read`.",
    "If auth is expired, run `codex login` and retry.",
  ]);
}

function clearUsageUi(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, undefined);
  ctx.ui.setWidget(WIDGET_KEY, undefined);
}

function showTranscript(pi: ExtensionAPI, lines: string[]): void {
  pi.sendMessage({
    customType: "codex-usage",
    content: lines.join("\n"),
    display: true,
  });
}

async function refreshAndRender(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: { widget: boolean; notify: boolean; status: boolean },
): Promise<UsageSummary> {
  if (ctx.hasUI && options.status) {
    ctx.ui.setStatus(STATUS_KEY, "Codex usage: refreshing…");
  }

  const summary = await refreshUsage(ctx.signal).catch(async (error) => {
    const message = friendlyError(error);
    if (ctx.hasUI) {
      if (options.status) ctx.ui.setStatus(STATUS_KEY, "Codex usage: unavailable");
      if (options.widget) {
        showTranscript(pi, [
          "Codex usage unavailable",
          message,
          "",
          "Try: `codex login`, then `/codex-usage`.",
        ]);
      }
      if (options.notify) ctx.ui.notify(message, "error");
    }
    throw error;
  });

  lastRefreshAt = Date.now();

  if (ctx.hasUI) {
    if (options.status) ctx.ui.setStatus(STATUS_KEY, summary.statusText);
    if (options.widget) showTranscript(pi, summary.widgetLines);
    if (options.notify && !options.widget) ctx.ui.notify("Codex usage updated", "info");
  }

  return summary;
}

function refreshUsage(signal?: AbortSignal): Promise<UsageSummary> {
  if (!refreshInFlight) {
    refreshInFlight = fetchCodexUsage(signal)
      .then(summarizeUsage)
      .finally(() => {
        refreshInFlight = undefined;
      });
  }
  return refreshInFlight;
}

function fetchCodexUsage(signal?: AbortSignal): Promise<CodexUsageRaw> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let account: unknown;

    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        RUST_LOG: process.env.RUST_LOG ?? "error",
      },
    });

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timeout);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      if (!child.killed) child.kill();
    };

    const finish = (error?: Error, value?: CodexUsageRaw) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value!);
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Timed out after ${APP_SERVER_TIMEOUT_MS / 1000}s waiting for Codex app-server`));
    }, APP_SERVER_TIMEOUT_MS);

    const onAbort = () => finish(new Error("Cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => finish(error));
    child.on("exit", (code, maybeSignal) => {
      if (!settled && code !== 0) {
        finish(
          new Error(
            `Codex app-server exited early (${maybeSignal ?? `code ${code}`})${
              stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ""
            }`,
          ),
        );
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
      if (stderrBuffer.length > 8_000) stderrBuffer = stderrBuffer.slice(-8_000);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: CodexAppServerMessage;
        try {
          message = JSON.parse(line) as CodexAppServerMessage;
        } catch {
          continue;
        }
        handleMessage(message);
      }
    });

    const send = (message: JsonObject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const handleMessage = (message: CodexAppServerMessage) => {
      if (message.id === 1) {
        if (message.error) {
          finish(new Error(message.error.message ?? "Codex app-server initialize failed"));
          return;
        }
        send({ method: "initialized", params: {} });
        send({ method: "account/read", id: 2, params: { refreshToken: false } });
        send({ method: "account/rateLimits/read", id: 3 });
        return;
      }

      if (message.id === 2) {
        account = message.result;
        return;
      }

      if (message.id === 3) {
        if (message.error) {
          const details = stderrBuffer.trim();
          finish(new Error(`${message.error.message ?? "Codex rate-limit request failed"}${details ? `\n${details}` : ""}`));
          return;
        }
        finish(undefined, { account, response: asObject(message.result) });
      }
    };

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "pi_codex_usage",
          title: "pi Codex Usage",
          version: EXTENSION_VERSION,
        },
        capabilities: {
          optOutNotificationMethods: ["remoteControl/status/changed"],
        },
      },
    });
  });
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
    const primaryWindow = primary ? makeWindow(`${prefix}${durationLabel(numberValue(primary.windowDurationMins ?? primary.window_minutes), "5h")} limit`, primary, limitName) : undefined;
    const secondaryWindow = secondary ? makeWindow(`${prefix}${durationLabel(numberValue(secondary.windowDurationMins ?? secondary.window_minutes), "weekly")} limit`, secondary, limitName) : undefined;
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

function makeWindow(label: string, window: JsonObject, limitName?: string): UsageWindow | undefined {
  const used = numberValue(window.usedPercent ?? window.used_percent);
  if (used === undefined) return undefined;
  const usedPercent = clamp(used, 0, 100);
  const remainingPercent = clamp(100 - usedPercent, 0, 100);
  const resetsAt = numberValue(window.resetsAt ?? window.resets_at ?? window.resetAt ?? window.reset_at);
  const windowMinutes = numberValue(window.windowDurationMins ?? window.window_minutes);
  return {
    label: capitalizeLabel(label),
    limitName,
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
  const primary = windows[0];
  const weekly = windows.find((window) => /week/i.test(window.label)) ?? windows[1];
  const parts = [`5h ${primary.usedPercent.toFixed(0)}% used`];
  if (weekly) parts.push(`wk ${weekly.usedPercent.toFixed(0)}% used`);
  return `Codex ${parts.join(" · ")}`;
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
  if (minutes < 60) return `in ${minutes}m`.replace("in ", deltaMs >= 0 ? "in " : "") + (deltaMs >= 0 ? "" : ` ${suffix}`);
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
