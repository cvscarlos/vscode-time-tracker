import * as assert from 'node:assert';
import { ConnectorError, markerFor } from '../connector';
import { SolidtimeConnector } from './solidtimeConnector';

// Minimal fake fetch: maps "METHOD path" -> handler returning {status, body}
function fakeFetch(routes: Record<string, { status: number; body?: unknown }>): typeof fetch {
	return (async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		const method = (init?.method ?? 'GET').toUpperCase();
		const path = new URL(url).pathname + (new URL(url).search || '');
		const key = Object.keys(routes).find((k) => `${method} ${path}`.startsWith(k));
		const r = key ? routes[key] : { status: 404 };
		return {
			ok: r.status >= 200 && r.status < 300,
			status: r.status,
			json: async () => r.body ?? {},
			text: async () => JSON.stringify(r.body ?? {}),
		} as Response;
	}) as unknown as typeof fetch;
}

const base = 'https://app.solidtime.io';

suite('SolidtimeConnector', () => {
	test('resolveMember picks the configured org and uses membership.id as memberId', async () => {
		const f = fakeFetch({
			'GET /api/v1/users/me/memberships': {
				status: 200,
				body: { data: [{ id: 'mem-1', organization: { id: 'org-1', name: 'A' } }] },
			},
		});
		const c = new SolidtimeConnector(base, 'tok', 'org-1', f);
		assert.deepEqual(await c.resolveMember(), { organizationId: 'org-1', memberId: 'mem-1' });
	});

	test('findProjectByName returns id on exact name match, null otherwise', async () => {
		const f = fakeFetch({
			'GET /api/v1/organizations/org-1/projects': {
				status: 200,
				body: { data: [{ id: 'p-1', name: 'payments-api' }] },
			},
		});
		const c = new SolidtimeConnector(base, 'tok', 'org-1', f);
		assert.equal(await c.findProjectByName('org-1', 'payments-api'), 'p-1');
		// eslint-disable-next-line unicorn/no-null -- asserting the connector's documented "not found" value
		assert.equal(await c.findProjectByName('org-1', 'nope'), null);
	});

	test('createEntry appends the [vsc:id] marker to the description', async () => {
		let sent: any;
		const f = (async (input: any, init: any) => {
			sent = JSON.parse(init.body);
			return { ok: true, status: 201, json: async () => ({}), text: async () => '{}' } as Response;
		}) as unknown as typeof fetch;
		const c = new SolidtimeConnector(base, 'tok', 'org-1', f);
		await c.createEntry('org-1', 'mem-1', {
			segmentId: 'seg-9',
			start: '2026-07-21T09:00:00.000Z',
			end: '2026-07-21T09:30:00.000Z',
			projectId: 'p-1',
			// eslint-disable-next-line unicorn/no-null -- EntryInput contract uses null for "no task"
			taskId: null,
			description: 'feature-branch',
		});
		assert.ok(sent.description.includes(markerFor('seg-9')));
		assert.equal(sent.member_id, 'mem-1');
		assert.equal(sent.duration, undefined); // server derives duration
		// solidtime requires Y-m-d\TH:i:s\Z (no milliseconds) — else HTTP 422
		assert.equal(sent.start, '2026-07-21T09:00:00Z');
		assert.equal(sent.end, '2026-07-21T09:30:00Z');
	});

	test('a 500 throws a retryable ConnectorError; a 401 is not retryable', async () => {
		const c401 = new SolidtimeConnector(
			base,
			'tok',
			'org-1',
			fakeFetch({ 'GET /api/v1/users/me/memberships': { status: 401 } })
		);
		await assert.rejects(
			c401.resolveMember(),
			(e) => e instanceof ConnectorError && e.retryable === false
		);
		const c500 = new SolidtimeConnector(
			base,
			'tok',
			'org-1',
			fakeFetch({ 'GET /api/v1/users/me/memberships': { status: 500 } })
		);
		await assert.rejects(
			c500.resolveMember(),
			(e) => e instanceof ConnectorError && e.retryable === true
		);
	});

	test('listEntryMarkers extracts segmentIds from existing entry descriptions', async () => {
		const f = fakeFetch({
			'GET /api/v1/organizations/org-1/time-entries': {
				status: 200,
				body: {
					data: [
						{ description: 'work [vsc:seg-1]' },
						{ description: 'other [vsc:seg-2]' },
						{ description: 'no marker' },
					],
				},
			},
		});
		const c = new SolidtimeConnector(base, 'tok', 'org-1', f);
		const markers = await c.listEntryMarkers('org-1', 'mem-1', '2026-07-21T00:00:00.000Z');
		assert.ok(markers.has('seg-1') && markers.has('seg-2'));
		assert.equal(markers.size, 2);
	});
});
