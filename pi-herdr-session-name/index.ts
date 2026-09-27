/**
 * Publish Pi's session name as Herdr pane title and display-only metadata.
 *
 * The title labels the pane border while Pi is the pane's agent. Herdr's
 * sidebar layout can also render the `pi_session_name` token in a third Agent
 * row. The session name may be assigned asynchronously by another Pi
 * extension, so this extension follows Pi's session name change events.
 */
import net from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SOURCE = "user:pi-session-name";
const TOKEN = "pi_session_name";
const TOKEN_TTL_MS = 86_400_000;
// Re-send before the token TTL lapses so long-lived panes keep the sidebar row.
const REFRESH_INTERVAL_MS = TOKEN_TTL_MS / 2;
const RETRY_INTERVAL_MS = 5_000;
const MAX_RETRY_INTERVAL_MS = 300_000;
const ATTEMPT_TIMEOUTS_MS = [500, 1_500];
// Keep exit fast when Herdr is gone.
const SHUTDOWN_ATTEMPT_TIMEOUTS_MS = [500];

function sanitizeSessionName(name: string | undefined): string {
	return (name ?? "").replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

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

export default function (pi: ExtensionAPI) {
	const socketPath = process.env.HERDR_SOCKET_PATH;
	const endpoint =
		process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
	const paneId = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV !== "1" || !endpoint || !paneId) return;
	const publishTitle = process.env.PI_HERDR_SESSION_NAME_TITLE !== "0";

	let active = false;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let retryDelay = RETRY_INTERVAL_MS;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let reportSeq = Date.now() * 1_000;
	let pending = Promise.resolve();
	// Name most recently sent, in flight, or awaiting a retry.
	let requestedName: string | undefined;

	function nextSeq(): number {
		reportSeq += 1;
		return reportSeq;
	}

	function enqueue(params: Record<string, unknown>, timeoutsMs = ATTEMPT_TIMEOUTS_MS): Promise<boolean> {
		const request = {
			id: `${SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
			method: "pane.report_metadata",
			// `agent` keeps the title from applying if another agent takes over the pane.
			params: { pane_id: paneId, source: SOURCE, agent: "pi", seq: nextSeq(), ...params },
		};
		const result = pending.then(() => sendRequest(endpoint!, request, timeoutsMs));
		pending = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	function clearParams(): Record<string, unknown> {
		return { clear_title: true, tokens: { [TOKEN]: null } };
	}

	async function publish(name: string): Promise<boolean> {
		if (!name) return enqueue(clearParams());

		// Herdr applies a report's TTL to its title but to each token separately, so
		// the title is sent without a TTL and the token keeps the maximum TTL.
		const title = publishTitle ? enqueue({ title: name }) : Promise.resolve(true);
		const token = enqueue({ tokens: { [TOKEN]: name }, ttl_ms: TOKEN_TTL_MS });
		const [titleDelivered, tokenDelivered] = await Promise.all([title, token]);
		return titleDelivered && tokenDelivered;
	}

	function cancelRetry(): void {
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = undefined;
	}

	function report(name: string): void {
		if (name === requestedName) return;
		requestedName = name;
		cancelRetry();

		void publish(name).then((delivered) => {
			if (!active || requestedName !== name) return;
			if (delivered) {
				retryDelay = RETRY_INTERVAL_MS;
				return;
			}
			retryTimer = setTimeout(() => {
				retryTimer = undefined;
				requestedName = undefined;
				sync();
			}, retryDelay);
			retryTimer.unref?.();
			retryDelay = Math.min(retryDelay * 2, MAX_RETRY_INTERVAL_MS);
		});
	}

	function clear(timeoutsMs = ATTEMPT_TIMEOUTS_MS): Promise<boolean> {
		cancelRetry();
		requestedName = "";
		return enqueue(clearParams(), timeoutsMs);
	}

	function sync(): void {
		if (!active) return;
		report(sanitizeSessionName(pi.getSessionName()));
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		active = true;
		retryDelay = RETRY_INTERVAL_MS;
		void clear();
		sync();
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			if (!active || !requestedName) return;
			requestedName = undefined;
			sync();
		}, REFRESH_INTERVAL_MS);
		refreshTimer.unref?.();
	});

	pi.on("session_info_changed", (event) => {
		if (!active) return;
		report(sanitizeSessionName(event.name));
	});

	// Fallback for Pi versions without `session_info_changed`.
	pi.on("agent_settled", () => {
		sync();
	});

	pi.on("session_shutdown", async () => {
		if (!active) return;
		active = false;
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		// Pi awaits shutdown handlers, so the clear lands before the process exits.
		await clear(SHUTDOWN_ATTEMPT_TIMEOUTS_MS);
	});
}

export { sanitizeSessionName };
