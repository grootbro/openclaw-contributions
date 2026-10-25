import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { AgentJobTerminalSnapshot } from "../../../../src/gateway/agent-turn/types.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import { NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND } from "../../../../src/infra/node-commands.js";
import { parseNodeWorkerLaunchInput } from "../../../../src/worker/node-supervisor-protocol.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../../helpers/qa-gateway-test-lifetime.js";
import { MODEL_REF, PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import {
  closeNativeProvider,
  createNativeProvider,
  listenNativeProvider,
  nativeModel,
  writeNativeCompletion,
} from "./native-provider-proof-fixture.js";
import {
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  createWireWorkspaceSettlementWaiter,
  startPairedNodeWorkerGateway,
  wireMessageText,
  type PairedNodeWorkerHost,
} from "./paired-node-worker-wire-fixture.js";

const execFileAsync = promisify(execFile);
const [providerId, modelId] = MODEL_REF.split("/");
const KEY = "agent:qa:native-build-cache";
const RUN_ID = "nativebuildcacheproof";
const ANSWER = "NATIVE_BUILD_CACHE_OK";
const AUTHORED = ".artifacts/build-all-cache/authored.txt";
const REPORT = ".artifacts/report.md";
const GENERATED = [
  ".artifacts/build-all-cache/generated.bin",
  ".artifacts/build-cache-inputs/generated.receipt",
] as const;

type ToolReceipt = { cwd: string; uid: number; denied: string[] };

async function git(cwd: string, ...args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], { timeout: 20_000 });
}

