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
	onStatus: (pending: number, hasError: boolean) => void;
	onDelivered?: (destinationId: string, ref: string, block: DeliveryBlock) => void;
}

export class SyncEngine {
	constructor(private readonly deps: SyncEngineDeps) {}

	private async prepareDestinations(
		since: string
	): Promise<{ active: TimeDestination[]; anyError: boolean }> {
		const { destinations, log } = this.deps;
		let isAnyError = false;
		const active: TimeDestination[] = [];
		for (const dest of destinations) {
			try {
				await dest.prepare(since);
				active.push(dest);
			} catch (error) {
				isAnyError = true;
				log(`${dest.label} unavailable: ${String(error)}${this.authHint(dest, error)}`);
			}
		}
		return { active, anyError: isAnyError };
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
		let isAnyError = false;
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
				// Every delivery failure is an error for this run — including
				// non-retryable ones (e.g. a 401), which were previously logged as a
				// silent "skip" while the run and destination status stayed healthy.
				isAnyError = true;
				const isRetryable = error instanceof ConnectorError && error.isRetryable;
				const isUnauthorized = error instanceof ConnectorError && error.status === 401;
				if (isRetryable || isUnauthorized) {
					disabled.add(dest.id); // stop hammering this destination for the rest of the run
				}
				if (isUnauthorized) {
					log(`${dest.label} skipped ${markerId}: ${String(error)}${this.authHint(dest, error)}`);
				} else if (!isRetryable) {
					log(`${dest.label} skipped ${markerId}: ${String(error)}`);
				}
			}
		}
		return isAnyError;
	}

	private authHint(dest: TimeDestination, error: unknown): string {
		if (error instanceof ConnectorError && error.status === 401) {
			const command =
				dest.id === 'timetagger'
					? 'Time Tracker nt: Set TimeTagger Token'
					: 'Time Tracker nt: Set SolidTime Token';
			return ` (check your API token: "${command}")`;
		}
		return '';
	}

	async runOnce(): Promise<void> {
		const { store, destinations, log, onStatus } = this.deps;
		const enabledIds = destinations.map((d) => d.id);
		const undelivered = store.listUndelivered(enabledIds);
		const { blocks, discarded } = aggregate(undelivered, {
			nowMs: this.deps.now(),
			settleMs: this.deps.settleMs,
			mergeGapMs: this.deps.mergeGapMs,
		});
		log(`sync: ${undelivered.length} undelivered, ${blocks.length} block(s) ready`);
		onStatus(undelivered.length, false);
		if (destinations.length === 0 || (blocks.length === 0 && discarded.length === 0)) {
			return;
		}

		let isAnyError = false;
		if (blocks.length > 0) {
			let since = blocks[0].start;
			for (const block of blocks) {
				if (block.start < since) {
					since = block.start;
				}
			}

			const { active, anyError: prepareError } = await this.prepareDestinations(since);
			isAnyError = prepareError;

			const disabled = new Set<string>();
			for (const block of blocks) {
				isAnyError = (await this.deliverBlock(block, active, disabled)) || isAnyError;
			}
		}

		// Segments whose block settled but rounded to under a minute can never grow
		// into a deliverable block. Mark them delivered to every enabled
		// destination so compact() drops them instead of rescanning them forever.
		for (const id of discarded) {
			for (const dest of destinations) {
				store.markDelivered(id, dest.id);
			}
		}

		store.compact(enabledIds);
		onStatus(store.listUndelivered(enabledIds).length, isAnyError);
	}
}
