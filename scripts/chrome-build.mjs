// Bundles the browser extension into chrome/dist; with --zip, also packs it for store upload.
import { build } from 'esbuild';
import { createWriteStream, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';

const root = path.join(import.meta.dirname, '..');
const chrome = path.join(root, 'chrome');

await build({
	entryPoints: [path.join(chrome, 'src/background.ts'), path.join(chrome, 'src/options.ts')],
	bundle: true,
	format: 'esm',
	target: 'chrome120',
	outdir: path.join(chrome, 'dist'),
	logLevel: 'info',
});

if (process.argv.includes('--zip')) {
	const { name } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
	const { version } = JSON.parse(readFileSync(path.join(chrome, 'manifest.json'), 'utf8'));
	const out = path.join(root, 'tmp', `${name}-chrome-${version}.zip`);

	const zip = new yazl.ZipFile();
	for (const entry of ['manifest.json', 'options.html', 'icons', 'dist']) {
		const full = path.join(chrome, entry);
		const files = statSync(full).isDirectory()
			? readdirSync(full, { recursive: true }).map((file) => path.join(entry, file))
			: [entry];
		for (const file of files) {
			if (statSync(path.join(chrome, file)).isFile()) {
				zip.addFile(path.join(chrome, file), file.split(path.sep).join('/'));
			}
		}
	}
	mkdirSync(path.dirname(out), { recursive: true });
	zip.outputStream
		.pipe(createWriteStream(out))
		.on('close', () => console.log(`Packed ${path.relative(root, out)}`));
	zip.end();
}
