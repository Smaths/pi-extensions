import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Pi sorts native statuses by key; numeric prefixes keep our items in display order.
export const STATUS_KEY = "@snarfum/20-context-indicator";
export const WARNING_PERCENT = 25;

const GAUGE_WIDTH = 4;
const PARTIAL_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

export function formatContextGauge(percent: number): string {
	if (!Number.isFinite(percent)) return "░".repeat(GAUGE_WIDTH);

	const bounded = Math.max(0, Math.min(100, percent));
	const totalEighths = bounded === 0 ? 0 : Math.max(1, Math.floor((bounded * GAUGE_WIDTH * 8) / 100));
	const fullBlocks = Math.floor(totalEighths / 8);
	const partialBlock = PARTIAL_BLOCKS[totalEighths % 8];
	const usedCells = fullBlocks + (partialBlock ? 1 : 0);
	return `${"█".repeat(fullBlocks)}${partialBlock}${"░".repeat(GAUGE_WIDTH - usedCells)}`;
}

function getContextStatus(ctx: ExtensionContext): string | undefined {
	const percent = ctx.getContextUsage()?.percent;
	if (percent === null || percent === undefined || !Number.isFinite(percent)) return undefined;

	const gauge = formatContextGauge(percent);
	return percent >= WARNING_PERCENT ? `!${gauge}` : gauge;
}

export default function (pi: ExtensionAPI) {
	let lastStatus: string | undefined;
	let hasPublishedStatus = false;

	function updateStatus(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;

		const status = getContextStatus(ctx);
		if (hasPublishedStatus && status === lastStatus) return;

		ctx.ui.setStatus(STATUS_KEY, status);
		lastStatus = status;
		hasPublishedStatus = true;
	}

	pi.on("session_start", (_event, ctx) => {
		lastStatus = undefined;
		hasPublishedStatus = false;
		updateStatus(ctx);
	});
	pi.on("message_end", (_event, ctx) => updateStatus(ctx));
	pi.on("agent_settled", (_event, ctx) => updateStatus(ctx));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));
	pi.on("session_compact", (_event, ctx) => updateStatus(ctx));
	pi.on("session_tree", (_event, ctx) => updateStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		lastStatus = undefined;
		hasPublishedStatus = false;
	});
}
