import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import eslintConfigPrettier from 'eslint-config-prettier';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';

export default [
	{ files: ['**/*.ts'] },
	eslintPluginUnicorn.configs.recommended,
	{
		plugins: {
			'@typescript-eslint': typescriptEslint,
		},
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 2022,
			sourceType: 'module',
		},
		rules: {
			'@typescript-eslint/naming-convention': [
				'warn',
				{ selector: 'import', format: ['camelCase', 'PascalCase'] },
			],
			curly: 'warn',
			eqeqeq: 'warn',
			'no-throw-literal': 'warn',
			semi: 'warn',
			'unicorn/prevent-abbreviations': 'off',
			// Opinionated abbreviation dictionary (v72): would rename the domain field
			// repositoryKey->repoKey and dir/tmp/ref across the codebase for style only.
			'unicorn/name-replacements': 'off',
			// v77 rewrite standard JSDoc (`/** x */` -> 3 lines, `*` prefixes stripped) for style only.
			'unicorn/no-asterisk-prefix-in-documentation-comments': 'off',
			'unicorn/single-line-block-comment-style': 'off',
			'unicorn/filename-case': ['warn', { case: 'camelCase' }],
		},
	},
	// Must come last: turns off ESLint rules that conflict with Prettier.
	eslintConfigPrettier,
];
