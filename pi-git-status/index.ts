import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Agent turns trigger refreshes directly; polling only catches edits made outside Pi.
const REFRESH_INTERVAL_MS = 10_000;
const NON_REPO_REFRESH_INTERVAL_MS = 60_000;
const GIT_STATUS_TIMEOUT_MS = 2_000;

type GitStatus = {
	isRepo: boolean;
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	staged: number;
	unstaged: number;
	untracked: number;
	conflicts: number;
};

const EMPTY_STATUS: GitStatus = {
	isRepo: false,
	branch: null,
	upstream: null,
	ahead: 0,
	behind: 0,
	staged: 0,
	unstaged: 0,
	untracked: 0,
	conflicts: 0,
};

function parseGitStatus(output: string): GitStatus {
	const status: GitStatus = { ...EMPTY_STATUS, isRepo: true };

	for (const line of output.split("\n")) {
		if (line.startsWith("# branch.head ")) {
			const branch = line.slice("# branch.head ".length).trim();
			status.branch = branch === "(detached)" ? "detached" : branch || null;
			continue;
		}
		if (line.startsWith("# branch.upstream ")) {
			status.upstream = line.slice("# branch.upstream ".length).trim() || null;
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
			if (match) {
				status.ahead = Number(match[1]);
				status.behind = Number(match[2]);
			}
			continue;
		}

		if (line.startsWith("? ")) {
			status.untracked++;
			continue;
		}
		if (line.startsWith("u ")) {
			status.conflicts++;
			continue;
		}
		if (line.startsWith("1 ") || line.startsWith("2 ")) {
			const indexStatus = line[2];
			const worktreeStatus = line[3];
			if (indexStatus && indexStatus !== ".") status.staged++;
			if (worktreeStatus && worktreeStatus !== ".") status.unstaged++;
		}
	}

	return status;
}

function formatCwd(cwd: string): string {
	const home = homedir();
	const relativeToHome = relative(resolve(home), resolve(cwd));
	if (!relativeToHome) return "~";
	if (relativeToHome === ".." || relativeToHome.startsWith(`..${sep}`)) return cwd;
	return `~${sep}${relativeToHome}`;
}

function formatCount(prefix: string, count: number): string {
	return count > 0 ? `${prefix}${count}` : "";
}

function formatGitState(status: GitStatus, theme: ExtensionContext["ui"]["theme"]): string {
	const parts = [
		formatCount("↑", status.ahead),
		formatCount("↓", status.behind),
		formatCount("+", status.staged),
		formatCount("!", status.unstaged),
		formatCount("?", status.untracked),
		formatCount("⚠", status.conflicts),
	].filter(Boolean);

	if (!status.upstream && status.branch && status.branch !== "detached") {
		parts.push("no-upstream");
	}
	if (parts.length === 0) parts.push("✓");

	return parts
		.map((part) => {
			if (part.startsWith("⚠")) return theme.fg("error", part);
			if (part.startsWith("!") || part === "no-upstream") return theme.fg("warning", part);
			if (part.startsWith("+") || part === "✓") return theme.fg("success", part);
			return theme.fg("dim", part);
		})
		.join(" ");
}

function formatTokens(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

type Usage = { input: number; output: number; cost: number };

function getUsage(ctx: ExtensionContext): Usage {
	const usage: Usage = { input: 0, output: 0, cost: 0 };
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") addUsage(usage, entry.message.usage);
	}
	return usage;
}

