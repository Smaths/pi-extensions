/**
 * Publish Pi's active model and thinking level as display-only Herdr metadata.
 *
 * This intentionally lives beside, rather than inside, Herdr's managed Pi
 * integration. The managed integration remains the authority for agent state.
 */
import net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SOURCE = "user:pi-runtime-metadata";
const MAX_TTL_MS = 86_400_000;
// Re-send before the TTL lapses so long-lived panes keep their metadata.
const REFRESH_INTERVAL_MS = MAX_TTL_MS / 2;
const RETRY_INTERVAL_MS = 5_000;
const MAX_RETRY_INTERVAL_MS = 300_000;
const ATTEMPT_TIMEOUTS_MS = [500, 1_500];
// Keep exit fast when Herdr is gone.
const SHUTDOWN_ATTEMPT_TIMEOUTS_MS = [500];

// A distinct one-character code for every Pi thinking level.
const THINKING_CODES: Record<string, string> = {
	off: "O",
	minimal: "N",
	low: "L",
	medium: "M",
	high: "H",
	xhigh: "X",
	max: "Z",
};

type Snapshot = { model: string; thinking: string };
type Delivery = "delivered" | "rejected" | "failed";

function replyStatus(line: string): Delivery {
	try {
		const reply = JSON.parse(line);
		return reply?.error ? "rejected" : "delivered";
	} catch {
		// Herdr answered, even if in an unexpected format; do not retry.
		return "delivered";
	}
}

function sendRequestAttempt(endpoint: string, request: unknown, timeoutMs: number): Promise<Delivery> {
	return new Promise((resolve) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let socket: net.Socket;
		let buffer = "";
		const finish = (delivery: Delivery) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			socket.destroy();
			resolve(delivery);
		};

		try {
			socket = net.createConnection(endpoint);
		} catch {
			resolve("failed");
			return;
		}

		socket.setEncoding("utf8");
		socket.on("error", () => finish("failed"));
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline >= 0) finish(replyStatus(buffer.slice(0, newline)));
		});
		socket.on("end", () => finish(buffer ? replyStatus(buffer) : "failed"));
		timeout = setTimeout(() => finish("failed"), timeoutMs);
		timeout.unref?.();
	});
}

async function sendRequest(endpoint: string, request: unknown, timeoutsMs: number[]): Promise<boolean> {
	// Only transport failures are retried; resending a rejected request cannot help.
	for (const timeoutMs of timeoutsMs) {
		const delivery = await sendRequestAttempt(endpoint, request, timeoutMs);
		if (delivery !== "failed") return delivery === "delivered";
	}
	return false;
}

function compactThinking(level: string): string {
	return THINKING_CODES[level] ?? level.slice(0, 1).toUpperCase();
}

export default function (pi: ExtensionAPI) {
	const socketPath = process.env.HERDR_SOCKET_PATH;
	const endpoint =
		process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
	const paneId = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV !== "1" || !endpoint || !paneId) return;

	let rootSession = false;
	let reportSeq = Date.now() * 1_000;
	let pending = Promise.resolve();
	let latestCtx: ExtensionContext | undefined;
	// Snapshot most recently sent, in flight, or awaiting a retry.
	let requested: Snapshot | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let retryDelay = RETRY_INTERVAL_MS;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;

	function nextSeq(): number {
		reportSeq += 1;
		return reportSeq;
	}

	function enqueue(params: Record<string, unknown>, timeoutsMs = ATTEMPT_TIMEOUTS_MS): Promise<boolean> {
		const request = {
			id: `${SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
			method: "pane.report_metadata",
			params: { pane_id: paneId, source: SOURCE, agent: "pi", seq: nextSeq(), ...params },
		};

		const result = pending.then(() => sendRequest(endpoint!, request, timeoutsMs));
		// Keep a failed auxiliary report from poisoning later metadata updates.
		pending = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	function snapshot(ctx: ExtensionContext): Snapshot {
		return {
			model: ctx.model?.id ?? "no-model",
			thinking: compactThinking(pi.getThinkingLevel()),
		};
	}

	function cancelRetry(): void {
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = undefined;
	}

	function scheduleRetry(): void {
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			if (latestCtx) publish(latestCtx, true);
		}, retryDelay);
		retryTimer.unref?.();
		retryDelay = Math.min(retryDelay * 2, MAX_RETRY_INTERVAL_MS);
	}

	function publish(ctx: ExtensionContext, force = false): void {
		latestCtx = ctx;
		const next = snapshot(ctx);
		if (!force && next.model === requested?.model && next.thinking === requested?.thinking) {
			return;
		}
		requested = next;
		cancelRetry();

		void enqueue({
			tokens: { pi_model: next.model, pi_thinking: next.thinking },
			ttl_ms: MAX_TTL_MS,
		}).then((delivered) => {
			if (!rootSession || requested !== next) return;
			if (delivered) retryDelay = RETRY_INTERVAL_MS;
			else scheduleRetry();
		});
	}

	pi.on("session_start", (_event, ctx) => {
		// Herdr displays terminal panes only; RPC, JSON, and print modes have no
		// corresponding interactive Pi surface.
		if (ctx.mode !== "tui") return;
		rootSession = true;
		retryDelay = RETRY_INTERVAL_MS;
		publish(ctx, true);
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			if (latestCtx) publish(latestCtx, true);
		}, REFRESH_INTERVAL_MS);
		refreshTimer.unref?.();
	});

	pi.on("model_select", (_event, ctx) => {
		if (rootSession) publish(ctx);
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		if (rootSession) publish(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (!rootSession) return;
		rootSession = false;
		cancelRetry();
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		requested = undefined;
		latestCtx = undefined;
		// Pi awaits shutdown handlers, so the clear lands before the process exits.
		await enqueue({ clear_tokens: ["pi_model", "pi_thinking"] }, SHUTDOWN_ATTEMPT_TIMEOUTS_MS);
	});
}
