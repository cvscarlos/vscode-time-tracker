import * as assert from 'node:assert';
import { normalizeTimetaggerUrl, TimetaggerClient } from './timetaggerClient';
import { ConnectorError } from '../connector';

function fakeStatusFetch(status: number, body: string): typeof fetch {
	return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

suite('normalizeTimetaggerUrl', () => {
	test('appends api/v2 to a bare host', () => {
		assert.equal(
			normalizeTimetaggerUrl('https://timetagger.app'),
			'https://timetagger.app/api/v2/'
		);
	});
	test('tolerates a trailing slash', () => {
		assert.equal(
			normalizeTimetaggerUrl('https://timetagger.app/'),
			'https://timetagger.app/api/v2/'
		);
	});
	test('does not double up an already-suffixed url', () => {
		assert.equal(
			normalizeTimetaggerUrl('https://timetagger.app/api/v2/'),
			'https://timetagger.app/api/v2/'
		);
	});
});

suite('TimetaggerClient.putRecords', () => {
	const record = { key: 'k1', t1: 1, t2: 2, mt: 3, ds: 'x', st: 0 };

	test('PUTs records to <base>records with the authtoken header', async () => {
		let seen: { url: string; init: RequestInit } | undefined;
		const fetchStub = async (url: string, init: RequestInit) => {
			seen = { url, init };
			return new Response(JSON.stringify({ accepted: ['k1'], failed: [], errors: [] }), {
				status: 200,
			});
		};
		const client = new TimetaggerClient('https://timetagger.app', 'tok', fetchStub as typeof fetch);
		await client.putRecords([record]);
		assert.equal(seen?.url, 'https://timetagger.app/api/v2/records');
		assert.equal(seen?.init.method, 'PUT');
		assert.equal((seen?.init.headers as Record<string, string>).authtoken, 'tok');
		assert.deepEqual(JSON.parse(seen?.init.body as string), [record]);
	});

	test('raises a non-retryable ConnectorError on 4xx', async () => {
		const fetchStub = fakeStatusFetch(401, 'bad token');
		const client = new TimetaggerClient('https://timetagger.app', 'tok', fetchStub);
		await assert.rejects(
			() => client.putRecords([record]),
			(e: unknown) => e instanceof ConnectorError && e.status === 401 && e.retryable === false
		);
	});

	test('raises a retryable ConnectorError on 5xx', async () => {
		const fetchStub = fakeStatusFetch(503, 'boom');
		const client = new TimetaggerClient('https://timetagger.app', 'tok', fetchStub);
		await assert.rejects(
			() => client.putRecords([record]),
			(e: unknown) => e instanceof ConnectorError && e.retryable === true
		);
	});

	test('raises when the body reports failed keys', async () => {
		const fetchStub = fakeStatusFetch(
			200,
			JSON.stringify({ accepted: [], failed: ['k1'], errors: ['nope'] })
		);
		const client = new TimetaggerClient('https://timetagger.app', 'tok', fetchStub);
		await assert.rejects(() => client.putRecords([record]), ConnectorError);
	});
});
