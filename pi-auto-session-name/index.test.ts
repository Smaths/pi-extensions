import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import register, { normalizeTitle } from "./index.ts";

afterEach(() => {
	delete process.env.PI_AUTO_SESSION_NAME_MODEL;
});

function harness(firstContent: unknown = [{ type: "text", text: "Help me refactor the authentication flow" }]) {
	const handlers = new Map<string, (_event: unknown, ctx: any) => Promise<void> | void>();
	const state = { id: "new", name: "", file: undefined as string | undefined, entries: [] as unknown[], branch: [] as unknown[], calls: 0 };
	const ctx = {
		sessionManager: {
			getSessionId: () => state.id,
			getSessionFile: () => state.file,
			getEntries: () => state.entries,
			getBranch: () => state.branch,
		},
		modelRegistry: {
			find: () => ({ id: "gpt-6-luna" }),
			hasConfiguredAuth: () => false,
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

test("local fallback names only the first settled run", async () => {
	const h = harness();
	await h.emit("session_start");
	h.prompt();
	assert.equal(h.state.name, "");
	await h.emit("agent_settled");
	assert.equal(h.state.name, "Refactor authentication flow");
	await h.emit("agent_settled");
	assert.equal(h.state.calls, 1);
});

test("short prompts are rewritten too", async () => {
	const h = harness();
	h.ctx.modelRegistry.hasConfiguredAuth = () => true;
	h.prompt("Fix auth");
	await h.emit("session_start"); await h.emit("agent_settled");
	assert.equal(h.state.name, "Refactor authentication flow");
});

test("one-word model output falls back to a more descriptive local title", async () => {
	const h = harness();
	h.ctx.modelRegistry.hasConfiguredAuth = () => true;
	h.ctx.modelRegistry.complete = async () => ({ stopReason: "stop", content: [{ type: "text", text: "OK" }] });
	await h.emit("session_start"); h.prompt("Reply with exactly OK"); await h.emit("agent_settled");
	assert.equal(h.state.name, "Reply exactly OK");
});

test("model rewrite works even if the local fallback is empty", async () => {
	const h = harness();
	h.ctx.modelRegistry.hasConfiguredAuth = () => true;
	await h.emit("session_start"); h.prompt("https://example.com"); await h.emit("agent_settled");
	assert.equal(h.state.name, "Refactor authentication flow");
});

test("canceled session switch leaves fresh session eligible for its first prompt", async () => {
	const h = harness();
	await h.emit("session_start");
	// Another extension cancels session_before_switch: no shutdown or new start follows.
	await h.emit("session_before_switch", "new");
	h.prompt();
	await h.emit("agent_settled");
	assert.equal(h.state.name, "Refactor authentication flow");
	assert.equal(h.state.calls, 1);
});

test("initial model and thinking metadata do not disqualify a fresh session", async () => {
	const h = harness();
	h.state.entries.push({ type: "model_change" }, { type: "thinking_level_change" });
	await h.emit("session_start"); h.prompt(); await h.emit("agent_settled");
	assert.equal(h.state.name, "Refactor authentication flow");
});

test("metadata-only existing session file is not eligible", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-auto-name-unit-"));
	try {
		const h = harness();
		h.state.file = join(dir, "existing.jsonl");
		writeFileSync(h.state.file, "{}\n");
		h.state.entries.push({ type: "model_change" }, { type: "thinking_level_change" });
		await h.emit("session_start"); h.prompt(); await h.emit("agent_settled");
		assert.equal(h.state.calls, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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
	assert.equal(title, "Inspect email");
	assert.ok(title.length <= 40);
	assert.ok(title.split(" ").length <= 3);
	assert.equal(normalizeTitle("1234 https://example.com"), "");
});

test("titles are action-first and limited to three words", () => {
	const prompt = "Please refactor all of the authentication extensions in this repo and describe a better way to package them";
	const title = normalizeTitle(prompt);
	assert.equal(title, "Refactor authentication extensions");
	assert.ok(title.split(" ").length <= 3);
});

test("model rewrites are normalized to three words", async () => {
	const h = harness();
	h.ctx.modelRegistry.hasConfiguredAuth = () => true;
	h.ctx.modelRegistry.complete = async () => ({ stopReason: "stop", content: [{ type: "text", text: "Refactor authentication extension packaging" }] });
	await h.emit("session_start");
	h.prompt("Please refactor the authentication extension packaging");
	await h.emit("agent_settled");
	assert.equal(h.state.name, "Refactor authentication extension");
});

test("every text prompt gets a separate bounded low-effort rewrite, with local fallback", async () => {
	const h = harness([{ type: "text", text: "Please explain the entire authentication subsystem and how it should be redesigned, including how to migrate credentials and deploy it safely across all services in our fleet, plus a comprehensive rollout and recovery plan for the next quarter." }]);
	let options: any;
	let payload: any;
	let choice: any;
	h.ctx.modelRegistry.hasConfiguredAuth = () => true;
	h.ctx.modelRegistry.find = (provider: string, id: string) => {
		choice = { provider, id };
		return { id };
	};
	h.ctx.modelRegistry.complete = async (_model: any, input: any, opts: any) => {
		payload = input; options = opts;
		return { stopReason: "stop", content: [{ type: "text", text: "Safer authentication rollout" }] };
	};
	await h.emit("session_start"); h.prompt(); await h.emit("agent_settled");
	assert.equal(h.state.name, "Safer authentication rollout");
	assert.deepEqual(choice, { provider: "openai-codex", id: "gpt-6-luna" });
	assert.equal(options.reasoningEffort, "low");
	assert.equal(options.maxTokens, 24);
	assert.equal(payload.messages[0].content[0].text.length <= 1_200, true);
	assert.match(payload.systemPrompt, /action verb first/);
	assert.match(payload.systemPrompt, /at most three words/);
	const fallback = harness(); fallback.ctx.modelRegistry.hasConfiguredAuth = () => false;
	await fallback.emit("session_start"); fallback.prompt([{ type: "text", text: "Please explain the entire authentication subsystem and how it should be redesigned, including how to migrate credentials and deploy it safely across all services in our fleet, plus a comprehensive rollout and recovery plan for the next quarter." }]);
	await fallback.emit("agent_settled");
	assert.ok(fallback.state.name);
	const missing = harness(); missing.ctx.modelRegistry.find = () => { throw new Error("catalog unavailable"); };
	await missing.emit("session_start"); missing.prompt([{ type: "text", text: "Please explain the entire authentication subsystem and how it should be redesigned, including how to migrate credentials and deploy it safely across all services in our fleet, plus a comprehensive rollout and recovery plan for the next quarter." }]);
	await missing.emit("agent_settled");
	assert.ok(missing.state.name);
});

test("model call times out even if provider ignores cancellation", async () => {
	const h = harness();
	h.ctx.modelRegistry.hasConfiguredAuth = () => true;
	h.ctx.modelRegistry.complete = () => new Promise(() => {});
	await h.emit("session_start");
	h.prompt([{ type: "text", text: "Please explain the entire authentication subsystem and how it should be redesigned, including how to migrate credentials and deploy it safely across all services in our fleet, plus a comprehensive rollout and recovery plan for the next quarter." }]);
	await h.emit("agent_settled");
	assert.ok(h.state.name);
});

test("late model response cannot overwrite manual name or switched session", async () => {
	for (const change of ["manual", "switch"]) {
		const h = harness();
		h.ctx.modelRegistry.hasConfiguredAuth = () => true;
		let resolve!: (value: any) => void;
		h.ctx.modelRegistry.complete = () => new Promise((done) => { resolve = done; });
		await h.emit("session_start");
		h.prompt([{ type: "text", text: "Please explain the entire authentication subsystem and how it should be redesigned, including how to migrate credentials and deploy it safely across all services in our fleet, plus a comprehensive rollout and recovery plan for the next quarter." }]);
		const pending = h.emit("agent_settled");
		if (change === "manual") h.state.name = "Manual";
		else { await h.emit("session_before_switch"); await h.emit("session_shutdown"); h.state.id = "other"; await h.emit("session_start", "new"); }
		resolve({ stopReason: "stop", content: [{ type: "text", text: "Safer authentication rollout" }] });
		await pending;
		assert.equal(h.state.calls, 0);
	}
});
