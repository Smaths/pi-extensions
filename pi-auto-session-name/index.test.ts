import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import register, { normalizeTitle } from "./index.ts";

afterEach(() => {
	delete process.env.PI_AUTO_SESSION_NAME_MODEL;
	mock.timers.reset();
});

const LONG_PROMPT = "Please explain the entire authentication subsystem and how it should be redesigned, including how to migrate credentials and deploy it safely across all services in our fleet, plus a comprehensive rollout and recovery plan for the next quarter.";
const LONG_LOCAL_TITLE = normalizeTitle(LONG_PROMPT);

function harness(firstContent: unknown = [{ type: "text", text: "Help me refactor the authentication flow" }]) {
	const handlers = new Map<string, (_event: unknown, ctx: any) => Promise<void> | void>();
	const state = { id: "new", name: "", file: undefined as string | undefined, entries: [] as unknown[], calls: 0, notices: [] as string[] };
	const ctx = {
		hasUI: true,
		ui: { notify: (message: string) => { state.notices.push(message); } },
		sessionManager: {
			getSessionId: () => state.id,
			getSessionFile: () => state.file,
			getEntries: () => state.entries,
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
		getCommands: () => [{ name: "skill:debug", source: "skill" }, { name: "review", source: "prompt" }],
	};
	register(pi as any);
	const emit = async (event: string, reason = "startup") => { await handlers.get(event)?.({ reason }, ctx); };
	// Mirrors Pi: input gets the raw text; before_agent_start gets the expanded prompt.
	const prompt = async (content: unknown = firstContent) => {
		const parts = typeof content === "string" ? [{ type: "text", text: content }] : content as any[];
		const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		await handlers.get("input")?.({ text, source: "interactive" }, ctx);
		await handlers.get("before_agent_start")?.({ prompt: text.startsWith("/") ? `<expanded>${text}</expanded>` : text }, ctx);
	};
	// Naming runs in the background; wait for it to finish.
	const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
	return { ctx, pi, state, emit, prompt, flush };
}

test("local fallback names only the first run", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.prompt(); await h.flush();
	assert.equal(h.state.name, "Refactor authentication flow");
	h.state.name = "";
	await h.prompt("Review authentication flow"); await h.flush();
	assert.equal(h.state.calls, 1);
});

test("naming starts at run start without blocking on the model", async () => {
	const h = harness();
	h.ctx.modelRegistry.hasConfiguredAuth = () => true;
	let resolve!: (value: any) => void;
	h.ctx.modelRegistry.complete = () => new Promise((done) => { resolve = done; });
	await h.emit("session_start");
	await h.prompt();
	assert.equal(h.state.name, "");
	resolve({ stopReason: "stop", content: [{ type: "text", text: "Refactor auth flow" }] });
	await h.flush();
	assert.equal(h.state.name, "Refactor auth flow");
});

test("short prompts are rewritten too", async () => {
	const h = harness();
	h.ctx.modelRegistry.hasConfiguredAuth = () => true;
	await h.emit("session_start"); await h.prompt("Fix auth"); await h.flush();
	assert.equal(h.state.name, "Refactor authentication flow");
});

test("one-word model output falls back to a more descriptive local title", async () => {
	const h = harness();
	h.ctx.modelRegistry.hasConfiguredAuth = () => true;
	h.ctx.modelRegistry.complete = async () => ({ stopReason: "stop", content: [{ type: "text", text: "OK" }] });
	await h.emit("session_start"); await h.prompt("Reply with exactly OK"); await h.flush();
	assert.equal(h.state.name, "Reply exactly OK");
});

test("model rewrite works even if the local fallback is empty", async () => {
	const h = harness();
	h.ctx.modelRegistry.hasConfiguredAuth = () => true;
	await h.emit("session_start"); await h.prompt("https://example.com"); await h.flush();
	assert.equal(h.state.name, "Refactor authentication flow");
});

