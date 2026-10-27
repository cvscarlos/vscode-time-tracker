import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeApiUrl, permissionPattern } from './settings.ts';

test('the SolidTime URL is reduced to its base, like the VS Code setting', () => {
	for (const typed of [
		'https://app.solidtime.io',
		'https://app.solidtime.io/',
		'https://app.solidtime.io/api/v1',
		' https://app.solidtime.io/api/v1/ ',
	]) {
		assert.equal(normalizeApiUrl(typed), 'https://app.solidtime.io');
	}
});

test('the host permission pattern leaves out the port, which Firefox patterns cannot match', () => {
	assert.equal(permissionPattern('http://localhost:8080'), 'http://localhost/*');
	assert.equal(permissionPattern('https://app.solidtime.io'), 'https://app.solidtime.io/*');
});
