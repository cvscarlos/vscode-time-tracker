/** Host permission for the SolidTime server: Firefox match patterns cannot contain a port. */
export function permissionPattern(apiUrl: string): string {
	const { protocol, hostname } = new URL(apiUrl);
	return `${protocol}//${hostname}/*`;
}

/** Same normalization as the VS Code `solidtime.apiUrl` setting: the base URL, without `/api/v1`. */
export function normalizeApiUrl(raw: string): string {
	return raw
		.trim()
		.replace(/\/api(\/v1)?\/?$/, '')
		.replace(/\/+$/, '');
}
