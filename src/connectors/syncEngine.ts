import { aggregate, DeliveryBlock } from './aggregate';
import { ConnectorError } from './connector';
import { TimeDestination } from './destination';
import { Store } from '../tracker/storage/store';

export interface SyncEngineDeps {
	store: Store;
	destinations: TimeDestination[];
	now: () => number;
	settleMs: number;
	mergeGapMs: number;
	log: (message: string) => void;
	onStatus: (pending: number, error: boolean) => void;
	onDelivered?: (destinationId: string, ref: string, block: DeliveryBlock) => void;
}

export class SyncEngine {
	constructor(private readonly deps: SyncEngineDeps) {}

	async runOnce(): Promise<void> {
		const { store, destinations, log, onStatus } = this.deps;
		const enabledIds = destinations.map((d) => d.id);
		const undelivered = store.listUndelivered(enabledIds);
		const blocks = aggregate(undelivered, {
			nowMs: this.deps.now(),
			settleMs: this.deps.settleMs,
			mergeGapMs: this.deps.mergeGapMs,
		});
		log(`sync: ${undelivered.length} undelivered, ${blocks.length} block(s) ready`);
		onStatus(undelivered.length, false);
		if (blocks.length === 0 || destinations.length === 0) {
			return;
		}

		let since = blocks[0].start;
		for (const block of blocks) {
			if (block.start < since) {
				since = block.start;
			}
		}

		const { active, anyError: prepareError } = await this.prepareDestinations(since);
		let anyError = prepareError;

		const disabled = new Set<string>();
		for (const block of blocks) {
			anyError = (await this.deliverBlock(block, active, disabled)) || anyError;
		}

		store.compact(enabledIds);
		onStatus(store.listUndelivered(enabledIds).length, anyError);
	}

	private async prepareDestinations(
		since: string
	): Promise<{ active: TimeDestination[]; anyError: boolean }> {
		const { destinations, log } = this.deps;
		let anyError = false;
		const active: TimeDestination[] = [];
		for (const dest of destinations) {
			try {
				await dest.prepare(since);
				active.push(dest);
			} catch (error) {
				anyError = true;
				log(`${dest.label} unavailable: ${String(error)}${this.authHint(dest, error)}`);
			}
		}
		return { active, anyError };
	}

	private async deliverBlock(
		block: DeliveryBlock,
		active: TimeDestination[],
		disabled: Set<string>
	): Promise<boolean> {
		const { store, log } = this.deps;
		const markerId = block.segmentIds[0];
		if (!store.claim(markerId)) {
			return false;
		}
		let anyError = false;
		for (const dest of active) {
			if (disabled.has(dest.id) || store.isDelivered(markerId, dest.id)) {
				continue;
			}
			try {
				const ref = await dest.deliver(block);
				this.deps.onDelivered?.(dest.id, ref, block);
				for (const id of block.segmentIds) {
					store.markDelivered(id, dest.id);
				}
				log(
					`${dest.label} delivered ${block.projectName} ${block.branch ?? ''} ${block.start}..${block.end}`
				);
			} catch (error) {
				if (error instanceof ConnectorError && error.retryable) {
					anyError = true;
					disabled.add(dest.id); // stop hammering a down backend this run
				} else {
					log(`${dest.label} skipped ${markerId}: ${String(error)}`);
				}
			}
		}
		return anyError;
	}

	private authHint(dest: TimeDestination, error: unknown): string {
		if (error instanceof ConnectorError && error.status === 401) {
			const command =
				dest.id === 'timetagger'
					? 'Time Tracker nt: Set TimeTagger Token'
					: 'Time Tracker nt: Set solidtime Token';
			return ` (check your API token: "${command}")`;
		}
		return '';
	}
}