function addUsage(usage: Usage, message: { input: number; output: number; cost: { total: number } }): void {
	usage.input += message.input;
	usage.output += message.output;
	usage.cost += message.cost.total;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export default function (pi: ExtensionAPI) {
	// Identifies the active TUI session so work started by an earlier session is discarded.
	let session: { ctx: ExtensionContext } | undefined;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let refreshing = false;
	let refreshQueued = false;
	let gitStatus: GitStatus = { ...EMPTY_STATUS };
	let usage: Usage = { input: 0, output: 0, cost: 0 };
	let sessionName: string | undefined;
	let requestFooterRender: (() => void) | undefined;

	function cancelScheduledRefresh(): void {
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = undefined;
	}

	function scheduleRefresh(): void {
		cancelScheduledRefresh();
		refreshTimer = setTimeout(requestRefresh, gitStatus.isRepo ? REFRESH_INTERVAL_MS : NON_REPO_REFRESH_INTERVAL_MS);
		refreshTimer.unref?.();
	}

	function requestRefresh(): void {
		if (!session) return;
		// Coalesce bursts of events into one follow-up run instead of dropping them.
		if (refreshing) {
			refreshQueued = true;
			return;
		}
		void refresh(session);
	}

	async function refresh(current: { ctx: ExtensionContext }): Promise<void> {
		refreshing = true;
		refreshQueued = false;
		cancelScheduledRefresh();

		try {
			const result = await pi.exec(
				"git",
				["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
				{ cwd: current.ctx.cwd, timeout: GIT_STATUS_TIMEOUT_MS },
			);
			if (current !== session) return;
			// A timed-out git is reported with code 0 and partial output, so check `killed` too.
			gitStatus = result.code === 0 && !result.killed ? parseGitStatus(result.stdout) : { ...EMPTY_STATUS };
			requestFooterRender?.();
		} finally {
			refreshing = false;
			if (refreshQueued || (session && current !== session)) requestRefresh();
			else if (current === session) scheduleRefresh();
		}
	}

	function syncSessionData(ctx: ExtensionContext): void {
		usage = getUsage(ctx);
		sessionName = pi.getSessionName();
		requestFooterRender?.();
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		cancelScheduledRefresh();
		session = { ctx };
		gitStatus = { ...EMPTY_STATUS };
		syncSessionData(ctx);

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestFooterRender = () => tui.requestRender();
			const unsubscribeBranchChanges = footerData.onBranchChange(() => {
				requestRefresh();
				tui.requestRender();
			});

			return {
				dispose: () => {
					unsubscribeBranchChanges();
					requestFooterRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const branch = footerData.getGitBranch() ?? gitStatus.branch;
					// Style each segment separately: a nested color resets the outer dim color.
					let location = theme.fg("dim", formatCwd(ctx.cwd));
					if (branch) {
						const state = gitStatus.isRepo ? ` ${formatGitState(gitStatus, theme)}` : "";
						location += `${theme.fg("dim", ` (${branch}`)}${state}${theme.fg("dim", ")")}`;
					}
					if (sessionName) location += theme.fg("dim", ` • ${sessionName}`);

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextDisplay =
						contextUsage?.percent === null || contextUsage?.percent === undefined
							? `?/${formatTokens(contextWindow)}`
							: `${contextUsage.percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
					const stats = `↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} $${usage.cost.toFixed(3)} ${contextDisplay}`;
					const thinking = ctx.model?.reasoning
						? ` • ${ctx.thinkingLevel && ctx.thinkingLevel !== "off" ? ctx.thinkingLevel : "thinking off"}`
						: "";
					const right = `${ctx.model?.id ?? "no-model"}${thinking}`;

					const leftStyled = theme.fg("dim", stats);
					const rightStyled = theme.fg("dim", right);
					const padding = " ".repeat(Math.max(1, width - visibleWidth(leftStyled) - visibleWidth(rightStyled)));
					const lines = [
						truncateToWidth(location, width, theme.fg("dim", "...")),
						truncateToWidth(leftStyled + padding + rightStyled, width),
					];

					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const statusLine = Array.from(extensionStatuses.values())
							.map(sanitizeStatusText)
							.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});

		// Do not await: Pi runs session_start handlers in sequence, and git can be slow.
		requestRefresh();
	});

	// Usage is accumulated from events instead of rescanning every entry on each render.
	pi.on("message_end", (event) => {
		if (!session || event.message.role !== "assistant") return;
		addUsage(usage, event.message.usage);
		requestFooterRender?.();
	});

	pi.on("session_info_changed", (event) => {
		if (!session) return;
		sessionName = event.name;
		requestFooterRender?.();
	});

	// Agent tools usually change the working tree, so refresh once per turn.
	pi.on("turn_end", () => {
		requestRefresh();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!session) return;
		// Resynchronize with the stored session in case an update was missed.
		syncSessionData(ctx);
		requestRefresh();
	});

	pi.on("session_shutdown", () => {
		session = undefined;
		cancelScheduledRefresh();
		refreshQueued = false;
		requestFooterRender = undefined;
		gitStatus = { ...EMPTY_STATUS };
	});
}
