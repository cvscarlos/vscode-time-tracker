import { parseRules } from './rules.ts';
import { normalizeApiUrl, permissionPattern } from './settings.ts';

const DEFAULT_API_URL = 'https://app.solidtime.io';

const field = <T extends HTMLElement>(id: string): T => document.querySelector<T>(`#${id}`) as T;
const form = document.querySelector('form') as HTMLFormElement;
const rules = field<HTMLTextAreaElement>('rules');
const apiUrl = field<HTMLInputElement>('apiUrl');
const organizationId = field<HTMLInputElement>('organizationId');
const token = field<HTMLInputElement>('token');
const message = field<HTMLSpanElement>('message');
const syncError = field<HTMLParagraphElement>('syncError');

async function load(): Promise<void> {
	const stored = await chrome.storage.local.get([
		'settings:rules',
		'settings:apiUrl',
		'settings:organizationId',
		'settings:token',
		'status:error',
	]);
	rules.value = (stored['settings:rules'] as string | undefined) ?? '';
	apiUrl.value = (stored['settings:apiUrl'] as string | undefined) || DEFAULT_API_URL;
	organizationId.value = (stored['settings:organizationId'] as string | undefined) ?? '';
	token.placeholder = stored['settings:token']
		? '(a token is set — type to replace)'
		: 'Profile settings → API tokens in SolidTime';
	syncError.textContent = (stored['status:error'] as string | undefined) ?? '';
}

form.addEventListener('submit', async (event) => {
	event.preventDefault();
	message.textContent = '';
	if (rules.value.trim() !== '') {
		try {
			parseRules(rules.value);
		} catch (error) {
			message.textContent = (error as Error).message;
			return;
		}
	}
	const url = normalizeApiUrl(apiUrl.value) || DEFAULT_API_URL;
	if (!URL.canParse(url)) {
		message.textContent = 'The SolidTime URL is not valid.';
		return;
	}
	// Chrome grants the default server at install; Firefox and custom servers need the user's OK.
	const pattern = permissionPattern(url);
	if (!(await chrome.permissions.request({ origins: [pattern] }))) {
		message.textContent = `Permission needed for ${pattern}.`;
		return;
	}
	const values: Record<string, string> = {
		'settings:rules': rules.value,
		'settings:apiUrl': url,
		'settings:organizationId': organizationId.value.trim(),
	};
	if (token.value.trim() !== '') {
		values['settings:token'] = token.value.trim();
	}
	await chrome.storage.local.set(values);
	token.value = '';
	await load();
	message.textContent = 'Saved.';
});

void load();
