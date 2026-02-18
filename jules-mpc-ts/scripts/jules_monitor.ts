import { promises as fs } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const DEFAULT_API_BASE = "https://jules.googleapis.com/v1";
const DEFAULT_POLL_SECONDS = 45;
const DEFAULT_STUCK_MINUTES = 20;
const DEFAULT_STATE_PATH = ".monitor_state.json";
const DEFAULT_CONFIG_PATH = process.env.JULES_CONFIG ?? "jules-manager/config.json";

const ACTIONABLE_STATUSES = new Set(["COMPLETED", "FAILED", "ERROR", "CANCELLED"]);

type JsonRecord = Record<string, unknown>;

type JobState = {
  cursor?: string;
  last_status?: string;
  last_activity?: string;
};

function utcNow(): string {
  return new Date().toISOString();
}

export async function loadJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const content = await fs.readFile(path, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function loadConfig(path: string): Promise<JsonRecord> {
  return loadJson<JsonRecord>(path, {});
}

async function saveJson(path: string, payload: unknown): Promise<void> {
  await fs.mkdir(dirname(path) || ".", { recursive: true });
  await fs.writeFile(path, JSON.stringify(payload, null, 2), "utf8");
}

async function appendJsonl(path: string, payload: JsonRecord): Promise<void> {
  await fs.mkdir(dirname(path) || ".", { recursive: true });
  await fs.appendFile(path, `${JSON.stringify(payload)}\n`, "utf8");
}

async function loadJobs(path: string): Promise<JsonRecord[]> {
  try {
    const content = await fs.readFile(path, "utf8");
    const trimmed = content.trim();
    if (!trimmed) {
      return [];
    }
    if (trimmed.startsWith("[")) {
      const jobs = JSON.parse(trimmed) as JsonRecord[];
      return jobs.map((entry) =>
        typeof entry === "string" ? { job_id: entry } : entry
      );
    }
    return trimmed
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as JsonRecord)
      .map((entry) => (typeof entry === "string" ? { job_id: entry } : entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function buildHeaders(token?: string | null): HeadersInit {
  const headers: HeadersInit = { Accept: "application/json" };
  if (token) {
    (headers as Record<string, string>).Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchJson(url: string, token?: string | null): Promise<JsonRecord> {
  const response = await fetch(url, { headers: buildHeaders(token) });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`HTTP ${response.status} for ${url}: ${detail}`);
  }
  const text = await response.text();
  return text ? (JSON.parse(text) as JsonRecord) : {};
}

export function jobStatusUrl(apiBase: string, jobId: string): string {
  return `${apiBase.replace(/\/$/, "")}/jobs/${jobId}`;
}

export function jobMessagesUrl(
  apiBase: string,
  jobId: string,
  cursor?: string
): string {
  const base = `${apiBase.replace(/\/$/, "")}/jobs/${jobId}/messages`;
  if (!cursor) {
    return base;
  }
  return `${base}?cursor=${encodeURIComponent(cursor)}`;
}

export function isQuestionMessage(message: JsonRecord): boolean {
  const role = String(message.role ?? "").toLowerCase();
  const tags = Array.isArray(message.tags)
    ? message.tags.map((tag) => String(tag).toLowerCase()).join(" ")
    : "";
  const text = String(message.content ?? "").toLowerCase();
  return (
    tags.includes("question") ||
    tags.includes("needs_input") ||
    (text.includes("?") && role === "assistant")
  );
}

export function findActionableMessage(messages: JsonRecord[]): JsonRecord | undefined {
  return messages.find(isQuestionMessage);
}

export function shouldEmitStuck(
  lastActivity: string | undefined,
  thresholdMinutes: number
): boolean {
  if (!lastActivity) {
    return false;
  }
  const last = Date.parse(lastActivity);
  if (Number.isNaN(last)) {
    return false;
  }
  const delta = Date.now() - last;
  return delta >= thresholdMinutes * 60 * 1000;
}

export async function monitorOnce(
  jobs: JsonRecord[],
  state: Record<string, JobState>,
  apiBase: string,
  token: string | undefined,
  eventsPath: string,
  stuckMinutes: number
): Promise<void> {
  for (const job of jobs) {
    const jobId = String(job.job_id ?? "");
    if (!jobId) {
      continue;
    }

    const jobState = (state[jobId] ??= {});

    let statusPayload: JsonRecord;
    try {
      statusPayload = await fetchJson(jobStatusUrl(apiBase, jobId), token);
    } catch (error) {
      await appendJsonl(eventsPath, {
        event: "error",
        job_id: jobId,
        observed_at: utcNow(),
        message: (error as Error).message,
      });
      continue;
    }

    const status = statusPayload.status ? String(statusPayload.status) : undefined;
    if (status && status !== jobState.last_status) {
      jobState.last_status = status;
      jobState.last_activity = utcNow();
    }

    if (status && ACTIONABLE_STATUSES.has(status)) {
      await appendJsonl(eventsPath, {
        event: status === "COMPLETED" ? "completed" : "error",
        job_id: jobId,
        status,
        observed_at: utcNow(),
        payload: statusPayload,
      });
      continue;
    }

    let messagesPayload: JsonRecord = {};
    try {
      messagesPayload = await fetchJson(
        jobMessagesUrl(apiBase, jobId, jobState.cursor),
        token
      );
    } catch (error) {
      messagesPayload = {};
    }

    const cursor = messagesPayload.next_cursor
      ? String(messagesPayload.next_cursor)
      : undefined;
    const messages = Array.isArray(messagesPayload.messages)
      ? (messagesPayload.messages as JsonRecord[])
      : [];
    const actionableMessage = findActionableMessage(messages);

    if (cursor) {
      jobState.cursor = cursor;
    }

    if (actionableMessage) {
      await appendJsonl(eventsPath, {
        event: "question",
        job_id: jobId,
        observed_at: utcNow(),
        message: actionableMessage,
      });
      jobState.last_activity = utcNow();
      continue;
    }

    if (shouldEmitStuck(jobState.last_activity, stuckMinutes)) {
      await appendJsonl(eventsPath, {
        event: "stuck",
        job_id: jobId,
        observed_at: utcNow(),
        last_activity: jobState.last_activity ?? null,
      });
      jobState.last_activity = utcNow();
    }
  }
}

function parseArgs(argv: string[]): {
  jobs?: string;
  events?: string;
  state?: string;
  poll?: number;
  stuckMinutes?: number;
  apiBase?: string;
  config?: string;
} {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) {
      continue;
    }
    const key = entry.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = value;
      index += 1;
    }
  }

  return {
    jobs: args.jobs,
    events: args.events,
    state: args.state,
    poll: args.poll ? Number(args.poll) : undefined,
    stuckMinutes: args["stuck-minutes"]
      ? Number(args["stuck-minutes"])
      : undefined,
    apiBase: args["api-base"],
    config: args.config,
  };
}

async function sleep(seconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.JULES_API_TOKEN;
  const config = await loadConfig(args.config ?? DEFAULT_CONFIG_PATH);

  const jobsPath = args.jobs ?? (config.jobs_path as string | undefined);
  const eventsPath = args.events ?? (config.events_path as string | undefined);
  const statePath =
    args.state ?? (config.monitor_state_path as string | undefined) ?? DEFAULT_STATE_PATH;
  const pollSeconds =
    args.poll ??
    (config.monitor_poll_seconds as number | undefined) ??
    DEFAULT_POLL_SECONDS;
  const apiBase =
    args.apiBase ??
    (config.api_base as string | undefined) ??
    DEFAULT_API_BASE;
  const stuckMinutes =
    args.stuckMinutes ??
    (config.stuck_minutes as number | undefined) ??
    DEFAULT_STUCK_MINUTES;

  if (!jobsPath || !eventsPath) {
    console.error("Error: jobs_path and events_path must be provided");
    return 1;
  }

  const stateRaw = await loadJson<Record<string, JobState>>(statePath, {});
  const state: Record<string, JobState> = { ...stateRaw };

  console.error(`Jules Monitor started - polling every ${pollSeconds}s`);
  console.error(`Jobs: ${jobsPath}`);
  console.error(`Events: ${eventsPath}`);

  while (true) {
    try {
      const jobs = await loadJobs(jobsPath);
      if (jobs.length > 0) {
        await monitorOnce(jobs, state, apiBase, token, eventsPath, stuckMinutes);
      }
    } catch (error) {
      await appendJsonl(eventsPath, {
        event: "error",
        job_id: null,
        observed_at: utcNow(),
        message: `Monitor error: ${(error as Error).message}`,
      });
    }

    await saveJson(statePath, state);
    await sleep(pollSeconds);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Fatal error in monitor:", error);
    process.exit(1);
  });
}