test("canceled session switch leaves fresh session eligible for its first prompt", async () => {
	const h = harness();
	await h.emit("session_start");
	// Another extension cancels session_before_switch: no shutdown or new start follows.
	await h.emit("session_before_switch", "new");
	await h.prompt(); await h.flush();
	assert.equal(h.state.name, "Refactor authentication flow");
	assert.equal(h.state.calls, 1);
});

test("initial model and thinking metadata do not disqualify a fresh session", async () => {
	const h = harness();
	h.state.entries.push({ type: "model_change" }, { type: "thinking_level_change" });
	await h.emit("session_start"); await h.prompt(); await h.flush();
	assert.equal(h.state.name, "Refactor authentication flow");
});

test("metadata-only existing session file is not eligible", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-auto-name-unit-"));
	try {
		const h = harness();
		h.state.file = join(dir, "existing.jsonl");
		writeFileSync(h.state.file, "{}\n");
		h.state.entries.push({ type: "model_change" }, { type: "thinking_level_change" });
		await h.emit("session_start"); await h.prompt(); await h.flush();
		assert.equal(h.state.calls, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("plain string text prompts are eligible", async () => {
	const h = harness(); await h.emit("session_start"); await h.prompt("Review authentication flow"); await h.flush();
	assert.equal(h.state.name, "Review authentication flow");
});

test("prompts with images are named from their text; image-only prompts are skipped", async () => {
	const h = harness(); await h.emit("session_start");
	await h.prompt([{ type: "text", text: "Fix login timeout" }, { type: "image", data: "x" }]); await h.flush();
	assert.equal(h.state.name, "Fix login timeout");
	const imageOnly = harness(); await imageOnly.emit("session_start");
	await imageOnly.prompt([{ type: "image", data: "x" }]); await imageOnly.flush();
	assert.equal(imageOnly.state.calls, 0);
	// The next text prompt can still name the session.
	await imageOnly.prompt("Review authentication flow"); await imageOnly.flush();
	assert.equal(imageOnly.state.name, "Review authentication flow");
});

test("skill and template prompts are named from their arguments; bare commands wait for the next prompt", async () => {
	const h = harness(); await h.emit("session_start");
	await h.prompt("/skill:debug fix login timeout"); await h.flush();
	assert.equal(h.state.name, "Fix login timeout");
	const template = harness(); await template.emit("session_start");
	await template.prompt("/review authentication flow"); await template.flush();
	assert.equal(template.state.name, "Authentication flow");
	const bare = harness(); await bare.emit("session_start");
	await bare.prompt("/skill:debug"); await bare.flush();
	assert.equal(bare.state.calls, 0);
	await bare.prompt("Review authentication flow"); await bare.flush();
	assert.equal(bare.state.name, "Review authentication flow");
});

test("shutdown while the title is pending aborts it and keeps the local title", async () => {
	const h = harness();
	h.ctx.modelRegistry.hasConfiguredAuth = () => true;
	let resolve!: (value: any) => void;
	let signal!: AbortSignal;
	h.ctx.modelRegistry.complete = (_model: any, _input: any, opts: any) => { signal = opts.signal; return new Promise((done) => { resolve = done; }); };
	await h.emit("session_start"); await h.prompt(LONG_PROMPT);
	await h.emit("session_shutdown");
	assert.equal(signal.aborted, true);
	assert.equal(h.state.name, LONG_LOCAL_TITLE);
	resolve({ stopReason: "stop", content: [{ type: "text", text: "Safer authentication rollout" }] });
	await h.flush();
	assert.equal(h.state.calls, 1);
});

test("shutdown after the title arrived changes nothing", async () => {
	const h = harness();
	h.ctx.modelRegistry.hasConfiguredAuth = () => true;
	await h.emit("session_start"); await h.prompt(); await h.flush();
	await h.emit("session_shutdown");
	assert.equal(h.state.name, "Refactor authentication flow");
	assert.equal(h.state.calls, 1);
});

test("a failure to set the name is reported, not thrown", async () => {
	const h = harness();
	h.pi.setSessionName = () => { throw new Error("disk full"); };
	await h.emit("session_start"); await h.prompt(); await h.flush();
	assert.deepEqual(h.state.notices, ["Could not set session name: disk full"]);
});

test("skip resumed and explicitly named sessions", async () => {
	for (const setup of [
		(h: ReturnType<typeof harness>) => { h.state.entries.push({ type: "message" }); },
		(h: ReturnType<typeof harness>) => { h.state.name = "Manual"; },
	]) {
		const h = harness(); setup(h);
		await h.emit("session_start"); await h.prompt(); await h.flush();
		assert.equal(h.state.calls, 0);
	}
	for (const reason of ["resume", "fork", "reload"]) {
		const h = harness(); await h.emit("session_start", reason); await h.prompt(); await h.flush();
		assert.equal(h.state.calls, 0);
	}
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
	await h.prompt("Please refactor the authentication extension packaging"); await h.flush();
	assert.equal(h.state.name, "Refactor authentication extension");
});

test("every text prompt gets a separate bounded low-effort rewrite, with local fallback", async () => {
	const h = harness(LONG_PROMPT);
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
	await h.emit("session_start"); await h.prompt(); await h.flush();
	assert.equal(h.state.name, "Safer authentication rollout");
	assert.deepEqual(choice, { provider: "openai-codex", id: "gpt-6-luna" });
	assert.equal(options.reasoningEffort, "low");
	assert.equal(options.maxTokens, 24);
	assert.equal(payload.messages[0].content[0].text.length <= 1_200, true);
	assert.match(payload.systemPrompt, /action verb first/);
	assert.match(payload.systemPrompt, /at most three words/);
	const fallback = harness(); fallback.ctx.modelRegistry.hasConfiguredAuth = () => false;
	await fallback.emit("session_start"); await fallback.prompt(LONG_PROMPT); await fallback.flush();
	assert.ok(fallback.state.name);
	const missing = harness(); missing.ctx.modelRegistry.find = () => { throw new Error("catalog unavailable"); };
	await missing.emit("session_start"); await missing.prompt(LONG_PROMPT); await missing.flush();
	assert.ok(missing.state.name);
});

test("model call times out even if provider ignores cancellation", async () => {
	const h = harness();
	h.ctx.modelRegistry.hasConfiguredAuth = () => true;
	h.ctx.modelRegistry.complete = () => new Promise(() => {});
	mock.timers.enable({ apis: ["setTimeout"] });
	await h.emit("session_start");
	await h.prompt(LONG_PROMPT);
	assert.equal(h.state.name, "");
	mock.timers.tick(5_000);
	await h.flush();
	assert.ok(h.state.name);
});

test("late model response cannot overwrite manual name or switched session", async () => {
	for (const change of ["manual", "switch", "stale"]) {
		const h = harness();
		h.ctx.modelRegistry.hasConfiguredAuth = () => true;
		let resolve!: (value: any) => void;
		h.ctx.modelRegistry.complete = () => new Promise((done) => { resolve = done; });
		await h.emit("session_start");
		await h.prompt(LONG_PROMPT);
		if (change === "manual") h.state.name = "Manual";
		else if (change === "switch") { await h.emit("session_before_switch"); await h.emit("session_shutdown"); h.state.id = "other"; await h.emit("session_start", "new"); }
		else {
			// Pi invalidates the old runtime after shutdown; its ctx and pi throw on use.
			await h.emit("session_shutdown");
			const stale = () => { throw new Error("stale ctx"); };
			h.ctx.sessionManager.getSessionId = stale;
			h.pi.getSessionName = stale;
			h.pi.setSessionName = stale;
			h.ctx.ui.notify = stale;
		}
		resolve({ stopReason: "stop", content: [{ type: "text", text: "Safer authentication rollout" }] });
		await h.flush();
		// Shutdown already applied the local title; the late result changes nothing.
		assert.equal(h.state.calls, change === "manual" ? 0 : 1);
		assert.equal(h.state.name, change === "manual" ? "Manual" : LONG_LOCAL_TITLE);
	}
});
