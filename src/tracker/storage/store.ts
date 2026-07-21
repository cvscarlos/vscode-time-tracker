import { JournalRecord, LocalSegment } from '../types';

export interface Store {
	append(record: JournalRecord): void;
	recover(): LocalSegment[];
	listUndelivered(): LocalSegment[];
	claim(segmentId: string): boolean;
	markDelivered(segmentId: string): void;
	compact(): void;
}
