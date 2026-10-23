// Proof-only branch artifact: real isolated Gateway, synthetic HTTPS provider responses.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { expect, it } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import { nativeModel, writeNativeCompletion } from "./e2e/qa-lab/runtime/native-provider-proof-fixture.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import { createOpenClawTestInstance, type OpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const STANDARD_HOST = "dashscope-intl.aliyuncs.com";
const TOKEN_HOST = "token-plan.ap-southeast-1.maas.aliyuncs.com";
const STANDARD_URL = `https://${STANDARD_HOST}/compatible-mode/v1`;
const TOKEN_URL = `https://${TOKEN_HOST}/compatible-mode/v1`;
// Keep the fixture ID stable through strict custom-provider replay normalization.
const TOOL_ID = "qwenproofread";
const FILE_CONTENT = "QWEN_PROOF_FILE_CONTENT";
const REASONING = "QWEN_PROOF_REASONING";
type WireMessage = { role?: string; content?: unknown; reasoning_content?: unknown; tool_call_id?: string };
type WireRequest = { model?: string; enable_thinking?: unknown; reasoning_effort?: unknown; thinking?: unknown; messages?: WireMessage[] };

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proof listener unavailable");
  return address.port;
}

it("proves custom Qwen thinking and tool replay through a real Gateway", { timeout: 300_000 }, async ({ signal }) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qwen-gateway-proof-"));
  const sockets = new Set<Duplex>();
  const servers: Server[] = [];
  const wire: WireRequest[] = [];
  const handlerErrors: string[] = [];
  const connectTargets: string[] = [];
  let instance: OpenClawTestInstance | undefined;
  let client: GatewayClient | undefined;
  let activeRun: string | undefined;
  let activeSessionKey: string | undefined;
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const summarize = (route: string, thinkingLevel: string, requests: WireRequest[]) => {
    const request = requests[0];
    const toolRequest = requests.find((item) => item.messages?.some((message) => message.role === "tool"));
    const summary = {
      route, thinkingLevel,
      enable_thinking: request?.enable_thinking ?? null,
      reasoning_effort: request?.reasoning_effort ?? null,
      requests: requests.length,
      toolResultReplayed: Boolean(toolRequest?.messages?.some((message) => message.role === "tool" && JSON.stringify(message.content).includes(FILE_CONTENT))),
      reasoningReplayed: Boolean(toolRequest?.messages?.some((message) => message.role === "assistant" && message.reasoning_content === REASONING)),
      reasoningFields: requests.reduce((count, item) => count + (item.messages?.filter((message) => message.reasoning_content !== undefined).length ?? 0), 0),
    };
    console.log("QWEN_GATEWAY_PROOF", JSON.stringify(summary));
    return summary;
  };
  try {
    const openssl = (args: string[]) => execFileSync("openssl", args, { cwd: tempDir, stdio: "ignore" });
    openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca-key.pem", "-out", "ca.pem", "-days", "1", "-subj", "/CN=Qwen Synthetic Proof CA"]);
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server-key.pem", "-out", "server.csr", "-subj", `/CN=${STANDARD_HOST}`]);
    await fs.writeFile(path.join(tempDir, "server-ext.cnf"), `subjectAltName=DNS:${STANDARD_HOST},DNS:${TOKEN_HOST}\n`);
    openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca-key.pem", "-CAcreateserial", "-out", "server.pem", "-days", "1", "-sha256", "-extfile", "server-ext.cnf"]);
    instance = await createOpenClawTestInstance({
      name: `qwen-proof-${randomUUID()}`,
      env: {
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_PROXY_URL: undefined,
        NODE_TLS_REJECT_UNAUTHORIZED: undefined,
        NODE_EXTRA_CA_CERTS: path.join(tempDir, "ca.pem"),
      },
      signal,
      startTimeoutMs: 120_000,
      stopTimeoutMs: 20_000,
    });
    const fixturePath = path.join(instance.state.workspaceDir, "qwen-proof.txt");
    await fs.mkdir(instance.state.workspaceDir, { recursive: true });
    await fs.writeFile(fixturePath, FILE_CONTENT);
    const provider = createHttpsServer({
      key: await fs.readFile(path.join(tempDir, "server-key.pem")),
      cert: await fs.readFile(path.join(tempDir, "server.pem")),
    }, (request, response) => {
      void (async () => {
        if (request.method !== "POST" || request.url !== "/compatible-mode/v1/chat/completions") {
          handlerErrors.push(`unexpected-http:${request.method}:${request.url?.split("?")[0]}`);
          response.writeHead(404); response.end(); return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as WireRequest;
        wire.push(body);
        const token = body.model === "deepseek-v4-pro";
        const off = Boolean(body.messages?.some((message) => message.role === "user" && JSON.stringify(message.content).includes("QWEN_OFF_TURN")));
        const toolResult = body.messages?.find((message) => message.role === "tool" && message.tool_call_id === TOOL_ID);
        if (token && !off && !toolResult) {
          writeNativeCompletion(response, "proof-tool", body.model!, {
            role: "assistant", reasoning_content: REASONING, content: "",
            tool_calls: [{ index: 0, id: TOOL_ID, type: "function", function: { name: "read", arguments: JSON.stringify({ path: fixturePath }) } }],
          }, "tool_calls");
        } else {
          writeNativeCompletion(response, "proof-final", body.model ?? "unknown", off ? "QWEN_OFF_OK" : token ? "QWEN_TOOL_OK" : "QWEN_STANDARD_OK");
        }
      })().catch((error: unknown) => {
        handlerErrors.push(`provider-handler-failed:${String(error)}`);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    provider.on("connection", track);
    servers.push(provider);
    const providerPort = await listen(provider);
    const proxy = createServer((_request, response) => { response.writeHead(403); response.end(); });
    proxy.on("connection", track);
    proxy.on("connect", (request, socket, head) => {
      const target = request.url ?? "";
      if (target !== `${STANDARD_HOST}:443` && target !== `${TOKEN_HOST}:443`) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return;
      }
      connectTargets.push(target);
      const upstream = net.connect(providerPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(socket); socket.pipe(upstream);
      });
      track(upstream);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
    });
    servers.push(proxy);
    const proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
    Object.assign(instance.env, { HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" });
    const standardModel = nativeModel("qwen3.8-flash", { reasoning: true });
    const tokenModel = nativeModel("deepseek-v4-pro", { reasoning: true });
    const providerConfig = (baseUrl: string, model: ReturnType<typeof nativeModel>) => ({ baseUrl, api: "openai-completions", apiKey: "synthetic-qwen-proof-key", models: [model] });
    await instance.state.writeConfig({
      plugins: { allow: ["qwen"], entries: { qwen: { enabled: true } }, slots: { memory: "none" } },
      models: { mode: "merge", catalogRefresh: { enabled: false }, providers: {
        qwen: providerConfig(STANDARD_URL, standardModel),
        "custom-standard": providerConfig(STANDARD_URL, standardModel),
        "custom-token": providerConfig(TOKEN_URL, tokenModel),
      } },
      agents: { defaults: { workspace: instance.state.workspaceDir, model: { primary: "qwen/qwen3.8-flash" }, models: Object.fromEntries(["qwen/qwen3.8-flash", "custom-standard/qwen3.8-flash", "custom-token/deepseek-v4-pro"].map(ref => [ref, { agentRuntime: { id: "openclaw" } }])), skipBootstrap: true, timeoutSeconds: 60, skills: [] }, entries: { main: {} } },
      tools: { profile: "full", allow: ["read"], codeMode: { enabled: false }, web: { search: { enabled: false } } },
      gateway: { mode: "local", bind: "loopback", port: instance.port, auth: { mode: "token", token: instance.gatewayToken }, controlUi: { enabled: false } },
      logging: { file: instance.state.path("gateway.log"), level: "warn" },
    });
    await instance.startGateway();
    client = await acquireGatewayTestClient({
      url: instance.url, token: instance.gatewayToken, deviceIdentity: null,
      clientName: "gateway-client", mode: "backend", scopes: ["operator.admin", "operator.read", "operator.write"], requestTimeoutMs: 90_000,
    }, { timeoutMs: 30_000, timeoutMessage: "Qwen proof connect timeout", closeMessage: "Qwen proof connection closed", signal });
    const createSession = async (model: string) => {
      const key = `agent:main:qwen-proof-${randomUUID()}`;
      await client!.request("sessions.create", { key, model });
      return key;
    };
    const run = async (sessionKey: string, message: string, thinking: string) => {
      activeSessionKey = sessionKey;
      const wireStart = wire.length;
      const accepted = await client!.request<{ runId: string }>("agent", { sessionKey, message, thinking, deliver: false, idempotencyKey: randomUUID(), timeout: 60 });
      activeRun = accepted.runId;
      const terminal = await client!.request<{ status: string; error?: string; stopReason?: string; providerStarted?: boolean }>("agent.wait", { runId: activeRun, timeoutMs: 75_000 });
      activeRun = undefined;
      activeSessionKey = undefined;
      console.log("QWEN_RUN_RESULT", JSON.stringify({
        phase: message.split(":")[0], thinking, status: terminal.status,
        error: terminal.error?.replaceAll(fixturePath, "<fixture-file>"),
        stopReason: terminal.stopReason, providerStarted: terminal.providerStarted,
        models: wire.slice(wireStart).map(request => request.model),
        connectTargets, handlerErrors,
      }));
      expect(terminal.status, "Gateway terminal status").toBe("ok");
      return await client!.request<{ messages: Array<{ role?: string; content?: unknown }> }>("chat.history", { sessionKey, limit: 100 });
    };
    // A completed native request explicitly activates Qwen; cold custom activation is outside scope.
    await run(await createSession("qwen/qwen3.8-flash"), "QWEN_WARMUP", "medium");
    let start = wire.length;
    const standardHistory = await run(await createSession("custom-standard/qwen3.8-flash"), "QWEN_STANDARD_TURN", "medium");
    const standard = summarize("standard", "medium", wire.slice(start));
    expect.soft(standard.enable_thinking).toBe(true);
    expect.soft(standard.reasoning_effort).toBe("medium");
    expect.soft(standardHistory.messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("QWEN_STANDARD_OK"))).toBe(true);
    const tokenSession = await createSession("custom-token/deepseek-v4-pro");
    start = wire.length;
    const toolHistory = await run(tokenSession, "QWEN_TOOL_TURN: read qwen-proof.txt once, then finish.", "medium");
    const token = summarize("token-plan", "medium", wire.slice(start));
    expect.soft(token.enable_thinking).toBe(true);
    expect.soft(token.reasoning_effort).toBe("high");
    expect.soft(token.requests).toBe(2);
    expect.soft(token.toolResultReplayed).toBe(true);
    expect.soft(token.reasoningReplayed).toBe(true);
    expect.soft(toolHistory.messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("QWEN_TOOL_OK"))).toBe(true);
    start = wire.length;
    const offHistory = await run(tokenSession, "QWEN_OFF_TURN: finish without tools.", "off");
    const offRequests = wire.slice(start);
    const off = summarize("token-plan", "off", offRequests);
    expect.soft(off.enable_thinking).toBe(false);
    expect.soft(off.reasoning_effort).toBeNull();
    expect.soft(off.reasoningFields).toBe(0);
    expect.soft(offRequests[0]?.messages?.filter((message) => message.role === "user" && JSON.stringify(message.content).includes("QWEN_TOOL_TURN"))).toHaveLength(1);
    expect.soft(offHistory.messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("QWEN_OFF_OK"))).toBe(true);
    expect.soft(connectTargets).toContain(`${STANDARD_HOST}:443`);
    expect.soft(connectTargets).toContain(`${TOKEN_HOST}:443`);
    expect.soft(handlerErrors).toEqual([]);
  } finally {
    const cleanups: Array<() => Promise<unknown>> = [];
    if (client && activeRun) cleanups.push(() => client!.request("chat.abort", { sessionKey: activeSessionKey, runId: activeRun }));
    if (client) cleanups.push(() => client!.stopAndWait({ timeoutMs: 2_000 }));
    if (instance) cleanups.push(() => instance!.cleanup());
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      for (const server of servers.toReversed()) {
        if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });
    cleanups.push(() => fs.rm(tempDir, { recursive: true, force: true }));
    const errors: unknown[] = [];
    for (const cleanup of cleanups) { try { await cleanup(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "Qwen proof cleanup failed");
  }
});
