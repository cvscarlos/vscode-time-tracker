import * as fs from 'node:fs';
import path from 'node:path';
import { CheckpointRecord, JournalRecord, LocalSegment, OpenRecord } from '../types';
import { Store } from './store';

const CLAIM_LEASE_MS = 5 * 60 * 1000;
// 2x the 60s checkpoint cadence: an open whose last checkpoint is older than
// this cannot belong to a live window still writing checkpoints, so it is
// treated as crashed/stale and safe to recover.
const STALE_OPEN_MS = 120_000;

function reconstructSegments(
	records: JournalRecord[],
	options?: { now?: number; minActiveMs?: number }
): LocalSegment[] {
	const segments: LocalSegment[] = [];
	const closedIds = new Set<string>();
	const opens = new Map<string, OpenRecord>();
	const lastCheckpoint = new Map<string, CheckpointRecord>();

	for (const record of records) {
		if (record.type === 'close') {
			// Closed segments already met the minimum in the state machine.
			segments.push(record.segment);
			closedIds.add(record.segment.id);
		} else if (record.type === 'open') {
			opens.set(record.id, record);
		} else {
			lastCheckpoint.set(record.id, record);
		}
	}

	const minActiveMs = options?.minActiveMs ?? 0;
	for (const [id, open] of opens) {
		if (closedIds.has(id)) {
			continue;
		}
		const checkpoint = lastCheckpoint.get(id);
		if (!checkpoint) {
			continue;
		}
		// A dangling open is only recoverable when staleness is not being
		// filtered (now === undefined) or its last checkpoint write is old enough
		// that no live window could still own it. A fresh checkpoint write means a
		// running window is still there (even if it is only focused and reading,
		// with no recent edits) and would otherwise be delivered truncated.
		const isStale =
			options?.now === undefined || options.now - Date.parse(checkpoint.at) >= STALE_OPEN_MS;
		if (!isStale) {
			continue;
		}
		const activeMilliseconds = Date.parse(checkpoint.at) - Date.parse(open.start);
		// A dangling open never emitted a close, so it was never checked against
		// the minimum-segment threshold. A sub-minimum reconstruction (e.g. an
		// idle-close that dropped it) must not be resurrected and delivered.
		if (activeMilliseconds < minActiveMs) {
			continue;
		}
		// A recovered dangling open was never closed by the inactivity cap (its window
		// crashed), so its credited time counts as focus, not idle — matching the
		// state machine, where only a cap-close banks idle credit.
		const idleMilliseconds = 0;
		segments.push({
			id,
			instanceId: open.instanceId,
			start: open.start,
			end: checkpoint.at,
			activeMilliseconds,
			idleMilliseconds,
			workspaceKey: open.context.workspaceKey,
			projectName: open.context.projectName,
			repositoryKey: open.context.repositoryKey,
			branch: open.context.branch,
			syncState: 'pending',
		});
	}

	return segments;
}

export class FileOutboxStore implements Store {
	private readonly claimsDir: string;
	private readonly deliveredDir: string;

	public constructor(
		private readonly directory: string,
		private readonly instanceId: string,
		private readonly now: () => Date = () => new Date(),
		private readonly minActiveMs = 0
	) {
		this.claimsDir = path.join(directory, 'claims');
		this.deliveredDir = path.join(directory, 'delivered');
		fs.mkdirSync(directory, { recursive: true });
		fs.mkdirSync(this.claimsDir, { recursive: true });
		fs.mkdirSync(this.deliveredDir, { recursive: true });
	}

	private isFullyDelivered(segmentId: string, enabledIds: string[]): boolean {
		return enabledIds.length > 0 && enabledIds.every((id) => this.isDelivered(segmentId, id));
	}

	private presentSegmentIds(): Set<string> {
		const ids = new Set<string>();
		for (const record of this.readAllRecords()) {
			ids.add(record.type === 'close' ? record.segment.id : record.id);
		}
		return ids;
	}

	private isClaimStale(claimedAtMs: number): boolean {
		return this.now().getTime() - claimedAtMs > CLAIM_LEASE_MS;
	}

	private readClaim(file: string): { instanceId: string; claimedAtMs: number } | undefined {
		try {
			const content = fs.readFileSync(file, 'utf8');
			const [instanceId, timestamp] = content.split(' ', 2);
			const claimedAtMs = Date.parse(timestamp);
			if (!instanceId || Number.isNaN(claimedAtMs)) {
				return undefined;
			}
			return { instanceId, claimedAtMs };
		} catch {
			return undefined;
		}
	}

	private readAllRecords(): JournalRecord[] {
		const records: JournalRecord[] = [];
		for (const name of this.journalFiles()) {
			const content = fs.readFileSync(path.join(this.directory, name), 'utf8');
			const lines = content.split('\n').filter((line) => line.trim() !== '');
			for (const line of lines) {
				try {
					records.push(JSON.parse(line) as JournalRecord);
				} catch {
					// Append-only: only a torn trailing line can be invalid; skip it.
				}
			}
		}
		return records;
	}

	private journalFiles(): string[] {
		const files = fs.readdirSync(this.directory).filter((name) => name.endsWith('.jsonl'));
		files.sort((a, b) => a.localeCompare(b));
		return files;
	}

