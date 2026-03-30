/**
 * manage-extensions — Interactive extension manager for pi.
 *
 * /manage-extensions opens a TUI listing extensions from configured repos.
 * Each row has dual checkboxes [local] [global] for activation scope.
 * Activation = symlink into .pi/extensions/ or ~/.pi/agent/extensions/.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { join } from "path";

import { discoverExtensions } from "./discover-extensions.js";
import { resolveStates } from "./resolve-state.js";
import type { ExtensionState } from "./resolve-state.js";
import { applyChanges } from "./apply-changes.js";
import type { ChangeEntry } from "./apply-changes.js";
import { buildListComponent } from "./extension-list.js";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("manage-extensions", {
		description: "Toggle extensions on/off for project (local) or global scope",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			const cwd = ctx.cwd;
			const projectExtDir = join(cwd, ".pi", "extensions");
			const globalExtDir = join(getAgentDir(), "extensions");

			const extensions = discoverExtensions(cwd, getAgentDir());
			if (extensions.length === 0) {
				ctx.ui.notify("No repos configured. Add extension-repos.json to .pi/ or ~/.pi/", "warn");
				return;
			}

			const states = resolveStates(extensions, projectExtDir, globalExtDir);
			const pending = new Map<string, { local: boolean; global: boolean }>();

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return buildListComponent(states, pending, theme, done);
			});

			const changes = buildChanges(states, pending);
			if (changes.length === 0) {
				ctx.ui.notify("No changes", "info");
				return;
			}

			const summary = changes.map(formatChange).join("\n");
			if (!(await ctx.ui.confirm("Apply changes?", summary))) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const { applied, warnings } = applyChanges(changes, projectExtDir, globalExtDir);
			for (const w of warnings) ctx.ui.notify(w, "warn");
			if (applied.length > 0) {
				ctx.ui.notify(`Applied ${applied.length} change(s). Reloading...`, "info");
				await ctx.reload();
			}
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

function formatChange(c: ChangeEntry): string {
	const parts: string[] = [c.extension.name + ":"];
	if (c.local.from !== c.local.to) parts.push(`local ${c.local.to ? "ON" : "OFF"}`);
	if (c.global.from !== c.global.to) parts.push(`global ${c.global.to ? "ON" : "OFF"}`);
	return parts.join(" ");
}
