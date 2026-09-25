import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_TITLE_LENGTH = 40;
const MAX_MODEL_INPUT = 1_200;
const MODEL_TIMEOUT_MS = 5_000;
const STOP_WORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "by", "can", "could", "do", "for", "from", "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "our", "please", "the", "this", "to", "we", "what", "with", "would", "you",
]);

// Titles are visible in the session picker; discard likely personal data and code, not just punctuation.
export function normalizeTitle(text: string): string {
	const safe = text
		.replace(/```[\s\S]*?```|`[^`]*`/g, " ")
		.replace(/https?:\/\/\S+|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|(?:~|\.{1,2})?\/\S+|\b[\w.-]+\\[\w\\.-]+/gi, " ")
		.replace(/\b(?:sk-|ghp_|xox[baprs]-)[\w-]+\b|\b[\da-f]{16,}\b/gi, " ")
		.replace(/\b\d[\w.-]*\b/g, " ")
		.replace(/[^\p{L}\s'-]/gu, " ");
	const words = safe.match(/\p{L}+(?:['-]\p{L}+)?/gu)?.filter((word) => !STOP_WORDS.has(word.toLowerCase())) ?? [];
	const selected: string[] = [];
	for (const word of words) {
		if (selected.length === 6 || selected.join(" ").length + word.length + (selected.length ? 1 : 0) > MAX_TITLE_LENGTH) break;
		selected.push(word);
	}
	if (!selected.length) return "";
	const title = selected.join(" ");
	return title[0].toUpperCase() + title.slice(1);
}

function firstUserPrompt(ctx: ExtensionContext): string | undefined {
	const userMessages = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user");
	if (userMessages.length !== 1) return;
	const content = userMessages[0].message.content;
	if (typeof content === "string") return content.trim() || undefined;
	// Mixed image/text prompts are deliberately excluded.
	if (!Array.isArray(content) || !content.length || content.some((part) => part.type !== "text" || typeof part.text !== "string")) return;
	return content.map((part) => part.type === "text" ? part.text : "").join("\n").trim() || undefined;
}

function modelChoice(): { provider: string; id: string } | undefined {
	const choice = process.env.PI_AUTO_SESSION_NAME_MODEL || "openai/gpt-6-luna";
	const separator = choice.indexOf("/");
	if (separator < 1 || separator === choice.length - 1) return;
	return { provider: choice.slice(0, separator), id: choice.slice(separator + 1) };
}

async function modelTitle(prompt: string, ctx: ExtensionContext): Promise<string | undefined> {
	const choice = modelChoice();
	if (!choice) return;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const model = ctx.modelRegistry.find(choice.provider, choice.id);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return;
		const request = ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: "Write only a short, neutral session title (3 to 6 words). No private data, identifiers, paths, quotes, or markdown.",
				messages: [{ role: "user", content: [{ type: "text", text: prompt.slice(0, MAX_MODEL_INPUT) }], timestamp: Date.now() }],
			},
			{ reasoningEffort: "low", maxTokens: 64, signal: controller.signal, cacheRetention: "none" },
		);
		const response = await Promise.race([
			request,
			new Promise<undefined>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, MODEL_TIMEOUT_MS); }),
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
	let attempted = false;
	let generation = 0;

	pi.on("session_start", (event, ctx) => {
		generation++;
		attempted = false;
		// /new starts empty; /resume, /fork, and reload must not become eligible.
		eligibleSession = (event.reason === "startup" || event.reason === "new")
			&& !pi.getSessionName() && ctx.sessionManager.getEntries().length === 0
			? ctx.sessionManager.getSessionId()
			: undefined;
	});
	pi.on("session_before_switch", () => {
		generation++;
		eligibleSession = undefined;
	});
	pi.on("session_shutdown", () => {
		generation++;
		eligibleSession = undefined;
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (attempted || !eligibleSession || ctx.sessionManager.getSessionId() !== eligibleSession) return;
		attempted = true;
		if (pi.getSessionName()) return;
		const prompt = firstUserPrompt(ctx);
		if (!prompt) return;
		const local = normalizeTitle(prompt);
		if (!local) return;
		const currentGeneration = generation;
		let title = local;
		if (process.env.PI_AUTO_SESSION_NAME_MODE === "hybrid" && (prompt.length > 220 || prompt.split(/\s+/).length > 35 || local.split(" ").length < 3)) {
			const suggested = await modelTitle(prompt, ctx);
			title = suggested ? normalizeTitle(suggested) || local : local;
		}
		if (generation !== currentGeneration || ctx.sessionManager.getSessionId() !== eligibleSession || pi.getSessionName()) return;
		pi.setSessionName(title);
	});
}
