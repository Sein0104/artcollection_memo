import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const EXTERNAL_SEARCH_LIMIT = 5;
const MCP_SEARCH_TIMEOUT_MS = 12_000;
const EXTERNAL_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const MCP_SEARCH_DEFAULT_TOOL = "tavily_search";

type ExternalSearchResult = {
  title: string;
  snippet: string;
  url: string;
  source: string;
};

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number };
};

@Injectable()
export class ExternalSearchService {
  private readonly cache = new Map<string, { expiresAt: number; response: { query: string; provider: "mcp"; configured: boolean; results: ExternalSearchResult[]; message?: string } }>();

  constructor(private readonly config: ConfigService) {}

  async search(rawQuery: string) {
    const query = rawQuery.trim();
    if (query.length < 2) {
      throw new BadRequestException("external_search_query_too_short");
    }

    const cacheKey = query.toLowerCase();
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    if (!this.command()) {
      const response = {
        query,
        provider: "mcp" as const,
        configured: false,
        results: [] as ExternalSearchResult[],
        message: "mcp_search_not_configured",
      };
      this.setCached(cacheKey, response);
      return response;
    }

    const payload = await this.callMcpSearchTool(query);
    const response = {
      query,
      provider: "mcp" as const,
      configured: true,
      results: this.normalizeResults(payload).slice(0, EXTERNAL_SEARCH_LIMIT),
    };
    this.setCached(cacheKey, response);
    return response;
  }

  private getCached(key: string) {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (cached.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return cached.response;
  }

  private setCached(key: string, response: { query: string; provider: "mcp"; configured: boolean; results: ExternalSearchResult[]; message?: string }) {
    if (this.cache.size > 100) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, { expiresAt: Date.now() + EXTERNAL_SEARCH_CACHE_TTL_MS, response });
  }

