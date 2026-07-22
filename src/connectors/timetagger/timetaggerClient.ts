import { ConnectorError } from '../connector';

export interface TimetaggerRecord {
	key: string;
	t1: number;
	t2: number;
	mt: number;
	ds: string;
	st: number;
}

export function normalizeTimetaggerUrl(raw: string): string {
	const base = raw
		.trim()
		.replace(/\/+$/, '')
		.replace(/\/api\/v2$/, '')
		.replace(/\/api$/, '');
	return `${base}/api/v2/`;
}

export class TimetaggerClient {
	private readonly base: string;

	constructor(
		apiUrl: string,
		private readonly token: string,
		private readonly fetchFn: typeof fetch = fetch
	) {
		this.base = normalizeTimetaggerUrl(apiUrl);
	}

	async putRecords(records: TimetaggerRecord[]): Promise<void> {
		let response: Response;
		try {
			response = await this.fetchFn(`${this.base}records`, {
				method: 'PUT',
				headers: { authtoken: this.token, 'content-type': 'application/json' },
				body: JSON.stringify(records),
			});
		} catch (error) {
			throw new ConnectorError(`timetagger network error: ${String(error)}`, undefined, true);
		}
		if (!response.ok) {
			const text = await response.text();
			const body = text.slice(0, 300);
			throw new ConnectorError(
				`timetagger ${response.status}: ${body}`,
				response.status,
				response.status >= 500
			);
		}
		let result: { failed?: string[]; errors?: string[] };
		try {
			result = (await response.json()) as { failed?: string[]; errors?: string[] };
		} catch {
			throw new ConnectorError('timetagger: invalid JSON response', response.status, true);
		}
		if ((result.failed?.length ?? 0) > 0 || (result.errors?.length ?? 0) > 0) {
			throw new ConnectorError(
				`timetagger rejected records: ${(result.errors ?? []).join(', ')}`,
				undefined,
				true
			);
		}
	}
}
