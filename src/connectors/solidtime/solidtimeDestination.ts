import { DeliveryBlock, markerFor, TimeDestination, TitleCtx } from '../destination';
import { ConnectorError, EntryInput } from '../connector';
import { MappingStore } from '../mappingStore';

export interface SolidtimeConnectorLike {
	resolveMember(): Promise<{ organizationId: string; memberId: string }>;
	listEntryMarkers(
		organizationId: string,
		memberId: string,
		sinceIso: string
	): Promise<Set<string>>;
	findProjectByName(organizationId: string, name: string): Promise<string | null>;
	createProject(organizationId: string, name: string): Promise<string>;
	findTaskByName(organizationId: string, projectId: string, name: string): Promise<string | null>;
	createTask(organizationId: string, projectId: string, name: string): Promise<string>;
	createEntry(organizationId: string, memberId: string, entry: EntryInput): Promise<string>;
	updateEntryDescription(
		organizationId: string,
		entryId: string,
		description: string
	): Promise<void>;
}

export class SolidtimeDestination implements TimeDestination {
	private organizationId = '';
	private memberId = '';
	private present = new Set<string>();
	readonly id = 'solidtime';
	readonly label = 'SolidTime';

	constructor(
		private readonly connector: SolidtimeConnectorLike,
		private readonly mappings: MappingStore,
		private readonly apiUrl: string
	) {}

	/**
	 * Prefix a workspace key with the resolved server + organization so mapping
	 * ids never leak across a `solidtime.apiUrl`/account/`organizationId` switch
	 * — otherwise a deleted/stale id from the previous backend 404/422s forever.
	 */
	private scopedKey(workspaceKey: string): string {
		const scope = `${this.apiUrl}#${this.organizationId}`;
		return `${scope}:${workspaceKey}`;
	}

	private async resolveProject(workspaceKey: string, projectName: string): Promise<string> {
		const scopedKey = this.scopedKey(workspaceKey);
		const cached = this.mappings.getProjectId(scopedKey);
		if (cached) {
			return cached;
		}
		const found =
			(await this.connector.findProjectByName(this.organizationId, projectName)) ??
			(await this.connector.createProject(this.organizationId, projectName));
		await this.mappings.setProjectId(scopedKey, found);
		return found;
	}

	private async resolveTask(
		projectId: string,
		workspaceKey: string,
		branch: string | undefined
	): Promise<string | null> {
		if (!branch) {
			// eslint-disable-next-line unicorn/no-null -- EntryInput contract uses null for "no task"
			return null;
		}
		const scopedKey = this.scopedKey(workspaceKey);
		const cached = this.mappings.getTaskId(scopedKey, branch);
		if (cached) {
			return cached;
		}
		const found =
			(await this.connector.findTaskByName(this.organizationId, projectId, branch)) ??
			(await this.connector.createTask(this.organizationId, projectId, branch));
		await this.mappings.setTaskId(scopedKey, branch, found);
		return found;
	}

	async prepare(sinceIso: string): Promise<void> {
		const { organizationId, memberId } = await this.connector.resolveMember();
		this.organizationId = organizationId;
		this.memberId = memberId;
		this.present = await this.connector.listEntryMarkers(organizationId, memberId, sinceIso);
	}

	async deliver(block: DeliveryBlock): Promise<string> {
		const markerId = block.segmentIds[0];
		if (this.present.has(markerId)) {
			return '';
		}
		const projectId = await this.resolveProject(block.workspaceKey, block.projectName);
		const taskId = await this.resolveTask(projectId, block.workspaceKey, block.branch);
		const entry: EntryInput = {
			segmentId: markerId,
			start: block.start,
			end: block.end,
			projectId,
			taskId,
			description: block.branch ?? block.projectName,
		};
		try {
			return await this.connector.createEntry(this.organizationId, this.memberId, entry);
		} catch (error) {
			// A stale/deleted project or task id 404s or 422s forever otherwise —
			// evict it so the next delivery attempt re-resolves (find-or-create).
			if (error instanceof ConnectorError && (error.status === 404 || error.status === 422)) {
				const scopedKey = this.scopedKey(block.workspaceKey);
				await this.mappings.clearProjectId(scopedKey);
				if (block.branch) {
					await this.mappings.clearTaskId(scopedKey, block.branch);
				}
			}
			throw error;
		}
	}

	async retitle(ref: string, title: string, ctx: TitleCtx): Promise<void> {
		if (ref === '') {
			return;
		}
		await this.connector.updateEntryDescription(
			this.organizationId,
			ref,
			`${title} ${markerFor(ctx.markerId)}`
		);
	}
}
