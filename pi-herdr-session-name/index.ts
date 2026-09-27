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
const RETRY_INTERVAL_MS = 5_000;

function sanitizeSessionName(name: string | undefined): string {
	return (name ?? "").replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function sendRequestAttempt(endpoint: string, request: unknown, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let socket: net.Socket;
		const finish = (delivered: boolean) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			socket.destroy();
			resolve(delivered);
		};

		try {
			socket = net.createConnection(endpoint);
		} catch {
			resolve(false);
			return;
		}

		socket.on("error", () => finish(false));
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", () => finish(true));
		socket.on("end", () => finish(false));
		timeout = setTimeout(() => finish(false), timeoutMs);
		timeout.unref?.();
	});
}

async function sendRequest(endpoint: string, request: unknown): Promise<boolean> {
	if (await sendRequestAttempt(endpoint, request, 500)) return true;
	return sendRequestAttempt(endpoint, request, 1_500);
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
	let reportSeq = Date.now() * 1_000;
	let pending = Promise.resolve();
	// Name most recently sent, in flight, or awaiting a retry.
	let requestedName: string | undefined;

	function nextSeq(): number {
		reportSeq += 1;
		return reportSeq;
	}

	function enqueue(params: Record<string, unknown>): Promise<boolean> {
		const result = pending.then(() =>
			sendRequest(endpoint!, {
				id: `${SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
				method: "pane.report_metadata",
				// `agent` keeps the title from applying if another agent takes over the pane.
				params: { pane_id: paneId, source: SOURCE, agent: "pi", seq: nextSeq(), ...params },
			}),
		);
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
			if (delivered || !active || requestedName !== name) return;
			retryTimer = setTimeout(() => {
				retryTimer = undefined;
				requestedName = undefined;
				sync();
			}, RETRY_INTERVAL_MS);
			retryTimer.unref?.();
		});
	}

	function clear(): void {
		cancelRetry();
		requestedName = "";
		void enqueue(clearParams());
	}

	function sync(): void {
		if (!active) return;
		report(sanitizeSessionName(pi.getSessionName()));
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		active = true;
		clear();
		sync();
	});

	pi.on("session_info_changed", (event) => {
		if (!active) return;
		report(sanitizeSessionName(event.name));
	});

	// Fallback for Pi versions without `session_info_changed`.
	pi.on("agent_settled", () => {
		sync();
	});

	pi.on("session_shutdown", () => {
		if (!active) return;
		active = false;
		clear();
	});
}

export { sanitizeSessionName };
