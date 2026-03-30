/**
 * Discover extensions from repos configured in extension-repos.json.
 *
 * Reads extension-repos.json from both ~/.pi/agent/ and ./.pi/.
 * Each repo entry has { name, path }. Scans each path (one level) for valid extensions.
 */

import type { Dirent } from "fs";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

export interface RepoConfig {
	name: string;
	path: string;
}

export interface DiscoveredExtension {
	repoName: string;
	repoPath: string;
	name: string;
	absolutePath: string;
}

const REPOS_FILE = "extension-repos.json";

export function discoverExtensions(cwd: string, globalDir: string): DiscoveredExtension[] {
	const repos = loadRepos(join(cwd, ".pi", REPOS_FILE), join(globalDir, REPOS_FILE));
	const results: DiscoveredExtension[] = [];

	for (const repo of repos) {
		const repoPath = resolve(repo.path);
		if (!existsSync(repoPath)) continue;

		let entries: Dirent[];
		try {
			entries = readdirSync(repoPath, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const fullPath = join(repoPath, entry.name);

			if (entry.isFile() && /\.[tj]s$/.test(entry.name)) {
				results.push({ repoName: repo.name, repoPath: repoPath, name: entry.name, absolutePath: fullPath });
			} else if (entry.isDirectory() && isExtensionDir(fullPath)) {
				results.push({ repoName: repo.name, repoPath: repoPath, name: entry.name, absolutePath: fullPath });
			}
		}
	}

	return results.sort((a, b) => a.repoName.localeCompare(b.repoName) || a.name.localeCompare(b.name));
}

function loadRepos(...paths: string[]): RepoConfig[] {
	const seen = new Set<string>();
	const repos: RepoConfig[] = [];

	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			const raw = JSON.parse(readFileSync(p, "utf-8"));
			if (!Array.isArray(raw)) continue;
			for (const entry of raw) {
				if (typeof entry?.name !== "string" || typeof entry?.path !== "string") continue;
				const key = resolve(entry.path);
				if (seen.has(key)) continue;
				seen.add(key);
				repos.push({ name: entry.name, path: key });
			}
		} catch {
			// Malformed config — skip
		}
	}

	return repos;
}

function isExtensionDir(dirPath: string): boolean {
	if (existsSync(join(dirPath, "index.ts")) || existsSync(join(dirPath, "index.js"))) return true;

	const pkgPath = join(dirPath, "package.json");
	if (!existsSync(pkgPath)) return false;
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		return !!pkg.pi?.extensions;
	} catch {
		return false;
	}
}
