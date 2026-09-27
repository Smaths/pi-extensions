import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import register from "./index.ts";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const key of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"]) delete process.env[key];
});

async function harness(options: { mode?: string; dropConnections?: number; reject?: number } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-runtime-metadata-"));
	const socketPath = join(dir, "herdr.sock");
	const requests: any[] = [];
	let dropConnections = options.dropConnections ?? 0;
	let reject = options.reject ?? 0;
	const server = net.createServer((socket) => {
		if (dropConnections > 0) {
			dropConnections -= 1;
			socket.destroy();
			return;
		}
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const request = JSON.parse(buffer.slice(0, newline));
			requests.push(request);
			const reply = reject > 0 ? { id: request.id, error: { message: "rejected" } } : { id: request.id, result: { type: "ok" } };
			if (reject > 0) reject -= 1;
			socket.end(`${JSON.stringify(reply)}\n`);
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())), () => rmSync(dir, { recursive: true, force: true }));

	Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "w1:p1" });
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const state = { thinking: "high" };
	const ctx = { mode: options.mode ?? "tui", model: { id: "gpt-6-luna" } as { id: string } | undefined };
	const pi = {
		on: (event: string, handler: (event: any, ctx: any) => unknown) => handlers.set(event, handler),
		getThinkingLevel: () => state.thinking,
	};
	register(pi as any);
	const emit = (event: string) => handlers.get(event)?.({ type: event }, ctx);

	const reported = async (count: number, timeoutMs = 2_000) => {
		const deadline = Date.now() + timeoutMs;
		while (requests.length < count) {
			assert.ok(Date.now() < deadline, `expected ${count} requests, got ${requests.length}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
		return requests.map(({ params }) => {
			const { pane_id, source, agent, seq, ...rest } = params;
			assert.deepEqual({ pane_id, source, agent }, { pane_id: "w1:p1", source: "user:pi-runtime-metadata", agent: "pi" });
			assert.equal(typeof seq, "number");
			return rest;
		});
	};
	return { ctx, state, emit, reported, requests };
}

const tokens = (model: string, thinking: string) => ({ tokens: { pi_model: model, pi_thinking: thinking }, ttl_ms: 86_400_000 });
const clearReport = { clear_tokens: ["pi_model", "pi_thinking"] };

test("session start publishes the model and thinking level, then only changes", async () => {
	const h = await harness();
	h.emit("session_start");
	h.emit("model_select");
	h.state.thinking = "low";
	h.emit("thinking_level_select");
	h.emit("thinking_level_select");
	assert.deepEqual(await h.reported(2), [tokens("gpt-6-luna", "H"), tokens("gpt-6-luna", "L")]);
});

test("failed reports are retried after the retry interval", async () => {
	// Drop both attempts of the first report.
	const h = await harness({ dropConnections: 2 });
	h.emit("session_start");
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(h.requests.length, 0);
	assert.deepEqual(await h.reported(1, 7_000), [tokens("gpt-6-luna", "H")]);
});

test("rejected reports are retried", async () => {
	const h = await harness({ reject: 1 });
	h.emit("session_start");
	assert.deepEqual(await h.reported(2, 7_000), [tokens("gpt-6-luna", "H"), tokens("gpt-6-luna", "H")]);
});

test("shutdown waits until the clear is delivered and ignores later events", async () => {
	const h = await harness();
	h.emit("session_start");
	await h.emit("session_shutdown");
	assert.deepEqual(h.requests.at(-1)?.params.clear_tokens, clearReport.clear_tokens);
	h.emit("model_select");
	assert.deepEqual(await h.reported(2), [tokens("gpt-6-luna", "H"), clearReport]);
});

test("non-TUI sessions report nothing", async () => {
	const h = await harness({ mode: "rpc" });
	h.emit("session_start");
	h.emit("model_select");
	await h.emit("session_shutdown");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(h.requests.length, 0);
});