// #177057 and the withdrawn #178917 distinguish disposable build output from
// authored inputs under the same roots. Only the model decision is synthetic:
// this composes public dispatch, an installed native worker, exec and settlement.
it.skipIf(process.platform !== "linux")(
  "reconciles authored cache-root edits after a native tool creates unreadable disposable build caches",
  async (context) => {
    expect(process.getuid?.(), "permission proof requires an unprivileged Linux runner").not.toBe(
      0,
    );
    const owner = createQaGatewayChild();
    let published: Awaited<ReturnType<typeof createPublishedWireWorkspace>> | undefined;
    let node: PairedNodeWorkerHost | undefined;
    let operator: Awaited<ReturnType<typeof connectWireClient>> | undefined;
    let workerReceipt: ToolReceipt | undefined;
    let providerRequests = 0;
    let gatewayRequests = 0;
    const providerErrors: unknown[] = [];
    const script = [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'if (process.getuid() === 0) throw new Error("Permission proof cannot run as root");',
      `const generated = ${JSON.stringify(GENERATED)};`,
      'for (const name of generated) { fs.mkdirSync(path.dirname(name), {recursive:true}); fs.writeFileSync(name, "disposable build output"); fs.chmodSync(name, 0); }',
      `fs.writeFileSync(${JSON.stringify(AUTHORED)}, "authored edit survives\\n");`,
      `fs.writeFileSync(${JSON.stringify(REPORT)}, "useful report survives\\n");`,
      'const denied = generated.map(name => { try { fs.readFileSync(name); throw new Error("Unreadable cache was readable"); } catch (error) { if (error.code !== "EACCES") throw error; return name; } });',
      'console.log("CACHEPROOF:" + Buffer.from(JSON.stringify({cwd:process.cwd(), uid:process.getuid(), denied})).toString("base64"));',
    ].join("\n");
    const command = `node -e '${script.replaceAll("'", "'\\''")}'`;
    const provider = createNativeProvider(
      async (request, response, raw) => {
        expect(request.url).toBe("/v1/chat/completions");
        providerRequests += 1;
        const body = JSON.parse(raw) as {
          messages: Array<{ role: string; content?: unknown }>;
          tools?: Array<{ function?: { name?: string } }>;
        };
        const tool = body.messages.findLast((message) => message.role === "tool");
        if (!tool) {
          expect(providerRequests).toBe(1);
          expect(body.tools?.some((candidate) => candidate.function?.name === "exec")).toBe(true);
          writeNativeCompletion(
            response,
            "nativecachetool",
            modelId!,
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "nativecacheexec",
                  type: "function",
                  function: {
                    name: "exec",
                    arguments: JSON.stringify({ command, yieldMs: 10_000 }),
                  },
                },
              ],
            },
            "tool_calls",
          );
          return;
        }
        expect(providerRequests).toBe(2);
        const encoded = JSON.stringify(tool.content).match(/CACHEPROOF:([A-Za-z0-9+/=]+)/u)?.[1];
        expect(encoded, "real exec must report EACCES for both generated files").toBeTruthy();
        workerReceipt = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")) as ToolReceipt;
        expect(workerReceipt.uid).toBeGreaterThan(0);
        expect(workerReceipt.denied).toEqual(GENERATED);
        expect(path.isAbsolute(workerReceipt.cwd)).toBe(true);
        writeNativeCompletion(response, "nativecachefinal", modelId!, ANSWER);
      },
      (error, response) => {
        providerErrors.push(error);
        response.writeHead(500).end("synthetic provider contract failed");
      },
    );
    const forbiddenGatewayProvider = createNativeProvider(
      async (_request, response) => {
        gatewayRequests += 1;
        response.writeHead(503).end("Gateway inference is forbidden by this native-worker proof");
      },
      (_error, response) => response.destroy(),
    );
    await runQaGatewayTestFixture(
      context,
      async ({ signal, createTempDir }) => {
        const root = createTempDir("native-build-cache-");
        published = await createPublishedWireWorkspace(root);
        await fs.mkdir(path.join(published.source, path.dirname(AUTHORED)), { recursive: true });
        await fs.writeFile(path.join(published.source, AUTHORED), "original authored input\n");
        await git(published.source, "add", AUTHORED);
        await git(published.source, "commit", "-m", "add authored build-root input");
        await git(published.source, "push", path.join(root, "repo.git"), "main");
        await git(path.join(root, "repo.git"), "update-server-info");
        const providerBaseUrl = await listenNativeProvider(provider);
        const gatewayBaseUrl = await listenNativeProvider(forbiddenGatewayProvider);
        const identity = loadOrCreateDeviceIdentity({
          env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "node-state") },
        });
        const gateway = await startPairedNodeWorkerGateway({
          owner,
          providerBaseUrl: gatewayBaseUrl.replace(/\/v1$/u, ""),
          nativeWorkerDeviceId: identity.deviceId,
          fullAccess: true,
          mutateConfig: (config) => ({
            ...config,
            memory: { ...config.memory, search: { ...config.memory?.search, enabled: false } },
          }),
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.resolve("dist/index.js")],
            tempParentDir: root,
          },
        });
        const settlement = createWireWorkspaceSettlementWaiter();
        operator = await connectWireClient({
          gateway,
          role: "operator",
          identity: null,
          onEvent: settlement.onEvent,
        });
        await operator.request("sessions.subscribe", {});
        node = await createPairedNodeWorkerHost({
          gateway,
          operator,
          root,
          capacity: 1,
          nodeConfig: {
            models: {
              providers: {
                [providerId!]: {
                  apiKey: "synthetic-native-cache-key",
                  api: "openai-completions",
                  baseUrl: providerBaseUrl,
                  models: [
                    nativeModel(modelId!, {
                      maxTokens: 128,
                      reasoning: true,
                      thinkingLevelMap: { medium: "medium" },
                    }),
                  ],
                },
              },
            },
          },
        });
        expect(node.identity.deviceId).toBe(identity.deviceId);
        const created = await operator.request<{ worktree: { path: string } }>("sessions.create", {
          key: KEY,
          agentId: "qa",
          worktree: true,
          worktreeName: "native-build-cache",
          worktreeBaseRef: "main",
          cwd: published.source,
        });
        const dispatched = await operator.request<{
          placement: {
            state: string;
            workspaceBaseManifestRef: string;
          };
        }>("sessions.dispatch", { key: KEY, profileId: "native" }, { timeoutMs: PROOF_TIMEOUT_MS });
        expect(dispatched.placement.state).toBe("active");
        expect(
          await operator.request("chat.send", {
            sessionKey: KEY,
            message: "Run the synthetic build-cache operation, then report its completion.",
            deliver: false,
            idempotencyKey: RUN_ID,
          }),
        ).toMatchObject({ runId: RUN_ID, status: "started" });
        const terminal = await operator.request<AgentJobTerminalSnapshot>(
          "agent.wait",
          {
            runId: RUN_ID,
            timeoutMs: PROOF_TIMEOUT_MS,
          },
          { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
        );
        console.info("native-build-cache", {
          terminalStatus: terminal.status,
          terminalError: terminal.error?.slice(0, 600),
          providerRequests,
          gatewayRequests,
          unreadableFiles: workerReceipt?.denied.length ?? 0,
          launches: node.frames
            .filter((frame) => frame.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND)
            .map((frame) => {
              const launch = parseNodeWorkerLaunchInput(frame.paramsJSON);
              return {
                runId: launch.descriptor.assignment.runId,
                inference: launch.descriptor.assignment.inference,
                modelRef: launch.descriptor.assignment.modelRef,
              };
            }),
          captureErrors: gateway
            .logs()
            .split("\n")
            .filter((line) => /EACCES|permission denied|inference|profile|error|fail/iu.test(line))
            .map((line) => line.slice(0, 350))
            .slice(-12),
        });
        expect(terminal).toMatchObject({ status: "ok" });
        expect(providerErrors).toEqual([]);
        expect(providerRequests).toBe(2);
        expect(gatewayRequests).toBe(0);
        expect(workerReceipt).toBeDefined();
        expect(workerReceipt!.cwd).not.toBe(created.worktree.path);
        try {
          await settlement.wait(
            operator,
            KEY,
            AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
            dispatched.placement.workspaceBaseManifestRef,
          );
        } catch (error) {
          console.info("native-build-cache-settlement-failed", {
            providerRequests,
            unreadableFiles: workerReceipt?.denied.length ?? 0,
            captureErrors: gateway
              .logs()
              .split("\n")
              .filter((line) => /EACCES|permission denied|workspace.*(?:fail|error)/iu.test(line))
              .map((line) => line.slice(0, 350))
              .slice(-6),
          });
          throw error;
        }
        await node.waitForWorkersIdle();
        await vi.waitFor(
          async () => {
            expect(await fs.readFile(path.join(created.worktree.path, AUTHORED), "utf8")).toBe(
              "authored edit survives\n",
            );
            expect(await fs.readFile(path.join(created.worktree.path, REPORT), "utf8")).toBe(
              "useful report survives\n",
            );
          },
          { timeout: 10_000 },
        );
        for (const generated of GENERATED) {
          await expect(fs.stat(path.join(created.worktree.path, generated))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        const history = await operator.request<{ messages: unknown[] }>("chat.history", {
          sessionKey: KEY,
        });
        expect(history.messages.map(wireMessageText)).toContain(ANSWER);
        expect(node.invokeErrors).toEqual([]);
      },
      async () => {
        // Repair only the two proof-created regular files, after worker shutdown;
        // never broaden permissions on a caller workspace or suppress cleanup errors.
        await node?.stop();
        if (workerReceipt) {
          for (const generated of GENERATED) {
            await fs
              .chmod(path.join(workerReceipt.cwd, generated), 0o600)
              .catch((error: unknown) => {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                  throw error;
                }
              });
          }
        }
      },
      () => operator?.stopAndWait({ timeoutMs: 2_000 }),
      () => stopQaGatewayFixture(owner),
      () => closeNativeProvider(provider),
      () => closeNativeProvider(forbiddenGatewayProvider),
      () => (published ? closeWireServer(published.server) : undefined),
    );
  },
  PROOF_TIMEOUT_MS + 180_000,
);
