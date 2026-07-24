/**
 * Streamable-HTTP transport for the MCP server (issue #4).
 *
 * Hosts the MCP protocol over HTTP using the SDK's
 * `StreamableHTTPServerTransport`. Built on Node's stdlib `http` module so we
 * don't pull in Express just to forward requests. Two operations:
 *
 *   POST /mcp        — JSON-RPC requests/responses
 *   GET  /healthz    — liveness probe (200 OK with version)
 *
 * Multiple sessions are supported via the `Mcp-Session-Id` header — each
 * session keeps its own transport so concurrent clients don't tread on each
 * other. Session lifecycle is fully owned by the SDK; we just route.
 */

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../utils/logger.js";

export interface HttpTransportOptions {
  port: number;
  host?: string;
  /** Connect callback invoked once per new session — wires the McpServer to the transport. */
  connect: (transport: StreamableHTTPServerTransport) => Promise<void>;
  maxSessions?: number;
  sessionTtlMs?: number;
}

export interface HttpTransportHandle {
  server: HttpServer;
  close: () => Promise<void>;
}

const SESSION_HEADER = "mcp-session-id";
const MAX_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;

type TransportEntry = {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  activeRequests: number;
};
type SessionCapacity = { initializing: number };

class HttpInputError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export async function startHttpTransport(opts: HttpTransportOptions): Promise<HttpTransportHandle> {
  const bearerToken = process.env.NOTEBOOKLM_HTTP_BEARER_TOKEN;
  if (!bearerToken || Buffer.byteLength(bearerToken, "utf8") < 32) {
    throw new Error("NOTEBOOKLM_HTTP_BEARER_TOKEN must be set and at least 32 bytes long");
  }
  const host = opts.host ?? "127.0.0.1";
  if (!isLoopback(host)) {
    throw new Error(
      "Refusing non-loopback cleartext HTTP bind. Use a TLS-terminating reverse proxy or Tailscale tunnel at the external boundary."
    );
  }
  const transports = new Map<string, TransportEntry>();
  const maxSessions = positiveInteger(opts.maxSessions, DEFAULT_MAX_SESSIONS);
  const sessionTtlMs = positiveInteger(opts.sessionTtlMs, DEFAULT_SESSION_TTL_MS);
  const capacity: SessionCapacity = { initializing: 0 };
  const reapTimer = setInterval(
    () => {
      const cutoff = Date.now() - sessionTtlMs;
      for (const [sessionId, entry] of transports.entries()) {
        if (entry.activeRequests === 0 && entry.lastActivity < cutoff) {
          transports.delete(sessionId);
          void entry.transport.close();
        }
      }
    },
    Math.min(sessionTtlMs, 60_000)
  );
  reapTimer.unref();

  const server = createServer((req, res) => {
    void handleRequest(req, res, transports, opts, maxSessions, capacity, bearerToken).catch(
      (err) => {
        log.error(`❌ [HTTP] Unhandled request error: ${err}`);
        if (!res.headersSent) {
          const status = err instanceof HttpInputError ? err.status : 500;
          res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
          res.end(
            JSON.stringify({ error: status === 500 ? "internal server error" : err.message })
          );
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.off("error", reject);
      log.success(`🌐 HTTP transport listening on http://${host}:${opts.port}/mcp`);
      resolve();
    });
  });

  return {
    server,
    close: async () => {
      clearInterval(reapTimer);
      for (const { transport } of transports.values()) {
        try {
          await transport.close();
        } catch {
          /* ignore — best-effort shutdown */
        }
      }
      transports.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  };
}

/**
 * Use the McpServer high-level Server class — it accepts any Transport.
 * Bridge helper kept for callers wiring an existing McpServer instance.
 */
export async function bindMcpServer(
  mcpServer: McpServer,
  transport: StreamableHTTPServerTransport
): Promise<void> {
  await mcpServer.connect(transport);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transports: Map<string, TransportEntry>,
  opts: HttpTransportOptions,
  maxSessions: number,
  capacity: SessionCapacity,
  bearerToken: string
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", protocol: "mcp-streamable-http" }));
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found", expected: "/mcp" }));
    return;
  }

  if (!isAuthorized(req, bearerToken)) {
    res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const sessionId = headerString(req.headers[SESSION_HEADER]);

  if (req.method === "GET" || req.method === "DELETE") {
    // SSE streams + session termination — both routed by session.
    const entry = sessionId ? transports.get(sessionId) : undefined;
    if (!entry) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unknown session" }));
      return;
    }
    entry.lastActivity = Date.now();
    entry.activeRequests += 1;
    try {
      await entry.transport.handleRequest(req, res);
    } finally {
      entry.activeRequests -= 1;
      entry.lastActivity = Date.now();
    }
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST, GET, DELETE" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  const body = await readJsonBody(req);

  // Re-use existing session, or initialise a new one when the client says so.
  let entry = sessionId ? transports.get(sessionId) : undefined;
  let transport = entry?.transport;
  let reserved = false;
  if (!transport && isInitializeRequest(body)) {
    if (transports.size + capacity.initializing >= maxSessions) {
      throw new HttpInputError(429, `HTTP MCP session limit (${maxSessions}) reached`);
    }
    capacity.initializing += 1;
    reserved = true;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, {
          transport: transport!,
          lastActivity: Date.now(),
          activeRequests: 0,
        });
      },
    });
    transport.onclose = () => {
      if (transport!.sessionId) transports.delete(transport!.sessionId);
    };
    try {
      await opts.connect(transport);
    } catch (error) {
      capacity.initializing -= 1;
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  if (!transport) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "no transport for request — pass an `Mcp-Session-Id` header or send `initialize`",
      })
    );
    return;
  }

  entry = transport.sessionId ? transports.get(transport.sessionId) : undefined;
  if (entry) {
    entry.lastActivity = Date.now();
    entry.activeRequests += 1;
  }
  try {
    await transport.handleRequest(req, res, body);
  } catch (error) {
    // An initialize transport is not registered until the SDK assigns its
    // session id. If initialize fails, explicitly close both unregistered and
    // partially registered transports so protocol facades cannot leak.
    if (reserved) {
      if (transport.sessionId) transports.delete(transport.sessionId);
      await transport.close().catch(() => undefined);
    }
    throw error;
  } finally {
    if (entry) {
      entry.activeRequests -= 1;
      entry.lastActivity = Date.now();
    }
    if (reserved) capacity.initializing -= 1;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new HttpInputError(413, "Request body exceeds 1 MiB limit");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpInputError(400, "Invalid JSON request body");
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isAuthorized(req: IncomingMessage, expected: string): boolean {
  const value = headerString(req.headers.authorization);
  if (!value || !value.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice(7), "utf8");
  const target = Buffer.from(expected, "utf8");
  return supplied.length === target.length && timingSafeEqual(supplied, target);
}
