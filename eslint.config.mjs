import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import eslintConfigPrettier from 'eslint-config-prettier';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';

export default [
	{ files: ['**/*.ts'] },
	// If this import shape errors, use eslintPluginUnicorn.configs['flat/recommended'].
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
			'unicorn/filename-case': ['warn', { case: 'camelCase' }],
		},
	},
	// Must come last: turns off ESLint rules that conflict with Prettier.
	eslintConfigPrettier,
];
