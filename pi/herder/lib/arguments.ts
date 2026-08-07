export interface FireOptions {
	mode: "fire" | "resume";
	planDir: string;
	profile?: string;
	maxParallel?: number;
	dashboardPort: number;
}

export interface PlanDirOptions {
	planDir?: string;
}

export function tokenizeArguments(input: string): string[] {
	const tokens: string[] = [];
	let token = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	let started = false;
	for (const character of input) {
		if (escaped) {
			token += character;
			escaped = false;
			started = true;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			started = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = null;
			else token += character;
			started = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/.test(character)) {
			if (started) {
				tokens.push(token);
				token = "";
				started = false;
			}
			continue;
		}
		token += character;
		started = true;
	}
	if (escaped) throw new Error("Arguments end with an incomplete escape.");
	if (quote) throw new Error("Arguments contain an unterminated quote.");
	if (started) tokens.push(token);
	return tokens;
}

function valueAfter(tokens: string[], index: number, option: string): string {
	const value = tokens[index + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value.`);
	return value;
}

function positiveInteger(value: string, option: string, maximum: number): number {
	if (!/^\d+$/.test(value)) throw new Error(`${option} must be a positive integer.`);
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
		throw new Error(`${option} must be between 1 and ${maximum}.`);
	}
	return parsed;
}

function port(value: string): number {
	if (!/^\d+$/.test(value)) throw new Error("--dashboard-port must be an integer from 0 through 65535.");
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
		throw new Error("--dashboard-port must be an integer from 0 through 65535.");
	}
	return parsed;
}

export function parseFireArguments(input: string, mode: "fire" | "resume"): FireOptions {
	const tokens = tokenizeArguments(input);
	let planDir = "herder-plans";
	let profile: string | undefined;
	let maxParallel: number | undefined;
	let dashboardPort = 0;
	let positional = false;

	for (let index = 0; index < tokens.length; index += 1) {
		const argument = tokens[index]!;
		if (["--profile", "--max-parallel", "--dashboard-port"].includes(argument)) {
			const value = valueAfter(tokens, index, argument);
			index += 1;
			if (argument === "--profile") {
				if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new Error("--profile is not a valid profile name.");
				profile = value;
			} else if (argument === "--max-parallel") maxParallel = positiveInteger(value, argument, 32);
			else dashboardPort = port(value);
		} else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
		else if (positional) throw new Error(`Unexpected argument: ${argument}`);
		else {
			planDir = argument;
			positional = true;
		}
	}

	return { mode, planDir, ...(profile ? { profile } : {}), ...(maxParallel === undefined && mode === "resume" ? {} : { maxParallel: maxParallel ?? 5 }), dashboardPort };
}

export function parsePlanDirArguments(input: string): PlanDirOptions {
	const tokens = tokenizeArguments(input);
	if (tokens.length > 1) throw new Error("Expected at most one plan directory.");
	if (tokens[0]?.startsWith("--")) throw new Error(`Unknown option: ${tokens[0]}`);
	return tokens[0] ? { planDir: tokens[0] } : {};
}
