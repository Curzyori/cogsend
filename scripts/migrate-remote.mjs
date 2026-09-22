#!/usr/bin/env node
/**
 * Apply pending migrations, remote or local, to a database the app may have
 * bootstrapped itself.
 *
 * `wrangler d1 migrations apply` alone cannot do that: the app creates its own
 * schema on the first request, so a database deployed that way already has
 * every table and no history — and replaying 0001 (`CREATE TABLE users`) or
 * 0013 (`ALTER TABLE sessions ADD COLUMN`) aborts. This records the migrations
 * whose postconditions already hold, then lets wrangler run the rest.
 *
 * Usage:
 *   npm run db:migrate:remote                       # your deployed database
 *   npm run db:migrate:local                        # the local one
 *   npm run db:migrate:local -- --persist-to .wrangler/e2e-state
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ui from './lib/cli.mjs';
import { syncMigrations } from './lib/migration-sync.mjs';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

const argv = process.argv.slice(2);
const local = argv.includes('--local');
const passthrough = argv.filter((arg) => arg !== '--local' && arg !== '--remote');
const scope = local ? '--local' : '--remote';

/** Through the repo wrapper, so `wrangler.personal.jsonc` and WRANGLER_PROFILE
 *  apply as they do everywhere else. */
function wrangler(args, { capture = false } = {}) {
	return spawnSync('node', ['scripts/wrangler.mjs', ...args], {
		encoding: 'utf8',
		stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
	});
}

function d1Json(sql) {
	const result = wrangler(
		['d1', 'execute', 'DB', scope, ...passthrough, '--json', '--command', sql],
		{ capture: true }
	);
	if (result.status !== 0) {
		process.stderr.write(result.stderr || result.stdout || 'd1 execute failed\n');
		process.exit(result.status ?? 1);
	}
	const parsed = JSON.parse(result.stdout);
	return parsed[0]?.results ?? [];
}

const { recorded } = await syncMigrations({
	exec: async (sql) => {
		const result = wrangler(['d1', 'execute', 'DB', scope, ...passthrough, '--command', sql], {
			capture: true
		});
		if (result.status !== 0) {
			process.stderr.write(result.stderr || result.stdout || 'd1 execute failed\n');
			process.exit(result.status ?? 1);
		}
	},
	query: async (sql) => d1Json(sql),
	log: () => {}
});

// Captured: wrangler reprints its whole table after every migration applied, so
// a first run is ~300 lines of box drawing. The summary is the news.
const applied = wrangler(['d1', 'migrations', 'apply', 'DB', scope, ...passthrough], {
	capture: true
});
const text = `${applied.stdout}${applied.stderr}`;
if (applied.status !== 0) {
	process.stderr.write(`${ui.stripToolNoise(text)}\n`);
	ui.error(`applying migrations failed (${local ? 'local' : 'remote'} database).`);
	process.exit(applied.status ?? 1);
}
if (ui.isVerbose()) process.stdout.write(`${ui.stripToolNoise(text)}\n`);
ui.ok(ui.migrationsSummary(text) ?? `${local ? 'local' : 'remote'} database up to date`);
if (recorded.length) ui.note(`${recorded.length} already present, recorded as applied`);
process.exit(0);
