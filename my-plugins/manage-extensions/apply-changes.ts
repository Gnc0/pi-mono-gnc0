/**
 * Apply symlink changes: create or remove symlinks in project/global extensions dirs.
 * Refuses to remove non-symlink files.
 */

import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from "fs";
import { join, relative } from "path";
import type { DiscoveredExtension } from "./discover-extensions.js";

export interface ChangeEntry {
	extension: DiscoveredExtension;
	local: { from: boolean; to: boolean };
	global: { from: boolean; to: boolean };
}

export interface ApplyResult {
	applied: string[];
	warnings: string[];
}

export function applyChanges(
	changes: ChangeEntry[],
	projectExtDir: string,
	globalExtDir: string,
): ApplyResult {
	const applied: string[] = [];
	const warnings: string[] = [];

	for (const { extension, local, global } of changes) {
		applyOne(extension, local, projectExtDir, "local", applied, warnings);
		applyOne(extension, global, globalExtDir, "global", applied, warnings);
	}

	return { applied, warnings };
}

function applyOne(
	ext: DiscoveredExtension,
	change: { from: boolean; to: boolean },
	dir: string,
	scope: string,
	applied: string[],
	warnings: string[],
): void {
	if (change.from === change.to) return;
	const linkPath = join(dir, ext.name);

	if (change.from && !change.to) {
		try {
			if (!existsSync(linkPath)) return;
			const stat = lstatSync(linkPath);
			if (!stat.isSymbolicLink()) {
				warnings.push(`${ext.name}: "${linkPath}" is not a symlink — refusing to remove`);
				return;
			}
			unlinkSync(linkPath);
			applied.push(`${ext.name}: ${scope} OFF`);
		} catch (err) {
			warnings.push(`${ext.name}: failed to remove — ${err}`);
		}
	} else if (!change.from && change.to) {
		try {
			mkdirSync(dir, { recursive: true });
			symlinkSync(relative(dir, ext.absolutePath), linkPath);
			applied.push(`${ext.name}: ${scope} ON`);
		} catch (err) {
			warnings.push(`${ext.name}: failed to create symlink — ${err}`);
		}
	}
}
