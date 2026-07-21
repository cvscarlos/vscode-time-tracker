import * as assert from 'node:assert';
import { deriveProjectName } from './workspaceResolver';

suite('deriveProjectName', () => {
	test('prefers the repository name from a remote key', () => {
		assert.equal(deriveProjectName('github.com/acme/payments-api', 'folder'), 'payments-api');
	});

	test('falls back to the folder name when there is no repository key', () => {
		assert.equal(deriveProjectName(undefined, 'my-folder'), 'my-folder');
	});
});
