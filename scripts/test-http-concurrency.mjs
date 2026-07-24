import assert from "node:assert/strict";
import { once } from "node:events";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startHttpTransport } from "../dist/transport/http.js";

const sharedCore = { listCalls: 0 };
const bearerToken = "test-http-bearer-token-01234567890123456789";
process.env.NOTEBOOKLM_HTTP_BEARER_TOKEN = bearerToken;
const protocolServers = new Set();
const initializeBody = {
  jsonrpc: "2.0",
  id: 99,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "capacity-test", version: "1.0.0" },
  },
};

const handle = await startHttpTransport({
  port: 0,
  host: "127.0.0.1",
  maxSessions: 2,
  sessionTtlMs: 50,
  connect: async (transport) => {
    const server = new Server(
      { name: "http-regression", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    protocolServers.add(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      sharedCore.listCalls += 1;
      return {
        tools: [
          {
            name: "shared-core-proof",
            description: `shared call ${sharedCore.listCalls}`,
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    });
    await server.connect(transport);
  },
});

try {
  const address = handle.server.address();
  assert(address && typeof address === "object");
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const unauthorized = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(initializeBody),
  });
  assert.equal(
    unauthorized.status,
    401,
    "missing bearer token must be rejected before session allocation"
  );
  const transports = [
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${bearerToken}` } },
    }),
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${bearerToken}` } },
    }),
  ];
  const clients = [
    new Client({ name: "client-one", version: "1.0.0" }),
    new Client({ name: "client-two", version: "1.0.0" }),
  ];

  await Promise.all(clients.map((client, index) => client.connect(transports[index])));
  const results = await Promise.all(clients.map((client) => client.listTools()));
  assert.equal(protocolServers.size, 2, "each HTTP transport must own a protocol Server");
  assert.equal(sharedCore.listCalls, 2, "both protocol facades must use the same core state");
  assert(results.every((result) => result.tools[0]?.name === "shared-core-proof"));
  assert.notEqual(transports[0].sessionId, transports[1].sessionId);

  const atCapacity = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify(initializeBody),
  });
  assert.equal(atCapacity.status, 429);

  await Promise.all(clients.map((client) => client.close()));
  await new Promise((resolve) => setTimeout(resolve, 25));

  const oversized = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearerToken}` },
    body: JSON.stringify({ payload: "x".repeat(1_048_576) }),
  });
  assert.equal(oversized.status, 413);
  console.log("HTTP two-client isolation/shared-core/body-cap tests passed");
} finally {
  await handle.close();
  if (handle.server.listening) await once(handle.server, "close");
}

const ttlHandle = await startHttpTransport({
  port: 0,
  host: "127.0.0.1",
  maxSessions: 1,
  sessionTtlMs: 50,
  connect: async (transport) => {
    const server = new Server(
      { name: "ttl-regression", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    await server.connect(transport);
  },
});
try {
  const address = ttlHandle.server.address();
  assert(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  const idleInitialize = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify(initializeBody),
  });
  assert.equal(idleInitialize.status, 200);
  const expiredSessionId = idleInitialize.headers.get("mcp-session-id");
  assert(expiredSessionId);
  await new Promise((resolve) => setTimeout(resolve, 125));
  const expired = await fetch(endpoint, {
    method: "DELETE",
    headers: { "mcp-session-id": expiredSessionId, authorization: `Bearer ${bearerToken}` },
  });
  assert.equal(expired.status, 404, "idle HTTP sessions must be reaped after TTL");
} finally {
  await ttlHandle.close();
}

process.env.NOTEBOOKLM_ALLOW_NON_LOOPBACK = "true";
await assert.rejects(
  () => startHttpTransport({ port: 0, host: "0.0.0.0", connect: async () => undefined }),
  /Refusing non-loopback cleartext HTTP bind/
);
delete process.env.NOTEBOOKLM_ALLOW_NON_LOOPBACK;

process.env.NOTEBOOKLM_HTTP_BEARER_TOKEN = "short-token";
await assert.rejects(
  () => startHttpTransport({ port: 0, host: "127.0.0.1", connect: async () => undefined }),
  /at least 32 bytes/
);
process.env.NOTEBOOKLM_HTTP_BEARER_TOKEN = bearerToken;

let failedInitializeCloses = 0;
const failedHandle = await startHttpTransport({
  port: 0,
  host: "127.0.0.1",
  connect: async (transport) => {
    const originalClose = transport.close.bind(transport);
    transport.close = async () => {
      failedInitializeCloses += 1;
      await originalClose();
    };
    transport.handleRequest = async () => {
      throw new Error("synthetic initialize failure");
    };
  },
});
try {
  const address = failedHandle.server.address();
  assert(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearerToken}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "failed", version: "1" },
      },
    }),
  });
  assert.equal(response.status, 500);
  assert.equal(
    failedInitializeCloses,
    1,
    "failed initialize must close its unregistered transport"
  );
} finally {
  await failedHandle.close();
}
