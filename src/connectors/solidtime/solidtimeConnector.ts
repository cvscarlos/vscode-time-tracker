import { ConnectorError, EntryInput, markerFor, TimeSyncConnector } from '../connector';

interface Membership {
	id: string;
	organization: { id: string; name: string };
}

// NOTE: listEntryMarkers/findProjectByName/findTaskByName read only the first
// API page. This is intentional for the single-user scope of this extension —
// the entry/project/task counts a lone user generates stay within one page.

// solidtime validates dates as Y-m-d\TH:i:s\Z — RFC3339 without milliseconds.
function toSolidtimeDate(iso: string): string {
	return new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class SolidtimeConnector implements TimeSyncConnector {
	private readonly fetchFn: typeof fetch;

	constructor(
		private readonly apiUrl: string,
		private readonly token: string,
		private readonly organizationId: string | undefined,
		fetchFn?: typeof fetch
	) {
		this.fetchFn = fetchFn ?? fetch;
	}

	async resolveMember(): Promise<{ organizationId: string; memberId: string }> {
		const data = await this.get<{ data: Membership[] }>('/api/v1/users/me/memberships');
		const memberships = data.data ?? [];
		const chosen = this.organizationId
			? memberships.find((m) => m.organization.id === this.organizationId)
			: memberships[0];
		if (!chosen) {
			throw new ConnectorError('No matching solidtime organization/membership', undefined, false);
		}
		return { organizationId: chosen.organization.id, memberId: chosen.id };
	}

	async findProjectByName(organizationId: string, name: string): Promise<string | null> {
		const data = await this.get<{ data: { id: string; name: string }[] }>(
			`/api/v1/organizations/${organizationId}/projects`
		);
		// eslint-disable-next-line unicorn/no-null -- TimeSyncConnector contract uses null for "not found"
		return data.data.find((p) => p.name === name)?.id ?? null;
	}

	async createProject(organizationId: string, name: string): Promise<string> {
		const data = await this.post<{ data: { id: string } }>(
			`/api/v1/organizations/${organizationId}/projects`,
			// eslint-disable-next-line unicorn/no-null -- solidtime requires client_id to be present (nullable)
			{ name, color: '#6c7280', is_billable: false, client_id: null }
		);
		return data.data.id;
	}

	async findTaskByName(
		organizationId: string,
		projectId: string,
		name: string
	): Promise<string | null> {
		const data = await this.get<{ data: { id: string; name: string; project_id: string }[] }>(
			`/api/v1/organizations/${organizationId}/tasks?project_id=${projectId}`
		);
		// eslint-disable-next-line unicorn/no-null -- TimeSyncConnector contract uses null for "not found"
		return data.data.find((t) => t.name === name && t.project_id === projectId)?.id ?? null;
	}

	async createTask(organizationId: string, projectId: string, name: string): Promise<string> {
		const data = await this.post<{ data: { id: string } }>(
			`/api/v1/organizations/${organizationId}/tasks`,
			{ name, project_id: projectId }
		);
		return data.data.id;
	}

	async listEntryMarkers(
		organizationId: string,
		memberId: string,
		sinceIso: string
	): Promise<Set<string>> {
		const data = await this.get<{ data: { description?: string }[] }>(
			`/api/v1/organizations/${organizationId}/time-entries?member_id=${memberId}&start=${encodeURIComponent(toSolidtimeDate(sinceIso))}`
		);
		const markers = new Set<string>();
		const re = /\[vsc:([^\]]+)\]/g;
		for (const entry of data.data ?? []) {
			for (const match of (entry.description ?? '').matchAll(re)) {
				markers.add(match[1]);
			}
		}
		return markers;
	}

	async createEntry(organizationId: string, memberId: string, entry: EntryInput): Promise<string> {
		const description = `${entry.description} ${markerFor(entry.segmentId)}`.trim();
		const data = await this.post<{ data: { id: string } }>(
			`/api/v1/organizations/${organizationId}/time-entries`,
			{
				member_id: memberId,
				start: toSolidtimeDate(entry.start),
				end: toSolidtimeDate(entry.end),
				billable: false,
				project_id: entry.projectId,
				task_id: entry.taskId,
				description,
				tags: [],
			}
		);
		return data.data.id;
	}

	async updateEntryDescription(
		organizationId: string,
		entryId: string,
		description: string
	): Promise<void> {
		await this.request('PUT', `/api/v1/organizations/${organizationId}/time-entries/${entryId}`, {
			description,
		});
	}

	private async get<T>(path: string): Promise<T> {
		return this.request<T>('GET', path);
	}

	private async post<T>(path: string, body: unknown): Promise<T> {
		return this.request<T>('POST', path, body);
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		let response: Response;
		try {
			response = await this.fetchFn(`${this.apiUrl}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${this.token}`,
					Accept: 'application/json',
					...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (error) {
			throw new ConnectorError(`network error: ${String(error)}`, undefined, true);
		}
		if (!response.ok) {
			const retryable = response.status >= 500 || response.status === 429;
			// Include the response body — solidtime puts the validation reason there
			// (e.g. "The client id field must be present."), which the status alone hides.
			const detail = await response.text().catch(() => '');
			throw new ConnectorError(
				`solidtime ${method} ${path} -> HTTP ${response.status} ${detail.slice(0, 300)}`.trim(),
				response.status,
				retryable
			);
		}
		const text = await response.text();
		return (text ? JSON.parse(text) : {}) as T;
	}
}
