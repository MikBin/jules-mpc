import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileURLToPath } from "url";

const SERVER_NAME = "jules-mcp";
const SERVER_VERSION = "1.0.0";

export const DEFAULT_API_BASE = "https://jules.googleapis.com/v1";
export const API_BASE = process.env.JULES_API_BASE ?? DEFAULT_API_BASE;
export const API_TOKEN = process.env.JULES_API_TOKEN;

type JsonRecord = Record<string, unknown>;
type StructuredContent = Record<string, unknown> | undefined;
type ToolResponse = {
  content: { type: "text"; text: string }[];
  structuredContent?: StructuredContent;
};

export function buildHeaders(): HeadersInit {
  const headers: HeadersInit = {
    Accept: "application/json",
  };
  if (API_TOKEN) {
    (headers as Record<string, string>).Authorization = `Bearer ${API_TOKEN}`;
  }
  return headers;
}

export async function requestJson(
  url: string,
  options: RequestInit = {}
): Promise<unknown> {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...buildHeaders(),
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`HTTP ${response.status} for ${url}: ${detail}`);
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export function urlJoin(path: string): string {
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  return `${API_BASE.replace(/\/$/, "")}/${normalized}`;
}

export async function createJob(payload: JsonRecord): Promise<unknown> {
  return requestJson(urlJoin("jobs"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function getJob(jobId: string): Promise<unknown> {
  return requestJson(urlJoin(`jobs/${jobId}`));
}

export async function getMessages(jobId: string, cursor?: string): Promise<unknown> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return requestJson(urlJoin(`jobs/${jobId}/messages${query}`));
}

export async function sendMessage(jobId: string, message: JsonRecord): Promise<unknown> {
  return requestJson(urlJoin(`jobs/${jobId}/messages`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
}

export async function getArtifacts(jobId: string): Promise<unknown> {
  return requestJson(urlJoin(`jobs/${jobId}/artifacts`));
}

export async function requestRetry(jobId: string): Promise<unknown> {
  return requestJson(urlJoin(`jobs/${jobId}:retry`), { method: "POST" });
}

export async function mergePr(jobId: string, payload: JsonRecord): Promise<unknown> {
  return requestJson(urlJoin(`jobs/${jobId}:merge`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function cancelJob(jobId: string): Promise<unknown> {
  return requestJson(urlJoin(`jobs/${jobId}:cancel`), { method: "POST" });
}

export async function listJobs(repo: string, limit: number): Promise<unknown> {
  const query = `?repo=${encodeURIComponent(repo)}&limit=${limit}`;
  return requestJson(urlJoin(`jobs${query}`));
}

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

export const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

server.registerTool(
  "jules_create_job",
  {
    title: "Create a new Jules job",
    description: "Create a new Jules job",
    inputSchema: {
      repo: z.string().describe("Repository in owner/repo format"),
      branch: z.string().describe("Target branch name"),
      prompt: z.string().describe("Task description for Jules"),
      constraints: z.record(z.any()).optional().describe("Optional constraints"),
    },
  },
  async (arguments_) => {
    const payload = await createJob(arguments_ as JsonRecord);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_register_job",
  {
    title: "Register a job ID with the local monitor",
    description: "Register a job ID with the local monitor jobs file for tracking",
    inputSchema: {
      job_id: z.string().describe("The Jules job ID to register"),
      jobs_path: z.string().describe("Path to the jobs JSONL file"),
      metadata: z.record(z.any()).optional().describe("Optional metadata"),
    },
  },
  async ({ job_id, jobs_path, metadata }) => {
    if (!job_id || !jobs_path) {
      throw new Error("job_id and jobs_path are required");
    }
    const { promises: fs } = await import("fs");
    const { dirname } = await import("path");
    const entry = { job_id, metadata: metadata ?? {} };
    await fs.mkdir(dirname(jobs_path), { recursive: true });
    await fs.appendFile(jobs_path, `${JSON.stringify(entry)}\n`, "utf8");
    return buildToolResponse({ registered: true, job_id });
  }
);

server.registerTool(
  "jules_get_job",
  {
    title: "Fetch job metadata and current status",
    description: "Fetch job metadata and current status",
    inputSchema: {
      job_id: z.string().describe("The Jules job ID"),
    },
  },
  async ({ job_id }) => {
    const payload = await getJob(job_id);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_get_messages",
  {
    title: "Fetch new job messages",
    description: "Fetch new job messages since a cursor position",
    inputSchema: {
      job_id: z.string().describe("The Jules job ID"),
      cursor: z.string().optional().describe("Optional cursor for pagination"),
    },
  },
  async ({ job_id, cursor }) => {
    const payload = await getMessages(job_id, cursor);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_send_message",
  {
    title: "Send clarification to Jules",
    description: "Send a clarification or instruction to Jules for a job",
    inputSchema: {
      job_id: z.string().describe("The Jules job ID"),
      message: z.record(z.any()).describe("Message content to send"),
    },
  },
  async ({ job_id, message }) => {
    const payload = await sendMessage(job_id, message as JsonRecord);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_get_artifacts",
  {
    title: "Fetch job artifacts",
    description: "Fetch job artifacts (diff, patch, PR URL)",
    inputSchema: {
      job_id: z.string().describe("The Jules job ID"),
    },
  },
  async ({ job_id }) => {
    const payload = await getArtifacts(job_id);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_request_retry",
  {
    title: "Request a retry",
    description: "Request a retry or re-run of a failed job",
    inputSchema: {
      job_id: z.string().describe("The Jules job ID"),
    },
  },
  async ({ job_id }) => {
    const payload = await requestRetry(job_id);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_merge_pr",
  {
    title: "Merge the PR",
    description: "Merge the PR associated with a completed job",
    inputSchema: {
      job_id: z.string().describe("The Jules job ID"),
      payload: z.record(z.any()).optional().describe("Optional merge parameters"),
    },
  },
  async ({ job_id, payload }) => {
    const result = await mergePr(job_id, (payload ?? {}) as JsonRecord);
    return buildToolResponse(result);
  }
);

server.registerTool(
  "jules_cancel_job",
  {
    title: "Cancel a running job",
    description: "Cancel a running job",
    inputSchema: {
      job_id: z.string().describe("The Jules job ID"),
    },
  },
  async ({ job_id }) => {
    const payload = await cancelJob(job_id);
    return buildToolResponse(payload);
  }
);

server.registerTool(
  "jules_list_jobs",
  {
    title: "List jobs",
    description: "List all jobs for a repository",
    inputSchema: {
      repo: z.string().describe("Repository in owner/repo format"),
      limit: z.number().optional().describe("Maximum number of jobs to return"),
    },
  },
  async ({ repo, limit }) => {
    const payload = await listJobs(repo, limit ?? 50);
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
