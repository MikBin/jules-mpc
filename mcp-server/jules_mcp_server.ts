import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";
import { fileURLToPath } from "url";
import { getJulesConfig } from "../src/utils.js";

const SERVER_NAME = "jules-mcp";
const SERVER_VERSION = "1.3.0";

const config = getJulesConfig();
export const DEFAULT_API_BASE = "https://jules.googleapis.com/v1alpha";
export const API_BASE = config.apiBase ?? DEFAULT_API_BASE;
export const API_KEY = config.apiKey;

type JsonRecord = Record<string, unknown>;
type StructuredContent = Record<string, unknown> | undefined;
type ToolResponse = {
  content: { type: "text"; text: string }[];
  structuredContent?: StructuredContent;
};

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const TERMINAL_STATES = new Set(["COMPLETED", "FAILED"]);
const CLARIFICATION_STATES = new Set([
  "AWAITING_USER_FEEDBACK",
  "AWAITING_PLAN_APPROVAL",
]);
const DEFAULT_POLL_INTERVAL_MS = 60000;
const MAX_POLL_INTERVAL_MS = 300000;
const MAX_WAIT_SECONDS = 600;
const SESSION_PATH_PREFIX = "sessions/";
const PROJECT_SESSION_PAGE_SIZE = 50;
const MAX_PROJECT_SESSION_SCAN_PAGES = 20;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 1_000;
const MAX_PATCH_CHARS = 20_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type CompactCheckCode = "Q" | "C" | "F" | "N";

async function sendProgress(
  extra: ToolExtra,
  progress: number,
  total: number,
  message: string
): Promise<void> {
  const progressToken = extra._meta?.progressToken;
  if (!progressToken) return;
  await extra.sendNotification({
    method: "notifications/progress",
    params: { progressToken, progress, total, message },
  });
}

export function buildHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (API_KEY) {
    headers["x-goog-api-key"] = API_KEY;
  }
  return headers;
}

