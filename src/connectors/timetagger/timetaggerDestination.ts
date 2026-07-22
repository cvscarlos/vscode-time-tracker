import { DeliveryBlock, TimeDestination, TitleCtx } from '../destination';
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
		await this.client.putRecords([
			{
				key,
				t1: Math.floor(Date.parse(block.start) / 1000),
				t2: Math.ceil(Date.parse(block.end) / 1000),
				mt: Math.floor(this.now() / 1000),
				st: 0,
				ds: describe(block.branch ?? block.projectName, block.projectName, block.branch),
			},
		]);
		return key;
	}

	async retitle(ref: string, title: string, ctx: TitleCtx): Promise<void> {
		if (ref === '') {
			return;
		}
		await this.client.putRecords([
			{
				key: ref,
				t1: Math.floor(ctx.startMs / 1000),
				t2: Math.ceil(ctx.endMs / 1000),
				mt: Math.floor(this.now() / 1000),
				st: 0,
				ds: describe(title, ctx.projectName, ctx.branch),
			},
		]);
	}
}
