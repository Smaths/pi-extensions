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

const socketPath = process.env.HERDR_SOCKET_PATH;
const socketEndpoint =
	process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const paneId = process.env.HERDR_PANE_ID;

function enabled(): boolean {
	return process.env.HERDR_ENV === "1" && Boolean(socketEndpoint) && Boolean(paneId);
}

function sendRequestAttempt(request: unknown, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const finish = (delivered: boolean) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			socket.destroy();
			resolve(delivered);
		};

		let socket: net.Socket;
		try {
			socket = net.createConnection(socketEndpoint!);
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

async function sendRequest(request: unknown): Promise<boolean> {
	if (await sendRequestAttempt(request, 500)) return true;
	return sendRequestAttempt(request, 1_500);
}

export default function (pi: ExtensionAPI) {
	if (!enabled()) return;

	let rootSession = false;
	let reportSeq = Date.now() * 1_000;
	let pending = Promise.resolve();
	let lastPublished: { model: string; thinking: string } | undefined;

	function nextSeq(): number {
		reportSeq += 1;
		return reportSeq;
	}

	function enqueue(params: Record<string, unknown>): Promise<boolean> {
		const request = {
			id: `${SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
			method: "pane.report_metadata",
			params: { pane_id: paneId, source: SOURCE, agent: "pi", seq: nextSeq(), ...params },
		};

		const result = pending.then(() => sendRequest(request));
		// Keep a failed auxiliary report from poisoning later metadata updates.
		pending = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	function compactThinking(level: string): string {
		// A distinct one-character code for every Pi thinking level.
		return (
			{
				off: "O",
				minimal: "N",
				low: "L",
				medium: "M",
				high: "H",
				xhigh: "X",
				max: "Z",
			} as Record<string, string>
		)[level] ?? level.slice(0, 1).toUpperCase();
	}

	function snapshot(ctx: ExtensionContext): { model: string; thinking: string } {
		return {
			model: ctx.model?.id ?? "no-model",
			thinking: compactThinking(pi.getThinkingLevel()),
		};
	}

	function publish(ctx: ExtensionContext, force = false): void {
		const next = snapshot(ctx);
		if (!force && next.model === lastPublished?.model && next.thinking === lastPublished?.thinking) {
			return;
		}

		void enqueue({
			tokens: { pi_model: next.model, pi_thinking: next.thinking },
			ttl_ms: MAX_TTL_MS,
		}).then((delivered) => {
			if (delivered) lastPublished = next;
		});
	}

	function clear(): void {
		lastPublished = undefined;
		void enqueue({ clear_tokens: ["pi_model", "pi_thinking"] });
	}

	pi.on("session_start", (_event, ctx) => {
		// Herdr displays terminal panes only; RPC, JSON, and print modes have no
		// corresponding interactive Pi surface.
		if (ctx.mode !== "tui") return;
		rootSession = true;
		publish(ctx, true);
	});

	pi.on("model_select", (_event, ctx) => {
		if (rootSession) publish(ctx);
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		if (rootSession) publish(ctx);
	});

	pi.on("session_shutdown", () => {
		if (!rootSession) return;
		rootSession = false;
		clear();
	});
}