export async function requestJson(
  url: string,
  options: RequestInit = {}
): Promise<unknown> {
  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...buildHeaders(),
          ...(options.headers ?? {}),
        },
        signal: controller.signal,
      });

      if (response.status === 429 || response.status >= 500) {
        const detail = await response.text();
        if (attempt < MAX_RETRIES) {
          attempt += 1;
          await sleep(RETRY_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
        throw new Error(
          `HTTP ${response.status} for ${url}: ${detail} (after ${attempt} retries)`
        );
      }

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`HTTP ${response.status} for ${url}: ${detail}`);
      }

      if (response.status === 204) {
        return null;
      }

      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } catch (error) {
      const aborted =
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError");
      if (aborted) {
        if (attempt < MAX_RETRIES) {
          attempt += 1;
          await sleep(RETRY_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
        throw new Error(
          `Request timed out after ${REQUEST_TIMEOUT_MS}ms for ${url} (after ${attempt} retries)`
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function urlJoin(path: string): string {
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  return `${API_BASE.replace(/\/$/, "")}/${normalized}`;
}

export function normalizeSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.startsWith(SESSION_PATH_PREFIX)) {
    return trimmed.slice(SESSION_PATH_PREFIX.length);
  }
  return trimmed;
}

function getSessionIdFromPayload(session: JsonRecord): string | undefined {
  if (typeof session.session_id === "string") {
    return normalizeSessionId(session.session_id);
  }
  if (typeof session.id === "string") {
    return normalizeSessionId(session.id);
  }
  if (typeof session.name === "string") {
    return normalizeSessionId(session.name);
  }
  return undefined;
}

function getSessionSortTimestamp(session: JsonRecord): number {
  const keys = ["updateTime", "createTime", "startTime"] as const;
  for (const key of keys) {
    const value = session[key];
    if (typeof value !== "string") {
      continue;
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function matchesProjectSession(
  session: JsonRecord,
  expectedSource: string,
  branch?: string
): boolean {
  const sourceContext =
    session.sourceContext && typeof session.sourceContext === "object"
      ? (session.sourceContext as JsonRecord)
      : undefined;
  const source =
    typeof sourceContext?.source === "string"
      ? sourceContext.source
      : typeof session.source === "string"
        ? session.source
        : "";
  if (source !== expectedSource) {
    return false;
  }

  if (!branch) {
    return true;
  }

  const githubRepoContext =
    sourceContext?.githubRepoContext &&
    typeof sourceContext.githubRepoContext === "object"
      ? (sourceContext.githubRepoContext as JsonRecord)
      : undefined;
  const startingBranch =
    typeof githubRepoContext?.startingBranch === "string"
      ? githubRepoContext.startingBranch
      : "";
  return startingBranch === branch;
}

function pickMostRecentSession(sessions: JsonRecord[]): JsonRecord | null {
  if (sessions.length === 0) {
    return null;
  }

  return sessions.reduce((latest, current) => {
    if (!latest) {
      return current;
    }
    return getSessionSortTimestamp(current) >= getSessionSortTimestamp(latest)
      ? current
      : latest;
  }, sessions[0]);
}

export function compactStatusCodeFromState(
  state: string | undefined
): CompactCheckCode {
  if (state && CLARIFICATION_STATES.has(state)) {
    return "Q";
  }
  if (state === "COMPLETED") {
    return "C";
  }
  if (state === "FAILED") {
    return "F";
  }
  return "N";
}

export async function findCurrentProjectSession(
  owner: string,
  repo: string,
  branch?: string
): Promise<JsonRecord | null> {
  const expectedSource = `sources/github/${owner}/${repo}`;
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PROJECT_SESSION_SCAN_PAGES; page += 1) {
    const response = (await listSessions(
      PROJECT_SESSION_PAGE_SIZE,
      pageToken
    )) as JsonRecord;
    const sessions = Array.isArray(response.sessions)
      ? (response.sessions as JsonRecord[])
      : [];

    const projectSessions = sessions.filter((session) =>
      matchesProjectSession(session, expectedSource, branch)
    );
    const latest = pickMostRecentSession(projectSessions);
    if (latest) {
      return latest;
    }

    pageToken =
      typeof response.nextPageToken === "string"
        ? response.nextPageToken
        : undefined;
    if (!pageToken) {
      break;
    }
  }

  return null;
}

async function ensureSessionHasState(session: JsonRecord): Promise<JsonRecord> {
  if (typeof session.state === "string") {
    return session;
  }
  const sessionId = getSessionIdFromPayload(session);
  if (!sessionId) {
    return session;
  }
  return (await getSession(sessionId)) as JsonRecord;
}

// --- API helpers ---

export async function createSession(payload: JsonRecord): Promise<unknown> {
  return requestJson(urlJoin("sessions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function getSession(sessionId: string): Promise<unknown> {
  return requestJson(urlJoin(`sessions/${normalizeSessionId(sessionId)}`));
}

export async function listSessions(
  pageSize?: number,
  pageToken?: string,
  filter?: string
): Promise<unknown> {
  const params = new URLSearchParams();
  if (pageSize !== undefined) params.set("pageSize", String(pageSize));
  if (pageToken) params.set("pageToken", pageToken);
  if (filter) params.set("filter", filter);
  const query = params.toString() ? `?${params.toString()}` : "";
  return requestJson(urlJoin(`sessions${query}`));
}

export async function deleteSession(sessionId: string): Promise<unknown> {
  return requestJson(urlJoin(`sessions/${normalizeSessionId(sessionId)}`), {
    method: "DELETE",
  });
}

export async function sendMessage(
  sessionId: string,
  prompt: string
): Promise<unknown> {
  return requestJson(
    urlJoin(`sessions/${normalizeSessionId(sessionId)}:sendMessage`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }
  );
}

export async function approvePlan(sessionId: string): Promise<unknown> {
  return requestJson(urlJoin(`sessions/${normalizeSessionId(sessionId)}:approvePlan`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

export async function archiveSession(sessionId: string): Promise<unknown> {
  return requestJson(urlJoin(`sessions/${normalizeSessionId(sessionId)}:archive`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

export async function unarchiveSession(sessionId: string): Promise<unknown> {
  return requestJson(urlJoin(`sessions/${normalizeSessionId(sessionId)}:unarchive`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

export async function listActivities(
  sessionId: string,
  pageSize?: number,
  pageToken?: string
): Promise<unknown> {
  const params = new URLSearchParams();
  if (pageSize !== undefined) params.set("pageSize", String(pageSize));
  if (pageToken) params.set("pageToken", pageToken);
  const query = params.toString() ? `?${params.toString()}` : "";
  return requestJson(
    urlJoin(`sessions/${normalizeSessionId(sessionId)}/activities${query}`)
  );
}

export async function getActivity(
  sessionId: string,
  activityId: string
): Promise<unknown> {
  return requestJson(
    urlJoin(`sessions/${normalizeSessionId(sessionId)}/activities/${activityId}`)
  );
}

export async function listSources(
  pageSize?: number,
  pageToken?: string
): Promise<unknown> {
  const params = new URLSearchParams();
  if (pageSize !== undefined) params.set("pageSize", String(pageSize));
  if (pageToken) params.set("pageToken", pageToken);
  const query = params.toString() ? `?${params.toString()}` : "";
  return requestJson(urlJoin(`sources${query}`));
}

export async function getSource(sourceId: string): Promise<unknown> {
  return requestJson(urlJoin(`sources/${sourceId}`));
}

export async function wait(seconds: number): Promise<void> {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error("seconds must be a non-negative finite number");
  }
  const clamped = Math.min(seconds, MAX_WAIT_SECONDS);
  return new Promise((resolve) => setTimeout(resolve, clamped * 1000));
}

// --- Response helpers ---

function toStructuredContent(payload: unknown): StructuredContent {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as StructuredContent;
  }
  return undefined;
}

function buildToolResponse(payload: unknown): ToolResponse {
  const contentItem = {
    type: "text" as const,
    text: JSON.stringify(payload, null, 2),
  };
  return {
    content: [contentItem],
    structuredContent: toStructuredContent(payload),
  };
}

function buildCompactToolResponse(
  message: string,
  structuredContent?: StructuredContent
): ToolResponse {
  return {
    content: [{ type: "text", text: message }],
    structuredContent,
  };
}

export function extractSessionArtifacts(
  sessionId: string,
  sessionData: JsonRecord
): JsonRecord {
  const outputs = Array.isArray(sessionData.outputs)
    ? (sessionData.outputs as JsonRecord[])
    : [];

  const base: JsonRecord = {
    sessionId,
    sessionState: sessionData.state,
  };
  if (typeof sessionData.url === "string") {
    base.sessionUrl = sessionData.url;
  }

  const prOutput = outputs.find((output) => output.pullRequest);
  const csOutput = outputs.find((output) => output.changeSet);
  const pullRequest = prOutput?.pullRequest as JsonRecord | undefined;
  const changeSet = csOutput?.changeSet as JsonRecord | undefined;

  if (!pullRequest && !changeSet) {
    return {
      ...base,
      error:
        "No pull request or change set found in session outputs. " +
        "The session may still be running, may not have produced changes, " +
        "or automationMode may have been disabled (no PR created).",
    };
  }

  const result: JsonRecord = { ...base };

  if (pullRequest) {
    result.pullRequest = {
      url: pullRequest.url,
      title: pullRequest.title,
      description: pullRequest.description,
      baseRef: pullRequest.baseRef,
      headRef: pullRequest.headRef,
    };
  }

  if (changeSet) {
    const gitPatch = (changeSet.gitPatch as JsonRecord | undefined) ?? {};
    const rawUnidiff =
      typeof gitPatch.unidiffPatch === "string"
        ? gitPatch.unidiffPatch
        : undefined;
    const patchResult: JsonRecord = {
      baseCommitId: gitPatch.baseCommitId,
      suggestedCommitMessage: gitPatch.suggestedCommitMessage,
    };
    if (rawUnidiff !== undefined) {
      if (rawUnidiff.length > MAX_PATCH_CHARS) {
        patchResult.unidiffPatch = rawUnidiff.slice(0, MAX_PATCH_CHARS);
        patchResult.unidiffTruncated = true;
        patchResult.unidiffOriginalLength = rawUnidiff.length;
      } else {
        patchResult.unidiffPatch = rawUnidiff;
      }
    }
    result.changeSet = {
      source: changeSet.source,
      gitPatch: patchResult,
    };
  }

  return result;
}

// --- MCP Server ---

export const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

server.registerTool(
  "jules_create_session",
  {
    title: "Create a new Jules session",
    description:
      "Create a new Jules coding session for a GitHub repository",
    inputSchema: {
      owner: z.string().describe("GitHub repository owner"),
      repo: z.string().describe("GitHub repository name"),
      branch: z.string().describe("Starting branch name"),
      prompt: z.string().describe("Task description for Jules"),
      title: z.string().optional().describe("Optional session title"),
      requirePlanApproval: z
        .boolean()
        .optional()
        .describe("Whether to require plan approval before execution"),
      automationMode: z
        .enum(["AUTO_CREATE_PR", "AUTOMATION_MODE_UNSPECIFIED"])
        .optional()
        .describe(
          'Automation mode. Defaults to "AUTO_CREATE_PR" (Jules auto-opens a pull request on successful completion). ' +
            'Note: the Jules API itself defaults to no automation. Use "AUTOMATION_MODE_UNSPECIFIED" to disable PR creation.'
        ),
      workingBranch: z
        .string()
        .optional()
        .describe(
          "Optional branch Jules pushes its changes to. If omitted, Jules generates a branch name. Distinct from the starting branch."
        ),
      environmentVariablesEnabled: z
        .boolean()
        .optional()
        .describe(
          "Optional. Enables environment variables configured for this source within the session."
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    owner,
    repo,
    branch,
    prompt,
    title,
    requirePlanApproval,
    automationMode,
    workingBranch,
    environmentVariablesEnabled,
  }) => {
    const githubRepoContext: JsonRecord = { startingBranch: branch };
    const sourceContext: JsonRecord = {
      source: `sources/github/${owner}/${repo}`,
      githubRepoContext,
    };
    if (workingBranch !== undefined) {
      sourceContext.workingBranch = workingBranch;
    }
    if (environmentVariablesEnabled !== undefined) {
      sourceContext.environmentVariablesEnabled = environmentVariablesEnabled;
    }
    const body: JsonRecord = {
      prompt,
      sourceContext,
      automationMode: automationMode ?? "AUTO_CREATE_PR",
    };
    if (title !== undefined) body.title = title;
    if (requirePlanApproval !== undefined)
      body.requirePlanApproval = requirePlanApproval;
    const payload = await createSession(body);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_get_session",
  {
    title: "Get session details",
    description: "Fetch session metadata, state, and outputs",
    inputSchema: {
      session_id: z.string().describe("The Jules session ID"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ session_id }) => {
    const payload = await getSession(session_id);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_check_jules",
  {
    title: "Check the current Jules session with minimal output",
    description:
      "Token-saving status check. Returns a one-letter code: " +
      "Q (needs clarification), C (completed), F (failed), N (nothing to do). " +
      "Provide session_id directly or owner/repo to auto-resolve the current project session.",
    inputSchema: {
      owner: z.string().optional().describe("GitHub repository owner"),
      repo: z.string().optional().describe("GitHub repository name"),
      branch: z
        .string()
        .optional()
        .describe("Optional starting branch filter when checking by project"),
      session_id: z
        .string()
        .optional()
        .describe("Optional session ID; if provided, owner/repo are ignored"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ owner, repo, branch, session_id }) => {
    let session: JsonRecord | null;

    if (session_id) {
      session = (await getSession(session_id)) as JsonRecord;
    } else {
      if (!owner || !repo) {
        throw new Error("Provide either session_id or both owner and repo.");
      }
      session = await findCurrentProjectSession(owner, repo, branch);
    }

    if (!session) {
      return buildCompactToolResponse("N", { c: "N", st: "NO_SESSION" });
    }

    const hydratedSession = await ensureSessionHasState(session);
    const state =
      typeof hydratedSession.state === "string"
        ? hydratedSession.state
        : undefined;
    const code = compactStatusCodeFromState(state);
    const resolvedSessionId = getSessionIdFromPayload(hydratedSession);

    return buildCompactToolResponse(code, {
      c: code,
      st: state ?? "UNKNOWN",
      ...(resolvedSessionId ? { s: resolvedSessionId } : {}),
    });
  }
);

server.registerTool(
  "jules_list_sessions",
  {
    title: "List sessions",
    description:
      "List Jules sessions. By default only non-archived sessions are returned " +
      "(Jules API default). Set includeArchived=true to also return archived sessions, " +
      "or pass a raw AIP-160 filter (e.g. 'archived = true').",
    inputSchema: {
      pageSize: z.number().optional().describe("Maximum number of sessions to return"),
      pageToken: z.string().optional().describe("Page token for pagination"),
      filter: z
        .string()
        .optional()
        .describe(
          "Optional AIP-160 filter expression (e.g. 'archived = true'). Overrides includeArchived when set."
        ),
      includeArchived: z
        .boolean()
        .optional()
        .describe(
          "If true, include archived sessions (sets filter to 'archived = true OR archived = false' unless filter is given)."
        ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ pageSize, pageToken, filter, includeArchived }) => {
    const effectiveFilter =
      filter ??
      (includeArchived ? "archived = true OR archived = false" : undefined);
    const payload = await listSessions(pageSize, pageToken, effectiveFilter);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_delete_session",
  {
    title: "Delete a session",
    description: "Delete a Jules session",
    inputSchema: {
      session_id: z.string().describe("The Jules session ID"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ session_id }) => {
    const payload = await deleteSession(session_id);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_send_message",
  {
    title: "Send message to session",
    description: "Send a clarification or instruction to a Jules session",
    inputSchema: {
      session_id: z.string().describe("The Jules session ID"),
      message: z.string().describe("Message text to send"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ session_id, message }) => {
    const payload = await sendMessage(session_id, message);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_approve_plan",
  {
    title: "Approve session plan",
    description: "Approve the plan for a session awaiting plan approval",
    inputSchema: {
      session_id: z.string().describe("The Jules session ID"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ session_id }) => {
    const payload = await approvePlan(session_id);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_list_activities",
  {
    title: "List session activities",
    description: "List activities for a Jules session",
    inputSchema: {
      session_id: z.string().describe("The Jules session ID"),
      pageSize: z.number().optional().describe("Maximum number of activities to return"),
      pageToken: z.string().optional().describe("Page token for pagination"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ session_id, pageSize, pageToken }) => {
    const payload = await listActivities(session_id, pageSize, pageToken);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_get_activity",
  {
    title: "Get a single activity",
    description: "Get a single activity by ID for a Jules session",
    inputSchema: {
      session_id: z.string().describe("The Jules session ID"),
      activity_id: z.string().describe("The activity ID"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ session_id, activity_id }) => {
    const payload = await getActivity(session_id, activity_id);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_list_sources",
  {
    title: "List sources",
    description: "List available sources (GitHub repositories)",
    inputSchema: {
      pageSize: z.number().optional().describe("Maximum number of sources to return"),
      pageToken: z.string().optional().describe("Page token for pagination"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ pageSize, pageToken }) => {
    const payload = await listSources(pageSize, pageToken);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_get_source",
  {
    title: "Get source details",
    description: "Get details for a specific source",
    inputSchema: {
      source_id: z.string().describe("The source ID"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ source_id }) => {
    const payload = await getSource(source_id);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_extract_pr_from_session",
  {
    title: "Extract PR details from completed session",
    description:
      "Extract pull request and/or change set information from a completed Jules session's outputs. " +
      "Returns the full pull request (url, title, description, baseRef, headRef) when AUTO_CREATE_PR was used, " +
      "and the change set (git patch, suggested commit message) when present. " +
      "Sessions that produced a patch but no PR still return their changeSet.",
    inputSchema: {
      session_id: z.string().describe("The completed Jules session ID"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ session_id }) => {
    const session = (await getSession(session_id)) as JsonRecord;
    return buildToolResponse(extractSessionArtifacts(session_id, session));
  }
);

server.registerTool(
  "jules_wait",
  {
    title: "Wait for a specified duration",
    description:
      "Pause execution for a given number of seconds (max 600). " +
      "Use between polling calls to conserve context window tokens " +
      "instead of requiring a separate sleep MCP server.",
    inputSchema: {
      seconds: z
        .number()
        .describe("Duration to wait in seconds (max 600)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ seconds }) => {
    const clamped = Math.min(Math.max(seconds, 0), MAX_WAIT_SECONDS);
    await wait(clamped);
    return buildCompactToolResponse(
      `Waited ${clamped} seconds`,
      { waited: clamped }
    );
  }
);

server.registerTool(
  "jules_monitor_session",
  {
    title: "Monitor a Jules session with progress",
    description:
      "Polls a Jules session until it reaches a terminal state (COMPLETED or FAILED), " +
      "sending MCP progress notifications with the latest activity. " +
      "Returns the final session state and outputs.",
    inputSchema: {
      session_id: z.string().describe("The Jules session ID to monitor"),
      poll_interval_seconds: z
        .number()
        .optional()
        .describe(
          "Polling interval in seconds (default: 60, max: 300)"
        ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ session_id, poll_interval_seconds }, extra) => {
    const intervalMs = Math.min(
      (poll_interval_seconds ?? DEFAULT_POLL_INTERVAL_MS / 1000) * 1000,
      MAX_POLL_INTERVAL_MS
    );

    let pollCount = 0;
    let lastActivityDesc = "";

    await sendProgress(extra, 0, 100, "Starting session monitoring…");

    while (true) {
      const session = (await getSession(session_id)) as JsonRecord;
      const state = String(session.state ?? "UNKNOWN");
      pollCount++;

      let latestActivityDesc = "";
      try {
        const activitiesResponse = (await listActivities(
          session_id,
          1
        )) as JsonRecord;
        const activities = activitiesResponse.activities as
          | JsonRecord[]
          | undefined;
        if (activities && activities.length > 0) {
          latestActivityDesc = String(
            activities[0].description ?? activities[0].state ?? ""
          );
        }
      } catch {
        // Activities may not be available yet
      }

      const statusMessage = latestActivityDesc
        ? `[${state}] ${latestActivityDesc}`
        : `[${state}]`;

      if (statusMessage !== lastActivityDesc) {
        await sendProgress(extra, pollCount, pollCount + 1, statusMessage);
        lastActivityDesc = statusMessage;
      }

      if (TERMINAL_STATES.has(state)) {
        await sendProgress(extra, 1, 1, `Session ${state.toLowerCase()}`);
        return buildToolResponse(session);
      }

      if (state === "AWAITING_USER_FEEDBACK") {
        await sendProgress(
          extra,
          pollCount,
          pollCount + 1,
          "Jules needs input — visit the session to respond"
        );
        return buildToolResponse({
          ...session,
          _monitor_message:
            "Session is awaiting user feedback. " +
            "Use jules_approve_plan or jules_send_message to respond, " +
            "then call jules_monitor_session again to continue monitoring.",
        });
      }

      if (extra.signal.aborted) {
        return buildToolResponse({
          ...session,
          _monitor_message: "Monitoring cancelled by client.",
        });
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
);

server.registerTool(
  "jules_archive_session",
  {
    title: "Archive a session",
    description:
      "Archive a Jules session. Archived sessions are hidden from the default session list " +
      "(the Jules API list defaults to non-archived only). Use jules_unarchive_session to restore.",
    inputSchema: {
      session_id: z.string().describe("The Jules session ID to archive"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ session_id }) => {
    const payload = await archiveSession(session_id);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_unarchive_session",
  {
    title: "Unarchive a session",
    description:
      "Restore an archived Jules session so it reappears in the default session list.",
    inputSchema: {
      session_id: z.string().describe("The Jules session ID to unarchive"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ session_id }) => {
    const payload = await unarchiveSession(session_id);
    return buildToolResponse(payload);
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} MCP server running on stdio`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Fatal error in MCP server:", error);
    process.exit(1);
  });
}
