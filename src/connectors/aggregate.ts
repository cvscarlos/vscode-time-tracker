import { LocalSegment } from '../tracker/types';

export interface DeliveryBlock {
	segmentIds: string[];
	start: string;
	end: string;
	workspaceKey: string;
	projectName: string;
	branch?: string;
}

export interface AggregateOptions {
	nowMs: number;
	settleMs: number;
	mergeGapMs: number;
}

const MINUTE_MS = 60_000;

// Round to nearest minute (not floor-start/ceil-end): raw segments never overlap and
// rounding is monotonic, so adjacent entries meet at a minute instead of overlapping.
function roundMinute(ms: number): number {
	return Math.round(ms / MINUTE_MS) * MINUTE_MS;
}

function groupKey(segment: LocalSegment): string {
	return `${segment.workspaceKey}::${segment.branch ?? ''}`;
}

function buildBlock(
	segments: LocalSegment[],
	options: AggregateOptions
): DeliveryBlock | undefined {
	const lastSegment = segments.at(-1);
	if (!lastSegment) {
		return undefined;
	}
	const lastEnd = Date.parse(lastSegment.end);
	if (options.nowMs - lastEnd < options.settleMs) {
		return undefined; // not settled yet — hold
	}
	const start = roundMinute(Date.parse(segments[0].start));
	const end = roundMinute(lastEnd);
	if (end - start < MINUTE_MS) {
		return undefined; // rounds to less than a whole minute
	}
	const first = segments[0];
	return {
		segmentIds: segments.map((segment) => segment.id),
		start: new Date(start).toISOString(),
		end: new Date(end).toISOString(),
		workspaceKey: first.workspaceKey,
		projectName: first.projectName,
		branch: first.branch,
	};
}

export function aggregate(segments: LocalSegment[], options: AggregateOptions): DeliveryBlock[] {
	const groups = new Map<string, LocalSegment[]>();
	for (const segment of segments) {
		const key = groupKey(segment);
		const list = groups.get(key) ?? [];
		list.push(segment);
		groups.set(key, list);
	}

	const blocks: (DeliveryBlock | undefined)[] = [];
	for (const list of groups.values()) {
		// eslint-disable-next-line unicorn/no-array-sort -- freshly derived array copy, safe to mutate in place
		const sorted = [...list].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

		let current: LocalSegment[] = [];
		let currentEndMs = 0;
		for (const segment of sorted) {
			if (current.length > 0 && Date.parse(segment.start) - currentEndMs <= options.mergeGapMs) {
				current.push(segment);
			} else {
				if (current.length > 0) {
					blocks.push(buildBlock(current, options));
				}
				current = [segment];
			}
			currentEndMs = Date.parse(segment.end);
		}
		if (current.length > 0) {
			blocks.push(buildBlock(current, options));
		}
	}

	return blocks.filter((block): block is DeliveryBlock => block !== undefined);
}
