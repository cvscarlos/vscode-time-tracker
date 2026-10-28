import type { ChromeSegment } from './tracker.ts';

const ELLIPSIS = ', …';
// SolidTime rejects descriptions over 500 characters; the connector appends ` [chr:<uuid>]`.
const MARKER_LENGTH = ' [chr:]'.length + crypto.randomUUID().length;
const DESCRIPTION_LIMIT = 500 - MARKER_LENGTH;

/**
 * The SolidTime entry description: each host the time was spent on, most time
 * first, with its matched rules when they differ from the host.
 */
export function describeSites(segments: ChromeSegment[], maxLength = DESCRIPTION_LIMIT): string {
	const sites = new Map<string, { rules: Set<string>; ms: number }>();
	for (const { host, rule, activeMilliseconds } of segments) {
		const site = sites.get(host) ?? { rules: new Set<string>(), ms: 0 };
		site.ms += activeMilliseconds;
		if (rule !== host) {
			site.rules.add(rule);
		}
		sites.set(host, site);
	}
	const items = [...sites]
		// eslint-disable-next-line unicorn/no-array-sort -- freshly derived array copy; toSorted needs the ES2023 lib
		.sort(([hostA, a], [hostB, b]) => b.ms - a.ms || hostA.localeCompare(hostB))
		.map(([host, { rules }]) => (rules.size === 0 ? host : `${host} (${[...rules].join(', ')})`));

	const full = items.join(', ');
	if (full.length <= maxLength) {
		return full;
	}
	let kept = '';
	for (const item of items) {
		const next = kept ? `${kept}, ${item}` : item;
		if (next.length + ELLIPSIS.length > maxLength) {
			break;
		}
		kept = next;
	}
	return `${kept}${ELLIPSIS}`;
}
