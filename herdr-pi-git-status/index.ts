import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const REFRESH_INTERVAL_MS = 5_000;
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

function getUsage(ctx: ExtensionContext): { input: number; output: number; cost: number } {
	let input = 0;
	let output = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		input += entry.message.usage.input;
		output += entry.message.usage.output;
		cost += entry.message.usage.cost.total;
	}

	return { input, output, cost };
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export default function (pi: ExtensionAPI) {
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let disposed = false;
	let refreshing = false;
	let gitStatus: GitStatus = { ...EMPTY_STATUS };
	let requestFooterRender: (() => void) | undefined;

	async function refresh(ctx: ExtensionContext): Promise<void> {
		if (disposed || refreshing) return;
		refreshing = true;

		try {
			const result = await pi.exec(
				"git",
				["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
				{ cwd: ctx.cwd, timeout: GIT_STATUS_TIMEOUT_MS },
			);
			gitStatus = result.code === 0 ? parseGitStatus(result.stdout) : { ...EMPTY_STATUS };
			requestFooterRender?.();
		} finally {
			refreshing = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		disposed = false;
		gitStatus = { ...EMPTY_STATUS };

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestFooterRender = () => tui.requestRender();
			const unsubscribeBranchChanges = footerData.onBranchChange(() => {
				void refresh(ctx);
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
					let location = formatCwd(ctx.cwd);
					if (branch) {
						const state = gitStatus.isRepo ? ` ${formatGitState(gitStatus, theme)}` : "";
						location += ` (${branch}${state})`;
					}

					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) location += ` • ${sessionName}`;

					const usage = getUsage(ctx);
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
						truncateToWidth(theme.fg("dim", location), width, theme.fg("dim", "...")),
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

		await refresh(ctx);
		refreshTimer = setInterval(() => void refresh(ctx), REFRESH_INTERVAL_MS);
		refreshTimer.unref?.();
	});

	pi.on("session_shutdown", () => {
		disposed = true;
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		requestFooterRender = undefined;
		gitStatus = { ...EMPTY_STATUS };
	});
}
