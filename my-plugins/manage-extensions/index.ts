/**
 * manage-extensions — Interactive extension manager for pi.
 *
 * /manage-extensions opens a TUI listing extensions from configured repos.
 * Each row has dual checkboxes [local] [global] for activation scope.
 * Activation = symlink into .pi/extensions/ or ~/.pi/agent/extensions/.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { getKeybindings, truncateToWidth } from "@mariozechner/pi-tui";
import { join } from "path";

import { discoverExtensions, findNameConflicts } from "./discover-extensions.js";
import { resolveStates } from "./resolve-state.js";
import type { ExtensionState } from "./resolve-state.js";
import { applyChanges, preflightChanges } from "./apply-changes.js";
import type { ChangeEntry } from "./apply-changes.js";
import { buildListComponent } from "./extension-list.js";
import type { ListResult } from "./extension-list.js";
import { startBackgroundScan, getCachedResult, clearCache, getCurrentProgress } from "./scan-cache.js";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("manage-extensions", {
		description: "Toggle extensions on/off for project (local) or global scope",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			const cwd = ctx.cwd;
			const globalDir = getAgentDir();

			const scanPromise = startBackgroundScan(cwd, globalDir, (onProgress) => discoverExtensions(cwd, globalDir, onProgress));
			if (!getCachedResult(cwd, globalDir)) {
				await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
					let closed = false;
					scanPromise.finally(() => {
						if (!closed) {
							closed = true;
							done();
						}
					});
					return buildScanProgressComponent(theme, () => {
						if (!closed) {
							closed = true;
							done();
						}
					});
				});
			}

			const result = await scanPromise;
			if (result.error) {
				ctx.ui.notify(`Failed to scan extensions: ${result.error}`, "warning");
				return;
			}
			if (result.extensions.length === 0) {
				ctx.ui.notify(
					"No extensions found. Check extension-repos.json in .pi/ or ~/.pi/agent/ and ensure repos contain valid extensions.",
					"warning",
				);
				return;
			}

			const conflicts = findNameConflicts(result.extensions);
			if (conflicts.size > 0) {
				for (const [name, extensions] of conflicts) {
					const locations = extensions.map((ext) => `${ext.repoName}/${ext.name}`).join(", ");
					ctx.ui.notify(`Duplicate extension name \"${name}\": ${locations}`, "warning");
				}
				ctx.ui.notify(
					"Resolve duplicate extension names before applying changes. Link targets are keyed by extension name.",
					"warning",
				);
				return;
			}

			const projectExtDir = join(cwd, ".pi", "extensions");
			const globalExtDir = join(globalDir, "extensions");

			const states = resolveStates(result.extensions, projectExtDir, globalExtDir);
			const pending = new Map<string, { local: boolean; global: boolean }>();
			let uiResult = { action: "cancel" } as ListResult;

			while (true) {
				const preflightIssues = preflightChanges(buildChanges(states, pending), projectExtDir, globalExtDir);
				uiResult = await new Promise<ListResult>((resolve) => {
					ctx.ui.custom<void>((_tui, theme, _kb, done) => {
						return buildListComponent(states, pending, theme, (resultValue) => {
							resolve(resultValue);
							done();
						}, preflightIssues);
					});
				});

				if (uiResult.action !== "back") break;
			}

			if (uiResult.action !== "apply") {
				ctx.ui.notify(uiResult.action === "cancel" ? "Cancelled" : "No changes", "info");
				return;
			}

			const changes = buildChanges(states, pending);
			if (changes.length === 0) {
				ctx.ui.notify("No changes", "info");
				return;
			}

			const { applied, warnings } = applyChanges(changes, projectExtDir, globalExtDir);
			for (const w of warnings) ctx.ui.notify(w, "warning");
			if (applied.length > 0) {
				clearCache();
				ctx.ui.notify(`Applied ${applied.length} change(s). Reloading...`, "info");
				await ctx.reload();
				return;
			}

			ctx.ui.notify("No changes applied", "info");
		},
	});
}

function buildChanges(
	states: ExtensionState[],
	pending: Map<string, { local: boolean; global: boolean }>,
): ChangeEntry[] {
	const changes: ChangeEntry[] = [];
	for (const [path, to] of pending) {
		const st = states.find((s) => s.extension.absolutePath === path);
		if (!st || (to.local === st.local && to.global === st.global)) continue;
		changes.push({
			extension: st.extension,
			local: { from: st.local, to: to.local },
			global: { from: st.global, to: to.global },
		});
	}
	return changes;
}

function buildScanProgressComponent(theme: Theme, done: () => void): Component {
	const kb = getKeybindings();
	return {
		render(width: number): string[] {
			const progress = getCurrentProgress();
			const repoLabel = progress?.repoName ?? "Preparing repos";
			const entryLabel = progress?.entryName ?? "Resolving entries";
			const repoProgress = progress?.repoCount ? `${progress.repoIndex}/${progress.repoCount}` : "0/0";
			const entryProgress = progress?.entryCount ? `${progress.entryIndex}/${progress.entryCount}` : "0/0";
			return [
				theme.bold(" Scanning Extensions "),
				"",
				truncateToWidth(`  Repo: ${repoLabel}`, width),
				truncateToWidth(`  Repo progress: ${repoProgress}`, width),
				truncateToWidth(`  Entry: ${entryLabel}`, width),
				truncateToWidth(`  Entry progress: ${entryProgress}`, width),
				"",
				theme.fg("dim", "  Waiting for scan to complete..."),
				theme.fg("dim", "  Esc closes this view (scan continues in the background)"),
			];
		},
		handleInput(data: string): void {
			if (kb.matches(data, "tui.select.cancel")) done();
		},
		invalidate(): void {},
	};
}
