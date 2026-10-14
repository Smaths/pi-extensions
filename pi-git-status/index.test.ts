import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import register, { formatGitState, parseGitStatus, STATUS_KEY } from "./index.ts";

const CLEAN = "# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n";
const result = (stdout = CLEAN, code = 0, killed = false) => ({ stdout, stderr: "", code, killed });
type Result = ReturnType<typeof result>;

function setup(t: TestContext, exec: (...args: any[]) => Promise<Result> = async () => result(), mode = "tui") {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const handlers = new Map<string, (event: unknown, ctx: any) => void>();
	const statuses: Array<[string, string | undefined]> = [];
	const calls: any[][] = [];
	const ctx = {
		mode,
		cwd: "/repo",
		// Deliberately no setFooter, theme, or session data APIs.
		ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) },
	};
	register({
		on: (event: string, handler: (event: unknown, ctx: any) => void) => handlers.set(event, handler),
		exec: (...args: any[]) => {
			calls.push(args);
			return exec(...args);
		},
	} as any);
	const emit = (event: string) => handlers.get(event)?.({}, ctx);
	t.after(() => emit("session_shutdown"));
	return { emit, ctx, statuses, calls };
}

test("formats clean, diverged, dirty, conflicted, and non-repository states", () => {
	assert.equal(formatGitState(parseGitStatus(CLEAN)), "✓");
	assert.equal(formatGitState(parseGitStatus(CLEAN.replace("+0 -0", "+2 -3"))), "↑2 ↓3");
	const status = parseGitStatus(`${CLEAN}1 M. staged\n1 .M unstaged\n2 RM renamed\n? untracked\nu UU conflict\n`);
	assert.equal(formatGitState(status), "+2 !2 ?1 ⚠1");
	assert.equal(formatGitState({ ...status, isRepo: false }), undefined);
	assert.equal(formatGitState(parseGitStatus("# branch.head main\n")), "no-upstream");
	assert.equal(formatGitState(parseGitStatus("# branch.head (detached)\n")), "✓");
});

test("publishes plain native status once per change, then clears on shutdown", async (t) => {
	let output = CLEAN;
	const h = setup(t, async () => result(output));
	h.emit("session_start");
	await setImmediate();
	assert.deepEqual(h.calls[0], [
		"git",
		["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
		{ cwd: "/repo", timeout: 2_000 },
	]);
	assert.deepEqual(h.statuses, [[STATUS_KEY, "✓"]]);
	h.emit("turn_end");
	await setImmediate();
	assert.equal(h.statuses.length, 1);
	output += "? new-file\n";
	h.emit("agent_settled");
	await setImmediate();
	assert.deepEqual(h.statuses.at(-1), [STATUS_KEY, "?1"]);
	h.emit("session_shutdown");
	h.emit("session_shutdown");
	assert.deepEqual(h.statuses.slice(-2), [[STATUS_KEY, "?1"], [STATUS_KEY, undefined]]);
	const calls = h.calls.length;
	t.mock.timers.tick(60_000);
	await setImmediate();
	assert.equal(h.calls.length, calls);
});

test("clears stale status on non-repository, timeout, and execution failures", async (t) => {
	let response: Result | Error = result();
	const h = setup(t, async () => {
		if (response instanceof Error) throw response;
		return response;
	});
	h.emit("session_start");
	await setImmediate();
	for (const failure of [result("", 128), result(CLEAN, 0, true), new Error("git unavailable")]) {
		response = failure;
		h.emit("turn_end");
		await setImmediate();
		assert.deepEqual(h.statuses.at(-1), [STATUS_KEY, undefined]);
		response = result();
		h.emit("turn_end");
		await setImmediate();
		assert.deepEqual(h.statuses.at(-1), [STATUS_KEY, "✓"]);
	}
});

test("polls repositories every 10 seconds and non-repositories every 60 seconds", async (t) => {
	let response = result();
	const h = setup(t, async () => response);
	h.emit("session_start");
	await setImmediate();
	t.mock.timers.tick(9_999);
	assert.equal(h.calls.length, 1);
	t.mock.timers.tick(1);
	await setImmediate();
	assert.equal(h.calls.length, 2);
	response = result("", 128);
	h.emit("turn_end");
	await setImmediate();
	t.mock.timers.tick(59_999);
	assert.equal(h.calls.length, 3);
	t.mock.timers.tick(1);
	await setImmediate();
	assert.equal(h.calls.length, 4);
});

test("coalesces refresh bursts into one follow-up execution", async (t) => {
	const pending: Array<(value: Result) => void> = [];
	const h = setup(t, () => new Promise((resolve) => pending.push(resolve)));
	h.emit("session_start");
	h.emit("turn_end");
	h.emit("agent_settled");
	h.emit("turn_end");
	assert.equal(h.calls.length, 1);
	pending.shift()!(result());
	await setImmediate();
	assert.equal(h.calls.length, 2);
	pending.shift()!(result());
	await setImmediate();
	assert.equal(h.calls.length, 2);
	assert.deepEqual(h.statuses, [[STATUS_KEY, "✓"]]);
});

test("ignores in-flight results after shutdown", async (t) => {
	let resolve!: (value: Result) => void;
	const h = setup(t, () => new Promise((done) => { resolve = done; }));
	h.emit("session_start");
	h.emit("turn_end");
	h.emit("session_shutdown");
	resolve(result());
	await setImmediate();
	t.mock.timers.tick(60_000);
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.statuses, [[STATUS_KEY, undefined]]);
});

test("discards old-session results and refreshes using the new session context", async (t) => {
	const pending: Array<(value: Result) => void> = [];
	const h = setup(t, () => new Promise((resolve) => pending.push(resolve)));
	h.emit("session_start");
	h.emit("session_shutdown");
	h.ctx.cwd = "/new-repo";
	h.emit("session_start");
	pending.shift()!(result(`${CLEAN}? stale\n`));
	await setImmediate();
	assert.equal(h.calls.length, 2);
	assert.equal(h.calls[1][2].cwd, "/new-repo");
	assert.deepEqual(h.statuses, [[STATUS_KEY, undefined]]);
	pending.shift()!(result());
	await setImmediate();
	assert.deepEqual(h.statuses.at(-1), [STATUS_KEY, "✓"]);
});

test("republishes unchanged state for a new session", async (t) => {
	const h = setup(t);
	h.emit("session_start");
	await setImmediate();
	h.emit("session_start");
	await setImmediate();
	assert.deepEqual(h.statuses, [[STATUS_KEY, "✓"], [STATUS_KEY, undefined], [STATUS_KEY, "✓"]]);
});

for (const mode of ["rpc", "json", "print"]) {
	test(`does not execute Git or publish status in ${mode} mode`, async (t) => {
		const h = setup(t, undefined, mode);
		h.emit("session_start");
		h.emit("turn_end");
		h.emit("agent_settled");
		h.emit("session_shutdown");
		t.mock.timers.tick(60_000);
		assert.deepEqual(h.calls, []);
		assert.deepEqual(h.statuses, []);
	});
}
