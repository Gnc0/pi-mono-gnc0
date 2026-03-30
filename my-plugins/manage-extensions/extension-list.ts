/**
 * Custom TUI component: extension list with dual checkboxes (local/global) and search.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { fuzzyFilter, getKeybindings, Input, truncateToWidth } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import type { ExtensionState } from "./resolve-state.js";

type Pending = Map<string, { local: boolean; global: boolean }>;

export function getState(
	pending: Pending,
	ext: ExtensionState,
): { local: boolean; global: boolean } {
	return pending.get(ext.extension.absolutePath) ?? { local: ext.local, global: ext.global };
}

export function toggleField(
	pending: Pending,
	ext: ExtensionState,
	field: "local" | "global",
): void {
	const cur = getState(pending, ext);
	const next = { ...cur, [field]: !cur[field] };
	if (next.local === ext.local && next.global === ext.global) {
		pending.delete(ext.extension.absolutePath);
	} else {
		pending.set(ext.extension.absolutePath, next);
	}
}

export function buildListComponent(
	states: ExtensionState[],
	pending: Pending,
	theme: Theme,
	done: () => void,
): Component {
	let selectedIndex = 0;
	let column = 0;
	const searchInput = new Input();
	let filtered = states;

	function applyFilter(): void {
		const q = searchInput.getValue();
		filtered = q ? fuzzyFilter(states, q, (s) => `${s.extension.repoName} ${s.extension.name}`) : states;
		selectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));
	}

	return {
		render(width: number): string[] {
			const lines: string[] = [];
			lines.push(theme.bold(" Manage Extensions"));
			lines.push(...searchInput.render(width));
			lines.push("");

			if (filtered.length === 0) {
				lines.push(theme.fg("dim", "  No matching extensions"));
				lines.push("", theme.fg("dim", "  Type to search · Esc to close"));
				return lines;
			}

			const maxVisible = 20;
			const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible));
			const end = Math.min(start + maxVisible, filtered.length);

			for (let i = start; i < end; i++) {
				const ext = filtered[i];
				const st = getState(pending, ext);
				const sel = i === selectedIndex;

				const lBox = st.local ? "[✓]" : "[ ]";
				const gBox = st.global ? "[✓]" : "[ ]";
				const lStr = column === 0 && sel ? theme.fg("accent", lBox) : theme.fg("muted", lBox);
				const gStr = column === 1 && sel ? theme.fg("accent", gBox) : theme.fg("muted", gBox);

				const label = `${ext.extension.repoName}/${ext.extension.name}`;
				const prefix = sel ? theme.fg("accent", "→ ") : "  ";
				lines.push(truncateToWidth(`${prefix}L${lStr} G${gStr}  ${sel ? theme.fg("accent", label) : label}`, width));
			}

			if (start > 0 || end < filtered.length) {
				lines.push(theme.fg("dim", `  (${selectedIndex + 1}/${filtered.length})`));
			}

			const cur = filtered[selectedIndex];
			if (cur) {
				lines.push("", theme.fg("dim", `  ${cur.extension.absolutePath}`));
			}

			lines.push("", theme.fg("dim", "  ←/→ switch column · Space toggle · Type to search · Esc to close"));
			return lines;
		},

		handleInput(data: string): void {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.cancel")) return done();
			if (kb.matches(data, "tui.select.up")) {
				if (filtered.length > 0) selectedIndex = selectedIndex === 0 ? filtered.length - 1 : selectedIndex - 1;
				return;
			}
			if (kb.matches(data, "tui.select.down")) {
				if (filtered.length > 0) selectedIndex = selectedIndex === filtered.length - 1 ? 0 : selectedIndex + 1;
				return;
			}
			if (data === " ") {
				const ext = filtered[selectedIndex];
				if (ext) toggleField(pending, ext, column === 0 ? "local" : "global");
				return;
			}
			if (data === "\x1b[D" || data === "\x1b[C") {
				column = column === 0 ? 1 : 0;
				return;
			}
			const sanitized = data.replace(/ /g, "");
			if (sanitized) {
				searchInput.handleInput(sanitized);
				applyFilter();
			}
		},

		invalidate(): void {},
	};
}
