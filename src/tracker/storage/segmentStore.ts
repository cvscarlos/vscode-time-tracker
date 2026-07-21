import { LocalSegment } from '../types';

export class SegmentStore {
	private readonly segments = new Map<string, LocalSegment>();

	add(segment: LocalSegment): void {
		this.segments.set(segment.id, segment);
	}

	all(): LocalSegment[] {
		return [...this.segments.values()];
	}

	totalMillisecondsOn(dateIso: string): number {
		let total = 0;
		for (const segment of this.segments.values()) {
			if (segment.start.slice(0, 10) === dateIso) {
				total += segment.activeMilliseconds;
			}
		}
		return total;
	}

	totalMillisecondsByProjectOn(dateIso: string): Map<string, number> {
		const totals = new Map<string, number>();
		for (const segment of this.segments.values()) {
			if (segment.start.slice(0, 10) !== dateIso) {
				continue;
			}
			totals.set(
				segment.projectName,
				(totals.get(segment.projectName) ?? 0) + segment.activeMilliseconds
			);
		}
		return totals;
	}
}
