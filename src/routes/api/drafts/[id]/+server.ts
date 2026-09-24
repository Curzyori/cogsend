import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { parseDraftBody, parseDraftTitle } from '$lib/domain/validation/draft-fields';
import { first } from '$lib/server/db/client';
import { draftMedia, drafts, publishTargets } from '$lib/server/db/schema';
import { loadOwnedDraft } from '$lib/server/draft-record';
import { deleteMediaObjects } from '$lib/server/media';
import { fail, handleError, ok } from '$lib/server/http';
import { draftHasInFlightPublish } from '$lib/server/publish-plan';
import { requireScope, requireUser } from '$lib/server/require';
import { normalizeSelectedConnectionIds } from '$lib/domain/request-limits';

export const GET: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		const draft = await loadOwnedDraft(locals.db, params.id, user.id);
		if (!draft) return fail('Not found', 404);
		return ok({ draft });
	} catch (err) {
		return handleError(err);
	}
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const existing = await first(
			locals.db
				.select()
				.from(drafts)
				.where(and(eq(drafts.id, params.id), eq(drafts.userId, user.id)))
		);
		if (!existing) return fail('Not found', 404);
		const liveTargets = await locals.db
			.select()
			.from(publishTargets)
			.where(eq(publishTargets.draftId, params.id));
		if (draftHasInFlightPublish(liveTargets)) {
			return fail('Publishing in progress — try again shortly', 409);
		}
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const selection = normalizeSelectedConnectionIds(body.selectedConnectionIds);
		if (!selection.ok) return fail(selection.error, 400);
		// Validate before the UPDATE: a non-string reaches the driver as a 500,
		// and an unbounded string is stored as-is.
		const patch: { title?: string | null; baseBody?: string; selectedConnectionIds?: string } = {};
		if (body.title !== undefined) {
			const title = parseDraftTitle(body.title);
			if (!title.ok) return fail(title.error, 400);
			patch.title = title.value;
		}
		if (body.baseBody !== undefined) {
			const text = parseDraftBody(body.baseBody);
			if (!text.ok) return fail(text.error, 400);
			patch.baseBody = text.value;
		}
		if (selection.value !== undefined) patch.selectedConnectionIds = selection.value;
		await locals.db
			.update(drafts)
			.set({
				...patch,
				updatedAt: new Date()
			})
			.where(eq(drafts.id, params.id));
		// Autosave only needs an acknowledgement; the client already holds the
		// saved state, so skip the full reload the GET performs.
		return ok({ ok: true });
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const existing = await first(
			locals.db
				.select()
				.from(drafts)
				.where(and(eq(drafts.id, params.id), eq(drafts.userId, user.id)))
		);
		if (!existing) return fail('Not found', 404);
		const liveTargets = await locals.db
			.select()
			.from(publishTargets)
			.where(eq(publishTargets.draftId, params.id));
		if (draftHasInFlightPublish(liveTargets)) {
			// Deleting mid-publish orphans the remote post (fenced write finds
			// no row → `preempted` with no record) and races media cleanup.
			return fail('Publishing in progress — try again shortly', 409);
		}
		const files = await locals.db
			.select()
			.from(draftMedia)
			.where(eq(draftMedia.draftId, params.id));
		// Delete R2 objects BEFORE the draft row: a crash between the two
		// then leaves rows behind (retryable) instead of orphaned bytes.
		// Object deletes are idempotent, so retrying is safe.
		await deleteMediaObjects(
			locals.media,
			files.map((f) => f.storageKey)
		);
		await locals.db.delete(drafts).where(eq(drafts.id, params.id));
		return ok({ ok: true });
	} catch (err) {
		return handleError(err);
	}
};
