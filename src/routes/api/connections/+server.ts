import { and, desc, eq, ne } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { platformConfigured } from '$lib/domain/platform-setup';
import { connections } from '$lib/server/db/schema';
import { handleError, ok } from '$lib/server/http';
import { requireScope, requireUser } from '$lib/server/require';
import { serializeConnection } from '$lib/server/serialize';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		// Slim select: never ship credentialsEncrypted/userId/updatedAt to the
		// client (serializeConnection drops them anyway). Saves D1 bytes on
		// every Accounts/Composer load.
		const rows = await locals.db
			.select({
				id: connections.id,
				platform: connections.platform,
				displayName: connections.displayName,
				handle: connections.handle,
				avatarUrl: connections.avatarUrl,
				instanceUrl: connections.instanceUrl,
				status: connections.status,
				metaJson: connections.metaJson,
				createdAt: connections.createdAt
			})
			.from(connections)
			// Disconnected rows are archive tombstones (published posts keep
			// referencing them); they are not connectable accounts and must
			// not render as expired accounts waiting for a reconnect.
			.where(and(eq(connections.userId, user.id), ne(connections.status, 'disconnected')))
			.orderBy(desc(connections.createdAt));
		// OAuth platforms needing server-side app credentials: the accounts
		// dialog renders its setup panel from this without a failed POST.
		// Presence only — a wrong id still counts and fails at the provider.
		//
		// Per secret, not just per platform: "LinkedIn isn't enabled yet" was
		// the same sentence whether nothing was uploaded or half of it was, so
		// the dialog now names the missing half and asks for only that.
		// `configured` is derived from the same map, so a "Needs setup" chip
		// and that list cannot disagree. A test keeps this list in step with
		// PLATFORM_SECRET_NAMES.
		const secrets = {
			LINKEDIN_CLIENT_ID: Boolean(locals.env.LINKEDIN_CLIENT_ID),
			LINKEDIN_CLIENT_SECRET: Boolean(locals.env.LINKEDIN_CLIENT_SECRET),
			THREADS_APP_ID: Boolean(locals.env.THREADS_APP_ID),
			THREADS_APP_SECRET: Boolean(locals.env.THREADS_APP_SECRET),
			X_CLIENT_ID: Boolean(locals.env.X_CLIENT_ID),
			X_CLIENT_SECRET: Boolean(locals.env.X_CLIENT_SECRET)
		};
		const configured = {
			linkedin: platformConfigured('linkedin', secrets),
			threads: platformConfigured('threads', secrets),
			x: platformConfigured('x', secrets)
		};
		// The setup panel has to show the redirect URI the connect routes will
		// actually send, which is the deployment's APP_URL, not necessarily the
		// origin the browser is on.
		return ok({
			connections: rows.map(serializeConnection),
			configured,
			secrets,
			appUrl: locals.env.APP_URL
		});
	} catch (err) {
		return handleError(err);
	}
};
