import { LocalSegment } from '../tracker/types';

export interface DeliveryBlock {
	segmentIds: string[];
	start: string;
	end: string;
	workspaceKey: string;
	projectName: string;
	branch?: string;
	focusMinutes: number;
	idleMinutes: number;
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

export interface AggregateResult {
	blocks: DeliveryBlock[];
	/**
	 * Segment ids whose block was SETTLED (its window closed) but rounded to
	 * under a minute. These can never grow into a deliverable block, so they are
	 * safe to discard permanently. Unsettled/held segments are never included —
	 * only a settled-but-too-short block is safe to give up on.
	 */
	discarded: string[];
}

// A settled block that rounds to under a minute is discarded (not held) — it can
// never grow, since its window already closed.
type BuildResult =
	| { kind: 'block'; block: DeliveryBlock }
	| { kind: 'held' }
	| { kind: 'discarded'; segmentIds: string[] };

function buildBlock(segments: LocalSegment[], options: AggregateOptions): BuildResult {
	const lastSegment = segments.at(-1);
	if (!lastSegment) {
		return { kind: 'held' };
	}
	const lastEnd = Date.parse(lastSegment.end);
	if (options.nowMs - lastEnd < options.settleMs) {
		return { kind: 'held' }; // not settled yet — hold
	}
	const start = roundMinute(Date.parse(segments[0].start));
	const end = roundMinute(lastEnd);
	if (end - start < MINUTE_MS) {
		// Settled but rounds to less than a whole minute — never deliverable.
		return { kind: 'discarded', segmentIds: segments.map((segment) => segment.id) };
	}
	const first = segments[0];
	const idleMs = segments.reduce((sum, segment) => sum + (segment.idleMilliseconds ?? 0), 0);
	const totalMinutes = (end - start) / MINUTE_MS;
	const idleMinutes = Math.min(totalMinutes, Math.round(idleMs / MINUTE_MS));
	const focusMinutes = totalMinutes - idleMinutes;
	return {
		kind: 'block',
		block: {
			segmentIds: segments.map((segment) => segment.id),
			start: new Date(start).toISOString(),
			end: new Date(end).toISOString(),
			workspaceKey: first.workspaceKey,
			projectName: first.projectName,
			branch: first.branch,
			focusMinutes,
			idleMinutes,
		},
	};
}

export function aggregate(segments: LocalSegment[], options: AggregateOptions): AggregateResult {
	const groups = new Map<string, LocalSegment[]>();
	// eslint-disable-next-line unicorn/prefer-group-by -- Map.groupBy is ES2024; tsconfig lib is ES2022
	for (const segment of segments) {
		const key = groupKey(segment);
		const list = groups.get(key) ?? [];
		list.push(segment);
		groups.set(key, list);
	}

	const results: BuildResult[] = [];
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
					results.push(buildBlock(current, options));
				}
				current = [segment];
			}
			currentEndMs = Date.parse(segment.end);
		}
		if (current.length > 0) {
			results.push(buildBlock(current, options));
		}
	}

	const blocks: DeliveryBlock[] = [];
	const discarded: string[] = [];
	for (const result of results) {
		if (result.kind === 'block') {
			blocks.push(result.block);
		} else if (result.kind === 'discarded') {
			discarded.push(...result.segmentIds);
		}
	}
	return { blocks, discarded };
}
