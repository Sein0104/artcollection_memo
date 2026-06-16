type JsonRpcId = number | string | null;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

type SearchResult = {
  title: string;
  snippet: string;
  url: string;
  source: string;
};

const PROTOCOL_VERSION = "2024-11-05";
const TOOL_NAME = "artcatch_external_search";
const MAX_RESULTS = 5;
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

let stdinBuffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  void drainMessages();
});

process.stdin.on("end", () => {
  process.exit(0);
});

async function drainMessages() {
  while (true) {
    const newlineIndex = stdinBuffer.indexOf("\n");
    if (newlineIndex < 0) return;

    const rawMessage = stdinBuffer.slice(0, newlineIndex).trim();
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    if (!rawMessage) continue;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(rawMessage) as JsonRpcMessage;
    } catch {
      sendError(null, -32700, "parse_error");
      continue;
    }

    await handleMessage(message);
  }
}

async function handleMessage(message: JsonRpcMessage) {
  const id = message.id ?? null;
  const method = message.method || "";

  try {
    if (method === "initialize") {
      sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: "artcatch-mcp-search-server",
          version: "0.1.0",
        },
      });
      return;
    }

    if (method === "notifications/initialized") return;

    if (method === "tools/list") {
      sendResult(id, {
        tools: [
          {
            name: TOOL_NAME,
            description: "Search external web results for ArtCatch board keywords through Tavily.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
                max_results: { type: "number", minimum: 1, maximum: MAX_RESULTS },
              },
              required: ["query"],
              additionalProperties: false,
            },
          },
        ],
      });
      return;
    }

    if (method === "tools/call") {
      await handleToolCall(id, message.params);
      return;
    }

    if (method === "ping") {
      sendResult(id, {});
      return;
    }

    sendError(id, -32601, "method_not_found");
  } catch (error) {
    const rpcError = error as { code?: unknown; message?: unknown };
    sendError(id, typeof rpcError.code === "number" ? rpcError.code : -32000, typeof rpcError.message === "string" ? rpcError.message : "mcp_search_failed");
  }
}

async function handleToolCall(id: JsonRpcId, params: unknown) {
  const record = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const name = typeof record.name === "string" ? record.name : "";
  if (name !== TOOL_NAME) throw rpcError(-32602, "unknown_tool");

  const args = record.arguments && typeof record.arguments === "object" ? (record.arguments as Record<string, unknown>) : {};
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query.length < 2) throw rpcError(-32602, "query_too_short");

  const requestedCount = Number(args.max_results ?? args.count ?? MAX_RESULTS);
  const maxResults = Number.isFinite(requestedCount) ? Math.max(1, Math.min(MAX_RESULTS, Math.round(requestedCount))) : MAX_RESULTS;
  const results = await searchTavily(query, maxResults);
  const payload = { query, results };

  sendResult(id, {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  });
}

async function searchTavily(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) throw rpcError(-32000, "tavily_api_key_required");

  const response = await fetch(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : `tavily_search_failed_${response.status}`;
    throw rpcError(-32000, message);
  }

  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.map(normalizeResult).filter((item): item is SearchResult => Boolean(item)).slice(0, maxResults);
}

function normalizeResult(item: unknown): SearchResult | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const url = firstString(record.url, record.link, record.href);
  if (!url || !/^https?:\/\//i.test(url)) return null;

  return {
    title: firstString(record.title, record.name) || url,
    snippet: firstString(record.content, record.snippet, record.description) || "",
    url,
    source: hostFromUrl(url),
  };
}

function sendResult(id: JsonRpcId, result: unknown) {
  if (id === null || id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendError(id: JsonRpcId, code: number, message: string) {
  if (id === null || id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function rpcError(code: number, message: string) {
  const error = new Error(message) as Error & { code: number };
  error.code = code;
  return error;
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim() || "";
}

function hostFromUrl(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
