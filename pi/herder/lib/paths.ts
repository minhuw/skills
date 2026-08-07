import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export function resolvePlanDirectory(repoRoot: string, input: string): string {
	const canonicalRepo = realpathSync(repoRoot);
	const candidate = path.resolve(canonicalRepo, input);
	let canonicalPlan: string;
	try {
		canonicalPlan = realpathSync(candidate);
	} catch {
		throw new Error(`Herder plan directory does not exist: ${candidate}`);
	}
	if (!statSync(canonicalPlan).isDirectory()) throw new Error(`Herder plan path is not a directory: ${canonicalPlan}`);
	const relative = path.relative(canonicalRepo, canonicalPlan);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Herder plan directory must stay inside the repository: ${canonicalPlan}`);
	}
	return canonicalPlan;
}
