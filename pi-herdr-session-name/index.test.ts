import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import register, { sanitizeSessionName } from "./index.ts";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const key of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "PI_HERDR_SESSION_NAME_TITLE"]) delete process.env[key];
});

async function harness(options: { mode?: string; env?: Record<string, string>; dropConnections?: number } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-session-name-"));
	const socketPath = join(dir, "herdr.sock");
	const requests: any[] = [];
	const waiters: (() => void)[] = [];
	let dropConnections = options.dropConnections ?? 0;
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
			socket.end(`${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`);
			for (const waiter of waiters.splice(0)) waiter();
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())), () => rmSync(dir, { recursive: true, force: true }));

	Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "w1:p1" }, options.env);
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const state = { name: "" as string | undefined };
	const pi = {
		on: (event: string, handler: (event: any, ctx: any) => void) => handlers.set(event, handler),
		getSessionName: () => state.name,
	};
	register(pi as any);
	const ctx = { mode: options.mode ?? "tui" };
	const emit = (event: string, payload: Record<string, unknown> = {}) => handlers.get(event)?.({ type: event, ...payload }, ctx);
	// Mirror Pi's setSessionName(): update the stored name, then emit the change event.
	const rename = (name: string | undefined) => {
		state.name = name;
		emit("session_info_changed", { name });
	};

	// Wait until `count` requests have arrived, then return their params without per-request ids.
	const reported = async (count: number, timeoutMs = 2_000) => {
		const deadline = Date.now() + timeoutMs;
		while (requests.length < count) {
			assert.ok(Date.now() < deadline, `expected ${count} requests, got ${requests.length}`);
			await new Promise<void>((resolve) => {
				waiters.push(resolve);
				setTimeout(resolve, 50);
			});
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
		return requests.map(({ method, params }) => {
			assert.equal(method, "pane.report_metadata");
			const { seq, ...rest } = params;
			assert.equal(typeof seq, "number");
			return rest;
		});
	};
	return { state, emit, rename, reported, requests };
}

const base = { pane_id: "w1:p1", source: "user:pi-session-name", agent: "pi" };
const clearReport = { ...base, clear_title: true, tokens: { pi_session_name: null } };
const nameReports = (name: string) => [
	{ ...base, title: name },
	{ ...base, tokens: { pi_session_name: name }, ttl_ms: 86_400_000 },
];

test("session start clears stale metadata and publishes an existing name", async () => {
	const h = await harness();
	h.state.name = "Refactor\tauth  flow";
	h.emit("session_start", { reason: "resume" });
	assert.deepEqual(await h.reported(3), [clearReport, ...nameReports("Refactor auth flow")]);
});

test("unnamed session start sends only the clear", async () => {
	const h = await harness();
	h.emit("session_start");
	h.emit("agent_settled");
	assert.deepEqual(await h.reported(1), [clearReport]);
});

test("name changes publish the title and token without polling", async () => {
	const h = await harness();
	h.emit("session_start");
	h.rename("Refactor auth");
	h.rename("Refactor auth");
	h.rename("Review auth");
	assert.deepEqual(await h.reported(5), [clearReport, ...nameReports("Refactor auth"), ...nameReports("Review auth")]);
	const seqs = h.requests.map((request) => request.params.seq);
	assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test("agent_settled picks up names on Pi versions without the event", async () => {
	const h = await harness();
	h.emit("session_start");
	h.state.name = "Refactor auth";
	h.emit("agent_settled");
	assert.deepEqual(await h.reported(3), [clearReport, ...nameReports("Refactor auth")]);
});

test("clearing the name clears the title and token", async () => {
	const h = await harness();
	h.emit("session_start");
	h.rename("Refactor auth");
	h.rename(undefined);
	assert.deepEqual(await h.reported(4), [clearReport, ...nameReports("Refactor auth"), clearReport]);
});

test("shutdown clears the title and token and ignores later events", async () => {
	const h = await harness();
	h.emit("session_start");
	h.rename("Refactor auth");
	h.emit("session_shutdown");
	h.rename("Late name");
	assert.deepEqual(await h.reported(4), [clearReport, ...nameReports("Refactor auth"), clearReport]);
});

test("failed reports are retried after the retry interval", async () => {
	// Drop both attempts of the clear and of the title report; the token report still lands.
	const h = await harness({ dropConnections: 4 });
	h.emit("session_start");
	h.rename("Refactor auth");
	h.emit("agent_settled");
	assert.deepEqual(await h.reported(1), [nameReports("Refactor auth")[1]]);
	assert.deepEqual(await h.reported(3, 7_000), [nameReports("Refactor auth")[1], ...nameReports("Refactor auth")]);
});

test("title publishing can be disabled", async () => {
	const h = await harness({ env: { PI_HERDR_SESSION_NAME_TITLE: "0" } });
	h.emit("session_start");
	h.rename("Refactor auth");
	assert.deepEqual(await h.reported(2), [clearReport, nameReports("Refactor auth")[1]]);
});

test("non-TUI sessions report nothing", async () => {
	const h = await harness({ mode: "rpc" });
	h.emit("session_start");
	h.rename("Refactor auth");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(h.requests.length, 0);
});

test("session names are flattened to one line", () => {
	assert.equal(sanitizeSessionName(" Fix\r\nauth\t flow "), "Fix auth flow");
	assert.equal(sanitizeSessionName(undefined), "");
});
