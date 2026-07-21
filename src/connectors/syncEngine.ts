import { ConnectorError, EntryInput, TimeSyncConnector } from './connector';
import { MappingStore } from './mappingStore';
import { Store } from '../tracker/storage/store';
import { LocalSegment } from '../tracker/types';

export interface SyncEngineDeps {
	store: Store;
	connector: TimeSyncConnector;
	mappings: MappingStore;
	projectNameFor: (segment: LocalSegment) => string;
	taskNameFor: (segment: LocalSegment) => string | null;
	log: (message: string) => void;
	onStatus: (pending: number, error: boolean) => void;
}

export class SyncEngine {
	constructor(private readonly deps: SyncEngineDeps) {}

	async runOnce(): Promise<void> {
		const { store, connector, log, onStatus } = this.deps;
		const undelivered = store.listUndelivered();
		onStatus(undelivered.length, false);
		if (undelivered.length === 0) {
			return;
		}
		try {
			const { organizationId, memberId } = await connector.resolveMember();
			let since = undelivered[0].start;
			for (const segment of undelivered) {
				if (segment.start < since) {
					since = segment.start;
				}
			}
			const present = await connector.listEntryMarkers(organizationId, memberId, since);

			for (const segment of undelivered) {
				if (!store.claim(segment.id)) {
					continue;
				}
				if (present.has(segment.id)) {
					store.markDelivered(segment.id);
					continue;
				}
				try {
					const projectId = await this.resolveProject(organizationId, segment);
					const taskId = await this.resolveTask(organizationId, projectId, segment);
					const entry: EntryInput = {
						segmentId: segment.id,
						start: segment.start,
						end: segment.end,
						projectId,
						taskId,
						description: 'VS Code',
					};
					await connector.createEntry(organizationId, memberId, entry);
					store.markDelivered(segment.id);
					log(`delivered ${segment.projectName} ${segment.branch ?? ''} (${segment.id})`);
				} catch (error) {
					if (error instanceof ConnectorError && error.retryable) {
						throw error; // abort run, retry whole thing next tick
					}
					log(`skipped ${segment.id}: ${String(error)}`);
				}
			}
			store.compact();
			onStatus(store.listUndelivered().length, false);
		} catch (error) {
			const authHint =
				error instanceof ConnectorError && error.status === 401
					? ' (check your API token: "cvs Time Tracker: Set solidtime API Token")'
					: '';
			log(`sync failed: ${String(error)}${authHint}`);
			onStatus(store.listUndelivered().length, true);
		}
	}

	private async resolveProject(organizationId: string, segment: LocalSegment): Promise<string> {
		const { mappings, connector, projectNameFor } = this.deps;
		const cached = mappings.getProjectId(segment.workspaceKey);
		if (cached) {
			return cached;
		}
		const name = projectNameFor(segment);
		const found =
			(await connector.findProjectByName(organizationId, name)) ??
			(await connector.createProject(organizationId, name));
		await mappings.setProjectId(segment.workspaceKey, found);
		return found;
	}

	private async resolveTask(
		organizationId: string,
		projectId: string,
		segment: LocalSegment
	): Promise<string | null> {
		const { mappings, connector, taskNameFor } = this.deps;
		const name = taskNameFor(segment);
		if (!name || !segment.branch) {
			// eslint-disable-next-line unicorn/no-null -- EntryInput contract uses null for "no task"
			return null;
		}
		const cached = mappings.getTaskId(segment.workspaceKey, segment.branch);
		if (cached) {
			return cached;
		}
		const found =
			(await connector.findTaskByName(organizationId, projectId, name)) ??
			(await connector.createTask(organizationId, projectId, name));
		await mappings.setTaskId(segment.workspaceKey, segment.branch, found);
		return found;
	}
}
