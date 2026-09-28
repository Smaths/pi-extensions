import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_TITLE_LENGTH = 40;
const MAX_TITLE_WORDS = 3;
const MAX_MODEL_INPUT = 1_200;
const MODEL_TIMEOUT_MS = 5_000;
const STOP_WORDS = new Set([
	"a", "an", "all", "and", "are", "as", "at", "be", "by", "can", "could", "do", "for", "from", "help", "how", "i", "in", "is", "it", "me", "my", "need", "of", "on", "or", "our", "please", "that", "the", "then", "this", "to", "we", "what", "with", "would", "you",
]);
const SECONDARY_REQUEST = /\s+\b(?:and|then)\s+(?:describe|explain|outline|recommend|suggest|tell|show|provide|improve|update|fix|change|modify|implement|refactor|review)\b[\s\S]*$/i;

// Titles are visible in the session picker; discard likely personal data and code, not just punctuation.
export function normalizeTitle(text: string): string {
	// Prefer the first request when a prompt contains multiple asks. This keeps
	// the title focused on the primary task instead of trailing instructions.
	const primaryRequest = text.replace(SECONDARY_REQUEST, "");
	const safe = primaryRequest
		.replace(/```[\s\S]*?```|`[^`]*`/g, " ")
		.replace(/https?:\/\/\S+|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|(?:~|\.{1,2})?\/\S+|\b[\w.-]+\\[\w\\.-]+/gi, " ")
		.replace(/\b(?:sk-|ghp_|xox[baprs]-)[\w-]+\b|\b[\da-f]{16,}\b/gi, " ")
		.replace(/\b\d[\w.-]*\b/g, " ")
		.replace(/[^\p{L}\s'-]/gu, " ");
	const words = safe.match(/\p{L}+(?:['-]\p{L}+)?/gu)?.filter((word) => !STOP_WORDS.has(word.toLowerCase())) ?? [];
	const selected: string[] = [];
	for (const word of words) {
		if (selected.length === MAX_TITLE_WORDS || selected.join(" ").length + word.length + (selected.length ? 1 : 0) > MAX_TITLE_LENGTH) break;
		selected.push(word);
	}
	if (!selected.length) return "";
	const title = selected.join(" ");
	return title[0].toUpperCase() + title.slice(1);
}

function modelChoice(): { provider: string; id: string } | undefined {
	const choice = process.env.PI_AUTO_SESSION_NAME_MODEL || "openai-codex/gpt-6-luna";
	const separator = choice.indexOf("/");
	if (separator < 1 || separator === choice.length - 1) return;
	return { provider: choice.slice(0, separator), id: choice.slice(separator + 1) };
}

async function modelTitle(prompt: string, ctx: ExtensionContext, controller: AbortController): Promise<string | undefined> {
	const choice = modelChoice();
	if (!choice) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const model = ctx.modelRegistry.find(choice.provider, choice.id);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return;
		const request = ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: "Name this session like a concise commit message: use a present-tense action verb first, then up to two words of context. Use at most three words total. Return only the name. Omit filler, details, punctuation, markdown, private data, identifiers, and paths.",
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			},
			{ reasoningEffort: "low", maxTokens: 24, signal: controller.signal, cacheRetention: "none" }
		);
		const response = await Promise.race([
			request,
			new Promise<undefined>((resolve) => {
				controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
				timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
				// Do not keep a finished print or RPC run alive for the title.
				timer.unref?.();
			}),
		]);
		if (!response || controller.signal.aborted || response.stopReason !== "stop") return;
		return response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join(" ");
	} catch {
		return;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export default function (pi: ExtensionAPI) {
	let eligibleSession: string | undefined;
	let inputText = "";
	let pending: { local: string; controller: AbortController } | undefined;

	pi.on("session_start", (event, ctx) => {
		// Pi records the initial model and thinking level before session_start.
		// A previously saved session file (including a metadata-only one) is not new.
		const sessionFile = ctx.sessionManager.getSessionFile();
		const hasConversation = ctx.sessionManager.getEntries().some((entry) =>
			entry.type !== "model_change" && entry.type !== "thinking_level_change",
		);
		eligibleSession = (event.reason === "startup" || event.reason === "new")
			&& !pi.getSessionName() && !hasConversation && !(sessionFile && existsSync(sessionFile))
			? ctx.sessionManager.getSessionId()
			: undefined;
	});
	pi.on("session_shutdown", () => {
		eligibleSession = undefined;
		if (!pending) return;
		const { local, controller } = pending;
		pending = undefined;
		controller.abort();
		// Keep a session that closes before the title model answers named.
		if (local && !pi.getSessionName()) pi.setSessionName(local);
	});

	// Name `/skill:name args` and `/template args` from their args, not the expanded text.
	function withoutCommand(text: string): string {
		const match = /^\/(\S+)(?:\s+|$)/.exec(text);
		return match && pi.getCommands().some((command) => command.name === match[1]) ? text.slice(match[0].length) : text;
	}

	async function nameSession(prompt: string, ctx: ExtensionContext): Promise<void> {
		const naming = { local: normalizeTitle(prompt), controller: new AbortController() };
		pending = naming;
		const suggested = normalizeTitle((await modelTitle(prompt, ctx, naming.controller)) ?? "");
		// Shutdown clears `pending` and leaves ctx and pi stale, so check it before using either.
		if (pending !== naming) return;
		pending = undefined;
		const title = suggested && (suggested.includes(" ") || !naming.local) ? suggested : naming.local;
		if (!title || pi.getSessionName()) return;
		try {
			pi.setSessionName(title);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Could not set session name: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	// before_agent_start only sees the expanded prompt, so keep the raw text from input.
	pi.on("input", (event) => {
		inputText = event.text;
	});

	// Name at run start without blocking it. Steers and follow-ups never reach before_agent_start.
	pi.on("before_agent_start", (_event, ctx) => {
		if (!eligibleSession || ctx.sessionManager.getSessionId() !== eligibleSession || pi.getSessionName()) return;
		// Titles use at most three words, so a large pasted prompt needs no full scan.
		const prompt = withoutCommand(inputText).trim().slice(0, MAX_MODEL_INPUT);
		// A bare command or image leaves nothing to name; let the next prompt try.
		if (!prompt) return;
		eligibleSession = undefined;
		void nameSession(prompt, ctx);
	});
}
