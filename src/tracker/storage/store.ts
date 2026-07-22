import { JournalRecord, LocalSegment } from '../types';

export interface Store {
	append(record: JournalRecord): void;
	recover(): LocalSegment[];
	listUndelivered(enabledIds: string[]): LocalSegment[];
	claim(segmentId: string): boolean;
	isDelivered(segmentId: string, destinationId: string): boolean;
	markDelivered(segmentId: string, destinationId: string): void;
	compact(enabledIds: string[]): void;
}
