import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Pi sorts native statuses by key; numeric prefixes keep our items in display order.
export const STATUS_KEY = "@snarfum/10-git-status";

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

export function parseGitStatus(output: string): GitStatus {
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

function formatCount(prefix: string, count: number): string {
	return count > 0 ? `${prefix}${count}` : "";
}

export function formatGitState(status: GitStatus): string | undefined {
	if (!status.isRepo) return undefined;

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

	return parts.join(" ");
}

export default function (pi: ExtensionAPI) {
	// Identifies the active TUI session so work started by an earlier session is discarded.
	let session: { ctx: ExtensionContext } | undefined;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let refreshing = false;
	let refreshQueued = false;
	let gitStatus: GitStatus = { ...EMPTY_STATUS };
	let lastStatus: string | undefined;

	function publishStatus(ctx: ExtensionContext): void {
		const status = formatGitState(gitStatus);
		if (status === lastStatus) return;
		ctx.ui.setStatus(STATUS_KEY, status);
		lastStatus = status;
	}

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
			// A timed-out git can return code 0 and partial output; check `killed` too.
			gitStatus = result.code === 0 && !result.killed ? parseGitStatus(result.stdout) : { ...EMPTY_STATUS };
			publishStatus(current.ctx);
		} catch {
			// Missing git or execution failures must not leave stale status or reject in the background.
			if (current !== session) return;
			gitStatus = { ...EMPTY_STATUS };
			publishStatus(current.ctx);
		} finally {
			refreshing = false;
			if (refreshQueued || (session && current !== session)) requestRefresh();
			else if (current === session) scheduleRefresh();
		}
	}

	function stop(): void {
		if (session) session.ctx.ui.setStatus(STATUS_KEY, undefined);
		session = undefined;
		cancelScheduledRefresh();
		refreshQueued = false;
		gitStatus = { ...EMPTY_STATUS };
		lastStatus = undefined;
	}

	pi.on("session_start", (_event, ctx) => {
		stop();
		if (ctx.mode !== "tui") return;
		session = { ctx };
		// Do not await: Pi runs session_start handlers in sequence, and git can be slow.
		requestRefresh();
	});

	// Agent tools usually change the working tree, so refresh once per turn and when settled.
	pi.on("turn_end", requestRefresh);
	pi.on("agent_settled", requestRefresh);
	pi.on("session_shutdown", stop);
}
