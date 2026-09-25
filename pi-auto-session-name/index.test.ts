import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import register, { normalizeTitle } from "./index.ts";

afterEach(() => {
	delete process.env.PI_AUTO_SESSION_NAME_MODE;
	delete process.env.PI_AUTO_SESSION_NAME_MODEL;
});

function harness(firstContent: unknown = [{ type: "text", text: "Help me refactor the authentication flow" }]) {
	const handlers = new Map<string, (_event: unknown, ctx: any) => Promise<void> | void>();
	const state = { id: "new", name: "", entries: [] as unknown[], branch: [] as unknown[], calls: 0 };
	const ctx = {
		sessionManager: {
			getSessionId: () => state.id,
			getEntries: () => state.entries,
			getBranch: () => state.branch,
		},
		modelRegistry: {
			find: () => ({ id: "gpt-6-luna" }),
			hasConfiguredAuth: () => true,
			complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Refactor authentication flow" }] }),
		},
	};
	const pi = {
		on: (event: string, handler: (_event: unknown, ctx: typeof ctx) => Promise<void> | void) => handlers.set(event, handler),
		getSessionName: () => state.name,
		setSessionName: (name: string) => { state.calls++; state.name = name; },
	};
	register(pi as any);
	const emit = async (event: string, reason = "startup") => { await handlers.get(event)?.({ reason }, ctx); };
	const prompt = (content: unknown = firstContent) => { state.branch.push({ type: "message", message: { role: "user", content } }); };
	return { ctx, state, emit, prompt };
}

test("local naming only on first settled run", async () => {
	const h = harness();
	await h.emit("session_start");
	h.prompt();
	assert.equal(h.state.name, "");
	await h.emit("agent_settled");
	assert.equal(h.state.name, "Help refactor authentication flow");
	await h.emit("agent_settled");
	assert.equal(h.state.calls, 1);
});

test("plain string text prompts are eligible", async () => {
	const h = harness(); await h.emit("session_start"); h.prompt("Review authentication flow"); await h.emit("agent_settled");
	assert.equal(h.state.name, "Review authentication flow");
});

test("skip resumed, explicitly named, non-text, and queued second prompts", async () => {
	for (const setup of [
		(h: ReturnType<typeof harness>) => { h.state.entries.push({ type: "message" }); },
		(h: ReturnType<typeof harness>) => { h.state.name = "Manual"; },
	]) {
		const h = harness(); setup(h);
		await h.emit("session_start"); h.prompt(); await h.emit("agent_settled");
		assert.equal(h.state.calls, 0);
	}
	for (const reason of ["resume", "fork", "reload"]) {
		const h = harness(); await h.emit("session_start", reason); h.prompt(); await h.emit("agent_settled");
		assert.equal(h.state.calls, 0);
	}
	for (const content of [[{ type: "image", data: "x" }], [{ type: "text", text: "Fix issue" }, { type: "image", data: "x" }]]) {
		const h = harness(); await h.emit("session_start"); h.prompt(content); await h.emit("agent_settled");
		assert.equal(h.state.calls, 0);
	}
	const h = harness(); await h.emit("session_start"); h.prompt(); h.prompt(); await h.emit("agent_settled");
	assert.equal(h.state.calls, 0);
});

test("normalization bounds output and excludes paths, addresses, code, and newlines", () => {
	const title = normalizeTitle("Please inspect /home/me/private and email jane@example.com\n```secret``` then improve cache invalidation for app");
	assert.equal(title, "Inspect email then improve cache");
	assert.ok(title.length <= 40);
	assert.equal(normalizeTitle("1234 https://example.com"), "");
});

test("hybrid uses separate bounded low-effort call, falls back without auth", async () => {
	process.env.PI_AUTO_SESSION_NAME_MODE = "hybrid";
	const h = harness([{ type: "text", text: "Please explain the entire authentication subsystem and how it should be redesigned, including how to migrate credentials and deploy it safely across all services in our fleet, plus a comprehensive rollout and recovery plan for the next quarter." }]);
	let options: any;
	let payload: any;
	h.ctx.modelRegistry.complete = async (_model: any, input: any, opts: any) => {
		payload = input; options = opts;
		return { stopReason: "stop", content: [{ type: "text", text: "Safer authentication rollout" }] };
	};
	await h.emit("session_start"); h.prompt(); await h.emit("agent_settled");
	assert.equal(h.state.name, "Safer authentication rollout");
	assert.equal(options.reasoningEffort, "low");
	assert.equal(options.maxTokens, 64);
	assert.equal(payload.messages[0].content[0].text.length <= 1_200, true);
	const fallback = harness(); fallback.ctx.modelRegistry.hasConfiguredAuth = () => false;
	await fallback.emit("session_start"); fallback.prompt([{ type: "text", text: "Please explain the entire authentication subsystem and how it should be redesigned, including how to migrate credentials and deploy it safely across all services in our fleet, plus a comprehensive rollout and recovery plan for the next quarter." }]);
	await fallback.emit("agent_settled");
	assert.ok(fallback.state.name);
	const missing = harness(); missing.ctx.modelRegistry.find = () => { throw new Error("catalog unavailable"); };
	await missing.emit("session_start"); missing.prompt([{ type: "text", text: "Please explain the entire authentication subsystem and how it should be redesigned, including how to migrate credentials and deploy it safely across all services in our fleet, plus a comprehensive rollout and recovery plan for the next quarter." }]);
	await missing.emit("agent_settled");
	assert.ok(missing.state.name);
});

test("hybrid call times out even if provider ignores cancellation", async () => {
	process.env.PI_AUTO_SESSION_NAME_MODE = "hybrid";
	const h = harness();
	h.ctx.modelRegistry.complete = () => new Promise(() => {});
	await h.emit("session_start");
	h.prompt([{ type: "text", text: "Please explain the entire authentication subsystem and how it should be redesigned, including how to migrate credentials and deploy it safely across all services in our fleet, plus a comprehensive rollout and recovery plan for the next quarter." }]);
	await h.emit("agent_settled");
	assert.ok(h.state.name);
});

test("late model response cannot overwrite manual name or switched session", async () => {
	process.env.PI_AUTO_SESSION_NAME_MODE = "hybrid";
	for (const change of ["manual", "switch"]) {
		const h = harness();
		let resolve!: (value: any) => void;
		h.ctx.modelRegistry.complete = () => new Promise((done) => { resolve = done; });
		await h.emit("session_start");
		h.prompt([{ type: "text", text: "Please explain the entire authentication subsystem and how it should be redesigned, including how to migrate credentials and deploy it safely across all services in our fleet, plus a comprehensive rollout and recovery plan for the next quarter." }]);
		const pending = h.emit("agent_settled");
		if (change === "manual") h.state.name = "Manual";
		else { await h.emit("session_before_switch"); h.state.id = "other"; await h.emit("session_start", "new"); }
		resolve({ stopReason: "stop", content: [{ type: "text", text: "Safer authentication rollout" }] });
		await pending;
		assert.equal(h.state.calls, 0);
	}
});