	private dateStamp(): string {
		return this.now().toISOString().slice(0, 10);
	}

	private tryRemove(file: string): void {
		try {
			fs.rmSync(file);
		} catch {
			// already gone
		}
	}

	private removeStaleTombstones(presentIds: Set<string>): void {
		for (const tombstone of fs.readdirSync(this.deliveredDir)) {
			const segmentId = tombstone.includes('.')
				? tombstone.slice(0, tombstone.indexOf('.'))
				: tombstone;
			if (presentIds.has(segmentId)) {
				continue;
			}
			this.tryRemove(path.join(this.deliveredDir, tombstone));
			this.tryRemove(path.join(this.claimsDir, `${segmentId}.claim`));
		}
	}

	public append(record: JournalRecord): void {
		const file = path.join(this.directory, `${this.instanceId}-${this.dateStamp()}.jsonl`);
		const descriptor = fs.openSync(file, 'a');
		try {
			fs.writeSync(descriptor, JSON.stringify(record) + '\n');
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
	}

	public recover(): LocalSegment[] {
		return reconstructSegments(this.readAllRecords(), {
			now: this.now().getTime(),
			minActiveMs: this.minActiveMs,
		});
	}

	public listUndelivered(enabledIds: string[]): LocalSegment[] {
		return this.recover().filter((segment) => !this.isFullyDelivered(segment.id, enabledIds));
	}

	public claim(segmentId: string): boolean {
		const file = path.join(this.claimsDir, `${segmentId}.claim`);
		const existing = this.readClaim(file);
		if (existing && this.isClaimStale(existing.claimedAtMs)) {
			this.tryRemove(file);
		}
		try {
			const descriptor = fs.openSync(file, 'wx');
			fs.writeSync(descriptor, `${this.instanceId} ${this.now().toISOString()}`);
			fs.closeSync(descriptor);
			return true;
		} catch {
			return false;
		}
	}

	public markDelivered(segmentId: string, destinationId: string): void {
		fs.writeFileSync(path.join(this.deliveredDir, `${segmentId}.${destinationId}`), '');
		this.tryRemove(path.join(this.claimsDir, `${segmentId}.claim`));
	}

	public compact(enabledIds: string[]): void {
		const isSegmentFullyDelivered = (segmentId: string): boolean =>
			this.isFullyDelivered(segmentId, enabledIds);
		// Rewrite files owned by this instance, plus any file dated before today.
		// append() always targets today's file for the CURRENT instanceId, so a
		// prior-date file — whichever instance wrote it — can never receive a new
		// append and is safe for any window to compact. Rewriting another live
		// window's file could clobber a record it appended between our read and
		// write, but that risk only exists for today's file of a still-running
		// window.
		const today = this.dateStamp();
		const ownFiles = this.journalFiles().filter((name) => {
			if (name.startsWith(`${this.instanceId}-`)) {
				return true;
			}
			const fileDate = dateStampOf(name);
			return fileDate !== undefined && fileDate < today;
		});
		for (const name of ownFiles) {
			const full = path.join(this.directory, name);
			const kept = fs
				.readFileSync(full, 'utf8')
				.split('\n')
				.filter((line) => {
					if (line.trim() === '') {
						return false;
					}
					const segmentId = segmentIdOf(line);
					return segmentId !== undefined && !isSegmentFullyDelivered(segmentId);
				});
			if (kept.length === 0) {
				this.tryRemove(full);
			} else {
				// Write atomically: a truncating write that crashes mid-flight
				// would lose retained (undelivered) records. Rename is atomic on
				// the same filesystem.
				const tmp = `${full}.tmp`;
				fs.writeFileSync(tmp, kept.join('\n') + '\n');
				fs.renameSync(tmp, full);
			}
		}
		// A delivered tombstone may reference a segment stored in ANOTHER
		// instance's file, which we do not rewrite above. Removing the tombstone
		// while that record is still on disk would let recover() re-surface it,
		// churning it forever. Keep the tombstone until the id is no longer
		// present in any journal file (its owning instance eventually compacts
		// it). listUndelivered() excludes tombstoned ids, so the segment stays
		// suppressed meanwhile.
		this.removeStaleTombstones(this.presentSegmentIds());
	}

	public isDelivered(segmentId: string, destinationId: string): boolean {
		if (fs.existsSync(path.join(this.deliveredDir, `${segmentId}.${destinationId}`))) {
			return true;
		}
		// Migration: a bare tombstone (no destination suffix) predates multi-backend
		// support and represents a solidtime delivery.
		return destinationId === 'solidtime' && fs.existsSync(path.join(this.deliveredDir, segmentId));
	}
}

// The instanceId itself contains hyphens, so the date is only reliably
// extracted by anchoring to the trailing `-YYYY-MM-DD.jsonl` shape.
function dateStampOf(filename: string): string | undefined {
	return /-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(filename)?.[1];
}

function segmentIdOf(line: string): string | undefined {
	try {
		const record = JSON.parse(line) as JournalRecord;
		return record.type === 'close' ? record.segment.id : record.id;
	} catch {
		// Append-only: only a torn trailing line can be invalid; treat it as garbage to compact away.
		return undefined;
	}
}
