import type { Store } from '../../src/tracker/storage/store';
import type { JournalRecord, LocalSegment } from '../../src/tracker/types';
import type { ChromeSegment } from './tracker.ts';

/** The slice of `chrome.storage.local` used here; tests pass an in-memory fake. */
export interface StorageArea {
	/** No argument: every stored item. */
	get(): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
	remove(key: string): Promise<void>;
}

/**
 * Synchronous reads from memory with write-through to storage: the shared
 * `Store` and `MappingStore` read synchronously, `chrome.storage` is async.
 */
export class StorageCache {
	static async load(area: StorageArea): Promise<StorageCache> {
		return new StorageCache(area, await area.get());
	}

	private readonly area: StorageArea;
	private readonly items: Map<string, unknown>;
	/** Keys whose latest value is not in storage yet, oldest first. */
	private readonly unsaved = new Set<string>();
	private writes: Promise<void> = Promise.resolve();

	private constructor(area: StorageArea, items: Record<string, unknown>) {
		this.area = area;
		this.items = new Map(Object.entries(items));
	}

	// A failed key (e.g. storage quota) is retried before any later key is written, so
	// tracker state never lands in storage ahead of the outbox segment it closed.
	private async write(previous: Promise<void>, key: string): Promise<void> {
		await previous;
		this.unsaved.add(key);
		try {
			for (const pending of this.unsaved) {
				const value = this.items.get(pending);
				await (value === undefined
					? this.area.remove(pending)
					: this.area.set({ [pending]: value }));
				this.unsaved.delete(pending);
			}
		} catch (error) {
			console.warn(`Storage write failed, retrying on the next write: ${(error as Error).message}`);
		}
	}

	get<T>(key: string): T | undefined {
		return this.items.get(key) as T | undefined;
	}

	/** `undefined` deletes the key. Writes are applied in call order and never reject. */
	update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			this.items.delete(key);
		} else {
			this.items.set(key, value);
		}
		this.writes = this.write(this.writes, key);
		return this.writes;
	}

	/** Resolves once every write issued so far has been attempted. */
	flushed(): Promise<void> {
		return this.writes;
	}
}

const SEGMENTS_KEY = 'outbox:segments';
const DELIVERED_KEY = 'outbox:delivered';

/** The Chrome outbox: closed segments wait here until every destination has them. */
export class ChromeOutboxStore implements Store {
	private readonly cache: StorageCache;

	constructor(cache: StorageCache) {
		this.cache = cache;
	}

	private get segments(): ChromeSegment[] {
		return this.cache.get<ChromeSegment[]>(SEGMENTS_KEY) ?? [];
	}

	private get delivered(): Record<string, string[]> {
		return this.cache.get<Record<string, string[]>>(DELIVERED_KEY) ?? {};
	}

	private isDeliveredToAll(segmentId: string, enabledIds: string[]): boolean {
		return enabledIds.every((id) => this.isDelivered(segmentId, id));
	}

	append(record: JournalRecord): void {
		if (record.type === 'close') {
			void this.cache.update(SEGMENTS_KEY, [...this.segments, record.segment as ChromeSegment]);
		}
	}

	recover(): LocalSegment[] {
		return [];
	}

	listUndelivered(enabledIds: string[]): LocalSegment[] {
		return this.segments.filter((s) => !this.isDeliveredToAll(s.id, enabledIds));
	}

	/** One service worker per profile, so there is no other instance to race. */
	claim(): boolean {
		return true;
	}

	isDelivered(segmentId: string, destinationId: string): boolean {
		return this.delivered[segmentId]?.includes(destinationId) ?? false;
	}

	markDelivered(segmentId: string, destinationId: string): void {
		if (this.isDelivered(segmentId, destinationId)) {
			return;
		}
		const delivered = this.delivered;
		void this.cache.update(DELIVERED_KEY, {
			...delivered,
			[segmentId]: [...(delivered[segmentId] ?? []), destinationId],
		});
	}

	compact(enabledIds: string[]): void {
		const done = new Set(
			this.segments.filter((s) => this.isDeliveredToAll(s.id, enabledIds)).map((s) => s.id)
		);
		if (done.size === 0) {
			return;
		}
		void this.cache.update(
			SEGMENTS_KEY,
			this.segments.filter((s) => !done.has(s.id))
		);
		void this.cache.update(
			DELIVERED_KEY,
			Object.fromEntries(Object.entries(this.delivered).filter(([id]) => !done.has(id)))
		);
	}

	segmentsByIds(ids: string[]): ChromeSegment[] {
		const wanted = new Set(ids);
		return this.segments.filter((s) => wanted.has(s.id));
	}
}