  private async callMcpSearchTool(query: string) {
    const client = new StdioMcpClient({
      command: this.command(),
      args: this.args(),
      timeoutMs: MCP_SEARCH_TIMEOUT_MS,
    });

    try {
      await client.start();
      await client.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "artcatch-backend",
          version: "0.1.0",
        },
      });
      client.notify("notifications/initialized", {});
      return await client.request("tools/call", {
        name: this.toolName(),
        arguments: this.toolArguments(query),
      });
    } finally {
      client.close();
    }
  }

  private command() {
    const command = this.config.get<string>("MCP_SEARCH_COMMAND")?.trim() || "";
    if (process.platform === "win32" && command.toLowerCase() === "npx") {
      return "npx.cmd";
    }
    return command;
  }

  private args() {
    const raw = this.config.get<string>("MCP_SEARCH_ARGS_JSON") || this.config.get<string>("MCP_SEARCH_ARGS") || "";
    if (!raw.trim()) return [];

    const parsed = this.parseJsonConfig(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
    return raw.split(/\s+/).filter(Boolean);
  }

  private toolName() {
    const tool = this.config.get<string>("MCP_SEARCH_TOOL")?.trim() || MCP_SEARCH_DEFAULT_TOOL;
    return tool === "tavily-search" ? "tavily_search" : tool;
  }

  private toolArguments(query: string) {
    const rawTemplate = this.config.get<string>("MCP_SEARCH_INPUT_TEMPLATE_JSON")?.trim();
    if (rawTemplate) {
      const rendered = rawTemplate.replaceAll("{{query}}", query).replaceAll("{{count}}", String(EXTERNAL_SEARCH_LIMIT));
      const parsed = this.parseJsonConfig(rendered);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ServiceUnavailableException("mcp_search_input_template_invalid");
      }
      return parsed;
    }

    return {
      query,
      max_results: EXTERNAL_SEARCH_LIMIT,
      search_depth: "basic",
    };
  }

  private normalizeResults(payload: unknown): ExternalSearchResult[] {
    const found = this.findResultArrays(payload);
    for (const value of found) {
      const results = value.map((item) => this.normalizeResultItem(item)).filter((item): item is ExternalSearchResult => Boolean(item));
      if (results.length) return results;
    }

    const text = this.collectText(payload).join("\n\n").trim();
    if (!text) return [];

    const jsonFromText = this.parseJson(text);
    if (jsonFromText) {
      const nested = this.findResultArrays(jsonFromText);
      for (const value of nested) {
        const results = value.map((item) => this.normalizeResultItem(item)).filter((item): item is ExternalSearchResult => Boolean(item));
        if (results.length) return results;
      }
    }

    return this.parseTextResults(text);
  }

  private normalizeResultItem(item: unknown): ExternalSearchResult | null {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    const url = this.firstString(record.url, record.link, record.href);
    if (!url || !/^https?:\/\//i.test(url)) return null;

    return {
      title: this.firstString(record.title, record.name, record.heading) || url,
      snippet: this.firstString(record.snippet, record.description, record.text, record.content) || "",
      url,
      source: this.hostFromUrl(url),
    };
  }

  private findResultArrays(value: unknown): unknown[][] {
    const output: unknown[][] = [];
    const visit = (current: unknown, depth: number) => {
      if (depth > 5 || !current || typeof current !== "object") return;
      if (Array.isArray(current)) {
        if (current.some((item) => this.normalizeResultItem(item))) output.push(current);
        current.forEach((item) => visit(item, depth + 1));
        return;
      }
      Object.values(current as Record<string, unknown>).forEach((item) => visit(item, depth + 1));
    };
    visit(value, 0);
    return output;
  }

  private collectText(value: unknown): string[] {
    const texts: string[] = [];
    const visit = (current: unknown, depth: number) => {
      if (depth > 6 || !current) return;
      if (typeof current === "string") {
        texts.push(current);
        return;
      }
      if (Array.isArray(current)) {
        current.forEach((item) => visit(item, depth + 1));
        return;
      }
      if (typeof current === "object") {
        Object.values(current as Record<string, unknown>).forEach((item) => visit(item, depth + 1));
      }
    };
    visit(value, 0);
    return texts;
  }

  private parseTextResults(text: string): ExternalSearchResult[] {
    const blocks = text.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
    const results: ExternalSearchResult[] = [];
    const urlPattern = /https?:\/\/[^\s)]+/i;

    for (const block of blocks) {
      const url = block.match(urlPattern)?.[0];
      if (!url) continue;

      const title =
        block.match(/(?:^|\n)\s*(?:title|name)\s*:\s*(.+)/i)?.[1]?.trim() ||
        block
          .split(/\n/)
          .map((line) => line.trim())
          .find((line) => line && !urlPattern.test(line) && !/^(url|link|description|snippet)\s*:/i.test(line)) ||
        url;
      const snippet =
        block.match(/(?:^|\n)\s*(?:description|snippet|text)\s*:\s*(.+)/i)?.[1]?.trim() ||
        block
          .replace(url, "")
          .split(/\n/)
          .map((line) => line.replace(/^(title|name|url|link|description|snippet|text)\s*:\s*/i, "").trim())
          .filter(Boolean)
          .slice(1)
          .join(" ")
          .slice(0, 240);

      results.push({
        title,
        snippet,
        url,
        source: this.hostFromUrl(url),
      });
    }

    return this.dedupeResults(results);
  }

  private dedupeResults(results: ExternalSearchResult[]) {
    const seen = new Set<string>();
    return results.filter((result) => {
      if (seen.has(result.url)) return false;
      seen.add(result.url);
      return true;
    });
  }

  private parseJson(text: string) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  private parseJsonConfig(text: string) {
    const candidates = [text, text.replace(/\\"/g, '"')];
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate) as unknown;
      } catch {
        continue;
      }
    }
    return null;
  }

  private firstString(...values: unknown[]) {
    return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim() || "";
  }

  private hostFromUrl(url: string) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }
}

class StdioMcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  constructor(private readonly options: { command: string; args: string[]; timeoutMs: number }) {}

  start() {
    this.child = spawn(this.options.command, this.options.args, {
      env: process.env,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.readMessages();
    });
    this.child.stderr.on("data", () => undefined);
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code) => {
      if (this.pending.size) this.rejectAll(new Error(`mcp_search_server_exited_${code ?? "unknown"}`));
    });

    return new Promise<void>((resolve, reject) => {
      this.child?.once("spawn", () => resolve());
      this.child?.once("error", (error) => reject(error));
    });
  }

  request(method: string, params: unknown) {
    const id = this.nextId++;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new ServiceUnavailableException("mcp_search_timeout"));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.send(message);
    });
  }

  notify(method: string, params: unknown) {
    this.send({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
    }
    this.pending.clear();
    this.child?.kill();
    this.child = null;
  }

  private send(message: unknown) {
    if (!this.child) throw new ServiceUnavailableException("mcp_search_not_started");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private readMessages() {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) return;

      const rawMessage = this.buffer.subarray(0, newlineIndex).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      if (!rawMessage) continue;

      try {
        this.handleMessage(JSON.parse(rawMessage) as JsonRpcMessage);
      } catch {
        continue;
      }
    }
  }

  private handleMessage(message: JsonRpcMessage) {
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.pending.delete(message.id);
    clearTimeout(pending.timeout);

    if (message.error) {
      pending.reject(new ServiceUnavailableException(message.error.message || "mcp_search_failed"));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
