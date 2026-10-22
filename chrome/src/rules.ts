export type Rules = { project: string; patterns: string[] }[];

export interface RuleMatch {
	project: string;
	host: string;
	/** The pattern exactly as the user wrote it. */
	rule: string;
}

export function parseRules(json: string): Rules {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch (error) {
		throw new Error(`Rules are not valid JSON: ${(error as Error).message}`);
	}
	if (typeof data !== 'object' || data === null || Array.isArray(data)) {
		throw new Error('Rules must be a JSON object: { "project": ["pattern", ...] }');
	}
	return Object.entries(data).map(([project, patterns]) => {
		if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== 'string')) {
			throw new Error(`Rules for "${project}" must be a list of pattern strings`);
		}
		return { project, patterns };
	});
}

export function matchUrl(url: string | undefined, rules: Rules): RuleMatch | undefined {
	if (!url || !URL.canParse(url)) {
		return undefined;
	}
	const parsed = new URL(url);
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return undefined;
	}
	const host = parsed.hostname.toLowerCase();
	for (const { project, patterns } of rules) {
		const rule = patterns.find((pattern) => isPatternMatch(pattern, parsed, host));
		if (rule !== undefined) {
			return { project, host, rule };
		}
	}
	return undefined;
}

function isPatternMatch(pattern: string, url: URL, host: string): boolean {
	const normalized = pattern
		.trim()
		.toLowerCase()
		.replace(/^[a-z]+:\/\//, '')
		.replace(/\/+$/, '');
	const slash = normalized.indexOf('/');
	const hostPart = slash === -1 ? normalized : normalized.slice(0, slash);
	const pathPart = slash === -1 ? '' : normalized.slice(slash);
	const [patternHost, patternPort] = hostPart.split(':', 2);
	if (patternPort !== undefined && patternPort !== url.port) {
		return false;
	}
	if (!isLabelsMatch(patternHost.split('.'), host.split('.'))) {
		return false;
	}
	const path = url.pathname.toLowerCase();
	return pathPart === '' || path === pathPart || path.startsWith(`${pathPart}/`);
}

// A label that is exactly `*` matches zero or more host labels.
function isLabelsMatch(pattern: string[], host: string[]): boolean {
	const [first, ...rest] = pattern;
	if (first === undefined) {
		return host.length === 0;
	}
	return first === '*'
		? isLabelsMatch(rest, host) || (host.length > 0 && isLabelsMatch(pattern, host.slice(1)))
		: host.length > 0 && isLabelMatch(first, host[0]) && isLabelsMatch(rest, host.slice(1));
}

// A `*` inside a label matches any characters within that one label.
function isLabelMatch(pattern: string, label: string): boolean {
	if (!pattern.includes('*')) {
		return pattern === label;
	}
	const source = pattern
		.split('*')
		.map((part) => part.replaceAll(/[.+?^${}()|[\]\\-]/g, String.raw`\$&`))
		.join('[^.]*');
	return new RegExp(`^${source}$`).test(label);
}
