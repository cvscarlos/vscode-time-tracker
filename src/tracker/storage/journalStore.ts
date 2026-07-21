import * as fs from 'node:fs';
import path from 'node:path';
import { JournalRecord } from '../types';

export class JournalStore {
	public constructor(
		private readonly directory: string,
		private readonly instanceId: string,
		private readonly now: () => Date = () => new Date()
	) {
		fs.mkdirSync(this.directory, { recursive: true });
	}

	public static readInstanceFiles(directory: string, instanceId: string): JournalRecord[] {
		if (!fs.existsSync(directory)) {
			return [];
		}
		const files = fs
			.readdirSync(directory)
			.filter((name) => name.startsWith(`${instanceId}-`) && name.endsWith('.jsonl'));
		files.sort();
		const records: JournalRecord[] = [];
		for (const name of files) {
			records.push(...JournalStore.readFile(path.join(directory, name)));
		}
		return records;
	}

	public append(record: JournalRecord): void {
		const file = path.join(this.directory, this.fileName());
		const descriptor = fs.openSync(file, 'a');
		try {
			fs.writeSync(descriptor, `${JSON.stringify(record)}\n`);
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
	}

	public readAll(): JournalRecord[] {
		return JournalStore.readInstanceFiles(this.directory, this.instanceId);
	}

	private static readFile(filePath: string): JournalRecord[] {
		const content = fs.readFileSync(filePath, 'utf8');
		const records: JournalRecord[] = [];
		for (const line of content.split('\n')) {
			if (!line.trim()) {
				continue;
			}
			try {
				records.push(JSON.parse(line) as JournalRecord);
			} catch {
				// Append-only means only a torn trailing line can be invalid; skip it.
			}
		}
		return records;
	}

	private fileName(): string {
		const date = this.now().toISOString().slice(0, 10);
		return `${this.instanceId}-${date}.jsonl`;
	}
}
