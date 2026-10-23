// Proof-only: real Gateway, cron/chat admission, HTTP transport, and durable transcript.
// Synthetic model responses establish runtime behavior, not commercial-provider acceptance.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { json } from "node:stream/consumers";
import { expect, it } from "vitest";
import { providerResponse } from "../src/agents/embedded-agent-runner.wire.test-support.js";
import { loadExactSessionEntry } from "../src/config/sessions/session-accessor.js";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { readTranscriptMessages } from "../src/sessions/user-turn-transcript.test-support.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import {
  createOpenAiResponsesModelConfig,
} from "./helpers/openai-responses-model-fixture.js";
import { connectRestartClient } from "./gateway-restart.test-support.js";
import { closeHttpServer, listenLoopback } from "./helpers/gateway-integration-fixtures.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const QUEUED = "[Queued user message from a previous active turn; preserved as context only. Continue with the active prompt below.]";
const KEYED_ERROR = "Session transcript keyed user is outside the current turn";
const WAIT_MS = 240_000;
type Scenario = "cron-timeout" | "dashboard-long-window" | "dashboard-retries";
type Observation = { model: string; markerCount: number; activeInputCount: number; bytes: number };
type Terminal = { status?: string; summary?: string; error?: string; sessionKey?: string; sessionId?: string };

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function text(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.flatMap((part) => {
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
      return [part.text];
    }
    return [];
  }).join("\n");
}

function diagnostic(instance: OpenClawTestInstance, requests: Observation[]) {
  const logs = instance.logs();
  return JSON.stringify({
    requests,
    keyedAssertion: logs.includes(KEYED_ERROR),
    orphanPreserved: count(logs, "Preserved orphaned user message"),
    orphanMerged: count(logs, "Merged and removed orphaned user message"),
    retryEvents: count(logs, "transient same-model retry"),
    // Only selected bounded operational lines; never dump prompts or history.
    errors: logs.split("\n").filter((line) =>
      /keyed user|plugin.*(?:failed|error)|context.engine.*(?:failed|error)/i.test(line),
    ).map((line) => line.slice(0, 350)).slice(-8),
  });
}

