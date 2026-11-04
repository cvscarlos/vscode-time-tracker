/** Same normalization as the VS Code `solidtime.apiUrl` setting: the base URL, without `/api/v1`. */
export function normalizeApiUrl(raw: string): string {
	return raw
		.trim()
		.replace(/\/api(\/v1)?\/?$/, '')
		.replace(/\/+$/, '');
}
