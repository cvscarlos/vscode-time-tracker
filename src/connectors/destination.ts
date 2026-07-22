import { DeliveryBlock } from './aggregate';
import { ConnectorError, markerFor } from './connector';

export { DeliveryBlock, ConnectorError, markerFor };

export interface TitleCtx {
	markerId: string;
	projectName: string;
	branch?: string;
}

export interface TimeDestination {
	/** Stable id used as the per-destination delivery key: 'solidtime' | 'timetagger'. */
	readonly id: string;
	/** Human label for logs, status, and token hints: 'solidtime' | 'TimeTagger'. */
	readonly label: string;
	/** Pre-fetch anything the run needs (member id, dedup set). No-op for key-idempotent backends. */
	prepare(sinceIso: string): Promise<void>;
	/**
	 * Idempotently create/update one aggregated block. Returns a stable backend
	 * reference for later retitling, or '' when nothing was created (e.g. the
	 * entry already existed on the backend and cannot be retitled by this window).
	 */
	deliver(block: DeliveryBlock): Promise<string>;
	/** Retitle a previously delivered entry. Idempotent. No-op when ref === ''. */
	retitle(ref: string, title: string, ctx: TitleCtx): Promise<void>;
}
