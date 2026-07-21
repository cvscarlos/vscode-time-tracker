import { aggregate, DeliveryBlock } from './aggregate';
import { ConnectorError, EntryInput, TimeSyncConnector } from './connector';
import { MappingStore } from './mappingStore';
import { Store } from '../tracker/storage/store';

export interface SyncEngineDeps {
	store: Store;
	connector: TimeSyncConnector;
	mappings: MappingStore;
	now: () => number;
	settleMs: number;
	mergeGapMs: number;
	log: (message: string) => void;
	onStatus: (pending: number, error: boolean) => void;
	onDelivered?: (entryId: string, block: DeliveryBlock) => void;
}

export class SyncEngine {
	constructor(private readonly deps: SyncEngineDeps) {}

	async runOnce(): Promise<void> {
		const { store, connector, log, onStatus } = this.deps;
		const undelivered = store.listUndelivered();
		const blocks = aggregate(undelivered, {
			nowMs: this.deps.now(),
			settleMs: this.deps.settleMs,
			mergeGapMs: this.deps.mergeGapMs,
		});
		log(`sync: ${undelivered.length} undelivered, ${blocks.length} block(s) ready`);
		onStatus(undelivered.length, false);
		if (blocks.length === 0) {
			return; // segments held until settled
		}
		try {
			const { organizationId, memberId } = await connector.resolveMember();
			let since = blocks[0].start;
			for (const block of blocks) {
				if (block.start < since) {
					since = block.start;
				}
			}
			const present = await connector.listEntryMarkers(organizationId, memberId, since);

			for (const block of blocks) {
				const markerId = block.segmentIds[0];
				if (!store.claim(markerId)) {
					continue;
				}
				// Re-check delivery AFTER claiming: a delivered tombstone does not
				// block a claim, so another window may have delivered this block
				// between our listUndelivered() snapshot and this claim. Sending
				// again would create a duplicate.
				if (store.isDelivered(markerId) || present.has(markerId)) {
					for (const id of block.segmentIds) {
						store.markDelivered(id);
					}
					continue;
				}
				try {
					const projectId = await this.resolveProject(
						organizationId,
						block.workspaceKey,
						block.projectName
					);
					const taskId = await this.resolveTask(
						organizationId,
						projectId,
						block.workspaceKey,
						block.branch
					);
					const entry: EntryInput = {
						segmentId: markerId,
						start: block.start,
						end: block.end,
						projectId,
						taskId,
						description: block.branch ?? block.projectName,
					};
					const entryId = await connector.createEntry(organizationId, memberId, entry);
					this.deps.onDelivered?.(entryId, block);
					for (const id of block.segmentIds) {
						store.markDelivered(id);
					}
					log(`delivered ${block.projectName} ${block.branch ?? ''} ${block.start}..${block.end}`);
				} catch (error) {
					if (error instanceof ConnectorError && error.retryable) {
						throw error; // abort run, retry whole thing next tick
					}
					log(`skipped ${markerId}: ${String(error)}`);
				}
			}
			store.compact();
			onStatus(store.listUndelivered().length, false);
		} catch (error) {
			const authHint =
				error instanceof ConnectorError && error.status === 401
					? ' (check your API token: "Time Tracker nt: Set solidtime API Token")'
					: '';
			log(`sync failed: ${String(error)}${authHint}`);
			onStatus(store.listUndelivered().length, true);
		}
	}

	private async resolveProject(
		organizationId: string,
		workspaceKey: string,
		projectName: string
	): Promise<string> {
		const { mappings, connector } = this.deps;
		const cached = mappings.getProjectId(workspaceKey);
		if (cached) {
			return cached;
		}
		const found =
			(await connector.findProjectByName(organizationId, projectName)) ??
			(await connector.createProject(organizationId, projectName));
		await mappings.setProjectId(workspaceKey, found);
		return found;
	}

	private async resolveTask(
		organizationId: string,
		projectId: string,
		workspaceKey: string,
		branch: string | undefined
	): Promise<string | null> {
		const { mappings, connector } = this.deps;
		if (!branch) {
			// eslint-disable-next-line unicorn/no-null -- EntryInput contract uses null for "no task"
			return null;
		}
		const cached = mappings.getTaskId(workspaceKey, branch);
		if (cached) {
			return cached;
		}
		const found =
			(await connector.findTaskByName(organizationId, projectId, branch)) ??
			(await connector.createTask(organizationId, projectId, branch));
		await mappings.setTaskId(workspaceKey, branch, found);
		return found;
	}
}
