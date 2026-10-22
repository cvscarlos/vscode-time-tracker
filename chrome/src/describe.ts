import type { ChromeSegment } from './tracker.ts';

const ELLIPSIS = ', …';

/**
 * The SolidTime entry description: each host the time was spent on, most time
 * first, with its matched rule when that differs from the host. 480 leaves room
 * for the ` [chr:<uuid>]` marker the connector appends.
 */
export function describeSites(segments: ChromeSegment[], maxLength = 480): string {
	const sites = new Map<string, { rule: string; ms: number }>();
	for (const { host, rule, activeMilliseconds } of segments) {
		const site = sites.get(host) ?? { rule, ms: 0 };
		site.ms += activeMilliseconds;
		sites.set(host, site);
	}
	const items = [...sites]
		// eslint-disable-next-line unicorn/no-array-sort -- freshly derived array copy; toSorted needs the ES2023 lib
		.sort(([hostA, a], [hostB, b]) => b.ms - a.ms || hostA.localeCompare(hostB))
		.map(([host, { rule }]) => (rule === host ? host : `${host} (${rule})`));

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
