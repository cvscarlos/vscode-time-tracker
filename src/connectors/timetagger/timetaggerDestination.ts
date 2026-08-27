import { breakdownSuffix, DeliveryBlock, TimeDestination, TitleCtx } from '../destination';
import { TimetaggerClient } from './timetaggerClient';

export function toTag(value: string): string {
	return value.trim().replace(/^#+/, '').replaceAll(/\s+/g, '-');
}

function describe(text: string, projectName: string, branch: string | undefined): string {
	const tags = branch ? ` #${toTag(projectName)} #${toTag(branch)}` : ` #${toTag(projectName)}`;
	return `${text}${tags}`;
}

export class TimetaggerDestination implements TimeDestination {
	readonly id = 'timetagger';
	readonly label = 'TimeTagger';

	constructor(
		private readonly client: TimetaggerClient,
		private readonly now: () => number = () => Date.now()
	) {}

	async prepare(): Promise<void> {
		// Idempotent by record key — no per-run state to fetch.
	}

	async deliver(block: DeliveryBlock): Promise<string> {
		const key = block.segmentIds[0];
		const text = `${block.branch ?? block.projectName}${breakdownSuffix(block.focusMinutes, block.idleMinutes)}`;
		await this.client.putRecords([
			{
				key,
				t1: Math.floor(Date.parse(block.start) / 1000),
				t2: Math.ceil(Date.parse(block.end) / 1000),
				mt: Math.floor(this.now() / 1000),
				st: 0,
				ds: describe(text, block.projectName, block.branch),
			},
		]);
		return key;
	}

	async retitle(ref: string, title: string, ctx: TitleCtx): Promise<void> {
		if (ref === '') {
			return;
		}
		const text = `${title}${breakdownSuffix(ctx.focusMinutes, ctx.idleMinutes)}`;
		await this.client.putRecords([
			{
				key: ref,
				t1: Math.floor(ctx.startMs / 1000),
				t2: Math.ceil(ctx.endMs / 1000),
				mt: Math.floor(this.now() / 1000),
				st: 0,
				ds: describe(text, ctx.projectName, ctx.branch),
			},
		]);
	}
}
