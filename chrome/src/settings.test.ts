import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeApiUrl } from './settings.ts';

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
