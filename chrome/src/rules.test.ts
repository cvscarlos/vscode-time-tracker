import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchUrl, parseRules } from './rules.ts';

const rules = parseRules(
	JSON.stringify({
		acme: [
			'*.reddit.com',
			'learn.*.microsoft.com',
			'stackoverflow.com',
			'*--preview.medium.com',
			'github.com/example-org/acme',
		],
	})
);

const ruleFor = (url: string | undefined) => matchUrl(url, rules)?.rule;

test('a leading *. matches the domain itself and any subdomain', () => {
	assert.equal(ruleFor('https://reddit.com/'), '*.reddit.com');
	assert.deepEqual(matchUrl('https://www.reddit.com/r/x', rules), {
		project: 'acme',
		host: 'www.reddit.com',
		rule: '*.reddit.com',
	});
});

test('a *. label in the middle matches zero or more labels', () => {
	assert.equal(ruleFor('https://learn.microsoft.com/'), 'learn.*.microsoft.com');
	assert.equal(ruleFor('https://learn.dev.microsoft.com/'), 'learn.*.microsoft.com');
	assert.equal(ruleFor('https://learn.evil.com/'), undefined);
});

test('a * inside a label matches any text within that label', () => {
	assert.deepEqual(matchUrl('https://feature-x--preview.medium.com/admin', rules), {
		project: 'acme',
		host: 'feature-x--preview.medium.com',
		rule: '*--preview.medium.com',
	});
	assert.equal(ruleFor('https://stackoverflow.com/questions'), 'stackoverflow.com');
	assert.equal(ruleFor('https://meta.stackoverflow.com/'), undefined);
});

test('a path rule matches the path and anything under it, on segment boundaries', () => {
	assert.ok(ruleFor('https://github.com/example-org/acme'));
	assert.ok(ruleFor('https://github.com/example-org/acme/pull/3'));
	assert.equal(ruleFor('https://github.com/example-org/acme-old'), undefined);
	assert.equal(ruleFor('https://github.com/other/repo'), undefined);
});

test('host matching is case-insensitive', () => {
	assert.equal(ruleFor('https://WWW.REDDIT.COM/'), '*.reddit.com');
});

test('a rule written with a scheme or trailing slash still matches', () => {
	const withScheme = parseRules('{"acme": ["https://stackoverflow.com/"]}');
	assert.equal(
		matchUrl('https://stackoverflow.com/questions', withScheme)?.rule,
		'https://stackoverflow.com/'
	);
});

test('non-web and missing URLs never match', () => {
	for (const url of ['chrome://newtab', 'about:blank', 'file:///x', '', undefined]) {
		assert.equal(matchUrl(url, rules), undefined);
	}
});

test('the first matching project wins, in JSON key order', () => {
	const ordered = parseRules('{"a": ["*.reddit.com"], "b": ["www.reddit.com"]}');
	assert.equal(matchUrl('https://www.reddit.com/', ordered)?.project, 'a');
});

test('invalid JSON or a wrong shape is rejected', () => {
	assert.throws(() => parseRules('{'));
	assert.throws(() => parseRules('{"p": "x"}'));
	assert.throws(() => parseRules('[]'));
});

test('a rule object matches only when the tab title contains its text', () => {
	const inboxes = parseRules(
		JSON.stringify({
			acme: [{ url: 'mail.google.com', title: 'you@acme.com' }],
			contoso: [{ url: 'mail.google.com', title: 'you@contoso.com' }],
		})
	);
	const url = 'https://mail.google.com/mail/u/1/#inbox';
	assert.deepEqual(matchUrl(url, inboxes, 'Inbox (3) - YOU@CONTOSO.COM - Gmail'), {
		project: 'contoso',
		host: 'mail.google.com',
		rule: 'mail.google.com + you@contoso.com',
	});
	assert.equal(matchUrl(url, inboxes, 'Inbox - someone@else.com - Gmail'), undefined);
	assert.equal(matchUrl(url, inboxes), undefined);
});

test('a rule object needs a url and a title', () => {
	assert.throws(() => parseRules('{"acme": [{"url": "mail.google.com"}]}'));
	assert.throws(() => parseRules('{"acme": [{"url": "mail.google.com", "title": 3}]}'));
});
