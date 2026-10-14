import assert from "node:assert/strict";
import { test } from "node:test";
import register, { formatContextGauge, STATUS_KEY } from "./index.ts";

test("fills the four-cell gauge continuously at quarter boundaries", () => {
	assert.equal(formatContextGauge(0), "░░░░");
	assert.equal(formatContextGauge(12.5), "▌░░░");
	assert.equal(formatContextGauge(24.9), "▉░░░");
	assert.equal(formatContextGauge(25), "█░░░");
	assert.equal(formatContextGauge(50), "██░░");
	assert.equal(formatContextGauge(75), "███░");
	assert.equal(formatContextGauge(100), "████");
	assert.equal(formatContextGauge(-10), "░░░░");
	assert.equal(formatContextGauge(120), "████");
	assert.equal(formatContextGauge(Number.NaN), "░░░░");
	assert.equal(formatContextGauge(Number.POSITIVE_INFINITY), "░░░░");
});

test("publishes a color-independent warning and clears it after compaction", () => {
	const handlers = new Map<string, (event: unknown, ctx: any) => void>();
	const statuses: Array<[string, string | undefined]> = [];
	let percent: number | null = 12.5;
	const ctx = {
		mode: "tui",
		getContextUsage: () => ({ percent }),
		ui: {
			setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
		},
	};
	register({ on: (event: string, handler: (event: unknown, ctx: any) => void) => handlers.set(event, handler) } as any);

	handlers.get("session_start")?.({}, ctx);
	assert.deepEqual(statuses.at(-1), [STATUS_KEY, "▌░░░"]);

	percent = 25;
	handlers.get("message_end")?.({}, ctx);
	assert.deepEqual(statuses.at(-1), [STATUS_KEY, "!█░░░"]);

	percent = null;
	handlers.get("session_compact")?.({}, ctx);
	assert.deepEqual(statuses.at(-1), [STATUS_KEY, undefined]);
});

test("does not republish an unchanged gauge", () => {
	const handlers = new Map<string, (event: unknown, ctx: any) => void>();
	const statuses: Array<[string, string | undefined]> = [];
	const ctx = {
		mode: "tui",
		getContextUsage: () => ({ percent: 30 }),
		ui: {
			setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
		},
	};
	register({ on: (event: string, handler: (event: unknown, ctx: any) => void) => handlers.set(event, handler) } as any);

	handlers.get("session_start")?.({}, ctx);
	handlers.get("message_end")?.({}, ctx);
	handlers.get("agent_settled")?.({}, ctx);
	assert.deepEqual(statuses, [[STATUS_KEY, "!█▏░░"]]);

	handlers.get("session_shutdown")?.({}, ctx);
	handlers.get("session_start")?.({}, ctx);
	assert.deepEqual(statuses.slice(-2), [
		[STATUS_KEY, undefined],
		[STATUS_KEY, "!█▏░░"],
	]);
});

test("clears unknown and non-finite context usage", () => {
	const handlers = new Map<string, (event: unknown, ctx: any) => void>();
	const statuses: Array<[string, string | undefined]> = [];
	let percent: number | null | undefined = 25;
	const ctx = {
		mode: "tui",
		getContextUsage: () => percent === undefined ? undefined : ({ percent }),
		ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) },
	};
	register({ on: (event: string, handler: (event: unknown, ctx: any) => void) => handlers.set(event, handler) } as any);
	for (const invalid of [null, undefined, NaN, Infinity, -Infinity]) {
		percent = 25;
		handlers.get("message_end")?.({}, ctx);
		assert.deepEqual(statuses.at(-1), [STATUS_KEY, "!█░░░"]);
		percent = invalid;
		handlers.get("message_end")?.({}, ctx);
		assert.deepEqual(statuses.at(-1), [STATUS_KEY, undefined]);
	}
});

test("updates at the warning boundary and republishes for a new session", () => {
	const handlers = new Map<string, (event: unknown, ctx: any) => void>();
	const statuses: Array<[string, string | undefined]> = [];
	let percent = 24.9;
	const ctx = {
		mode: "tui",
		getContextUsage: () => ({ percent }),
		ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) },
	};
	register({ on: (event: string, handler: (event: unknown, ctx: any) => void) => handlers.set(event, handler) } as any);
	handlers.get("session_start")?.({}, ctx);
	percent = 25;
	handlers.get("model_select")?.({}, ctx);
	percent = 24.9;
	handlers.get("session_tree")?.({}, ctx);
	handlers.get("session_start")?.({}, ctx);
	assert.deepEqual(statuses, [
		[STATUS_KEY, "▉░░░"],
		[STATUS_KEY, "!█░░░"],
		[STATUS_KEY, "▉░░░"],
		[STATUS_KEY, "▉░░░"],
	]);
});

test("does not publish terminal status outside TUI mode", () => {
	const handlers = new Map<string, (event: unknown, ctx: any) => void>();
	let calls = 0;
	const ctx = {
		mode: "rpc",
		getContextUsage: () => ({ percent: 30 }),
		ui: { setStatus: () => calls++ },
	};
	register({ on: (event: string, handler: (event: unknown, ctx: any) => void) => handlers.set(event, handler) } as any);
	for (const mode of ["rpc", "json", "print"]) {
		ctx.mode = mode;
		for (const handler of handlers.values()) handler({}, ctx);
	}
	assert.equal(calls, 0);
});