it.each<Scenario>(["cron-timeout", "dashboard-long-window", "dashboard-retries"])(
  "issue #168456 current-main production proof: %s",
  { timeout: 480_000 },
  async (scenario) => {
    const startedAt = Date.now();
    const lossless = process.env.ISSUE168456_LOSSLESS_PLUGIN;
    if (process.env.ISSUE168456_REQUIRE_LOSSLESS === "1" && !lossless) {
      throw new Error("Lossless proof requires ISSUE168456_LOSSLESS_PLUGIN");
    }
    const dashboard = scenario !== "cron-timeout";
    const active = `ISSUE168456_ACTIVE_${scenario}`;
    const answer = `ISSUE168456_OK_${scenario}`;
    const warmup = "ISSUE168456_EXISTING_CONVERSATION";
    const requests: Observation[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST") {
          response.writeHead(404).end();
          return;
        }
        const body = await json(request) as { model: string; input?: unknown; messages?: unknown };
        const expectedPath = body.model === "primary" ? "/v1/chat/completions" : "/v1/responses";
        expect(new URL(request.url ?? "/", "http://localhost").pathname).toBe(expectedPath);
        const input = JSON.stringify(body.input ?? body.messages ?? []);
        requests.push({
          model: body.model,
          markerCount: count(input, QUEUED),
          activeInputCount: count(input, active),
          bytes: Buffer.byteLength(input),
        });
        const activeTurn = input.includes(active);
        if (body.model === "primary" && activeTurn) {
          if (!dashboard) {
            // The production provider timeout aborts this real pending HTTP request.
            return;
          }
          response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
          response.end(JSON.stringify({ error: {
            type: "rate_limit_error",
            message: scenario === "dashboard-long-window"
              ? "Weekly and monthly usage quota exceeded. Please wait until your quota resets next week."
              : "Rate limit exceeded. Please retry.",
          } }));
          return;
        }
        const fixture = providerResponse({
          api: body.model === "primary" ? "openai-completions" : "openai-responses",
          model: body.model,
          text: activeTurn ? answer : "ISSUE168456_WARMUP_OK",
          messageId: `msgproof${requests.length}`,
          id: `respproof${requests.length}`,
          calls: [],
        }).response;
        response.writeHead(fixture.status, Object.fromEntries(fixture.headers));
        response.end(await fixture.text());
      })().catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: String(error) } }));
      });
    });
    const baseUrl = await listenLoopback(server, "http");
    let instance: OpenClawTestInstance | undefined;
    let client: Awaited<ReturnType<typeof connectRestartClient>> | undefined;
    try {
      const config = createOpenAiResponsesModelConfig({
        baseUrl,
        providerId: "proof-primary",
        modelId: "primary",
        reasoning: false,
        toolProfile: "minimal",
      });
      const primary = config.models!.providers!["proof-primary"]!;
      const backup = { ...primary, models: primary.models.map((model) => ({ ...model, id: "backup", name: "backup" })) };
      config.models!.providers!["proof-backup"] = backup;
      primary.api = "openai-completions";
      primary.models = primary.models.map((model) => ({ ...model, api: "openai-completions" }));
      primary.timeoutSeconds = dashboard ? 180 : 2;
      config.models!.catalogRefresh = { enabled: false };
      config.agents!.defaults!.model = {
        primary: "proof-primary/primary", fallbacks: ["proof-backup/backup"],
      };
      config.agents!.defaults!.models!["proof-backup/backup"] = {
        agentRuntime: { id: "openclaw" }, params: { transport: "sse", openaiWsWarmup: false },
      };
      config.agents!.defaults!.models!["proof-primary/primary"] = {
        agentRuntime: { id: "openclaw" }, params: { transport: "sse", openaiWsWarmup: false },
      };
      if (lossless) {
        config.plugins = {
          allow: ["lossless-claw"], load: { paths: [lossless] },
          slots: { memory: "none", contextEngine: "lossless-claw" },
          entries: { "lossless-claw": { enabled: true } },
        };
      }
      instance = await createOpenClawTestInstance({
        name: `issue168456-${scenario}`, config: { ...config },
        env: {
          OPENCLAW_SKIP_CRON: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
      });
      await mkdir(instance.state.agentDir(), { recursive: true });
      await writeFile(path.join(instance.state.agentDir(), "settings.json"), JSON.stringify({
        retry: { provider: { maxRetries: dashboard ? 8 : 0 } },
      }));
      if (lossless) {
        const saved = JSON.parse(await readFile(instance.configPath, "utf8"));
        saved.plugins.entries["lossless-claw"].config = {
          databasePath: instance.state.path("lossless-proof.sqlite"),
          independentLogFile: { enabled: false },
        };
        await instance.state.writeConfig(saved);
      }
      await instance.startGateway();
      const { buildId } = JSON.parse(await readFile("dist/build-info.json", "utf8"));
      expect(typeof buildId).toBe("string");
      client = await connectRestartClient(instance, {
        role: "operator", scopes: ["operator.admin", "operator.read", "operator.write"],
        ...(dashboard ? {
          origin: `http://127.0.0.1:${instance.port}`,
          clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          clientBuildId: buildId,
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        } : {}),
      });
      const send = async (sessionKey: string, message: string) => {
        const sent = await client!.request<{ runId: string; status: string }>("chat.send", {
          sessionKey, message, deliver: false, idempotencyKey: randomUUID(),
        });
        const terminal = await client!.request<Terminal>("agent.wait", {
          runId: sent.runId, timeoutMs: WAIT_MS,
        }, { timeoutMs: WAIT_MS + 5_000 });
        expect(terminal.status, diagnostic(instance!, requests)).toBe("ok");
      };
      let sessionKey = "agent:main:dashboard:issue168456";
      let cronSessionId: string | undefined;
      if (dashboard) {
        await send(sessionKey, warmup);
        await send(sessionKey, active);
        const history = await client.request<{ messages: Array<{ role: string; content?: unknown }> }>(
          "chat.history", { sessionKey, limit: 100 },
        );
        expect(history.messages.some((message) => message.role === "assistant" && text(message.content).includes(answer))).toBe(true);
      } else {
        const job = await client.request<{ id: string }>("cron.add", {
          name: "issue168456 timeout reproduction", agentId: "main", enabled: true, deleteAfterRun: false,
          schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
          sessionTarget: "isolated", wakeMode: "now", delivery: { mode: "none" },
          payload: { kind: "agentTurn", message: active, timeoutSeconds: 120, toolsAllow: [] },
        });
        const run = await client.request<{ runId: string }>("cron.run", { id: job.id, mode: "force" });
        let terminal: Terminal | undefined;
        await expect.poll(async () => {
          const history = await client!.request<{ entries: Terminal[] }>("cron.runs", {
            id: job.id, runId: run.runId, limit: 1,
          });
          terminal = history.entries[0];
          return terminal?.status;
        }, { timeout: WAIT_MS, interval: 100 }).toBeDefined();
        expect(terminal, diagnostic(instance, requests)).toMatchObject({ status: "ok", summary: expect.stringContaining(answer) });
        expect(terminal?.sessionKey).toBeTruthy();
        sessionKey = terminal!.sessionKey!;
        cronSessionId = terminal!.sessionId;
        expect(cronSessionId, diagnostic(instance, requests)).toEqual(expect.any(String));
      }
      await disconnectGatewayClient(client);
      client = undefined;
      await instance.stopGateway();
      const storePath = path.join(instance.state.agentDir(), "openclaw-agent.sqlite");
      // Cron history owns the completed private run identity; its visible entry may be retired.
      const sessionId = dashboard
        ? loadExactSessionEntry({ agentId: "main", sessionKey, storePath })?.entry.sessionId
        : cronSessionId;
      expect(sessionId, diagnostic(instance, requests)).toEqual(expect.any(String));
      const messages = await readTranscriptMessages({ sessionKey, sessionId: sessionId!, storePath });
      const visible = messages.filter((message) => message.role === "user" && message.display !== false);
      const activeUsers = visible.filter((message) => text(message.content).includes(active));
      expect(activeUsers).toHaveLength(1);
      expect(activeUsers[0]?.idempotencyKey).toEqual(expect.any(String));
      expect(visible).toHaveLength(dashboard ? 2 : 1);
      const activeRequests = requests.filter((request) => request.activeInputCount > 0);
      const primaryCount = activeRequests.filter((request) => request.model === "primary").length;
      expect(primaryCount, diagnostic(instance, requests)).toBe(scenario === "dashboard-retries" ? 9 : 1);
      expect(activeRequests.filter((request) => request.model === "backup")).toHaveLength(1);
      expect(activeRequests.every((request) => request.markerCount === 0), diagnostic(instance, requests)).toBe(true);
      expect(instance.logs().includes(KEYED_ERROR)).toBe(false);
      if (lossless) {
        expect(instance.logs()).not.toMatch(/\[context-engine\].*(?:degraded|falling back|downgrad|quarantin)/i);
        expect(instance.logs()).toContain("[lcm] assemble: done");
        expect(instance.logs()).not.toMatch(/lossless-claw[^\n]*(?:failed|error|not found)/i);
      }
      console.log("ISSUE168456_PROOF", JSON.stringify({
        scenario, engine: lossless ? "lossless-claw" : "default", primaryCount,
        backupCount: 1, visibleUserCount: visible.length, admittedActiveUsers: activeUsers.length,
        queuedMarkerCounts: activeRequests.map((request) => request.markerCount),
        keyedAssertion: false, wallMs: Date.now() - startedAt,
      }));
    } catch (error) {
      console.error("ISSUE168456_DIAGNOSTIC", instance ? diagnostic(instance, requests) : JSON.stringify({ requests }));
      throw error;
    } finally {
      if (client) {
        await disconnectGatewayClient(client);
      }
      await instance?.cleanup();
      await closeHttpServer(server);
    }
  },
);
