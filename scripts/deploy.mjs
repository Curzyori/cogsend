#!/usr/bin/env node
/**
 * One command to update a deployment: tests, remote migrations, build, deploy.
 *
 * One line per step instead of each tool's full output — a first run of
 * `d1 migrations apply` alone is a few hundred lines of box drawing. A step that
 * fails prints everything it said, because then the detail is the message, and
 * `--verbose` prints it all even when it works.
 */
import { spawnSync } from 'node:child_process';
import * as ui from './lib/cli.mjs';
import { syncMigrations } from './lib/migration-sync.mjs';

/**
 * Run one step quietly.
 *
 * @param {string} label what the step is, for the failure line
 * @param {string} cmd @param {string[]} args
 * @param {string} [progressText] what the terminal shows while it runs
 * @returns {{ text: string, elapsedMs: number }}
 */
function run(label, cmd, args, progressText = label) {
	const startedAt = Date.now();
	ui.progress(progressText);
	const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
	ui.clearProgress();
	const stdout = result.stdout ?? '';
	const stderr = result.stderr ?? '';
	const status = result.status ?? 1;
	const text = `${stdout}${stderr}`;
	const verbose = ui.isVerbose();
	if (verbose) {
		ui.note(`$ ${cmd} ${args.join(' ')}`);
		if (text.trim()) process.stdout.write(`${ui.stripToolNoise(text)}\n`);
	}
	if (status !== 0) {
		if (!verbose && text.trim()) process.stderr.write(`${ui.stripToolNoise(text)}\n`);
		ui.error(`${label} failed — nothing was deployed.`);
		process.exit(status);
	}
	return { text, elapsedMs: Date.now() - startedAt };
}

/** `wrangler d1 execute --json`, through the repo wrapper. */
function d1Json(sql) {
	const result = spawnSync(
		'node',
		['scripts/wrangler.mjs', 'd1', 'execute', 'DB', '--remote', '--json', '--command', sql],
		{ encoding: 'utf8' }
	);
	if (result.status !== 0) {
		process.stderr.write(result.stderr || result.stdout || 'd1 execute failed\n');
		process.exit(result.status ?? 1);
	}
	const parsed = JSON.parse(result.stdout);
	return parsed[0]?.results ?? [];
}

ui.headline('Deploying CogSend');

const tests = run('the test suite', 'npx', ['vitest', 'run'], 'running the test suite');
ui.ok(`tests passed in ${ui.duration(tests.elapsedMs)}`);

// A database the app bootstrapped has the schema but no migration history, so
// record what it already satisfies before wrangler replays anything. Shared with
// `npm run db:migrate:remote` and `db:seed:local` so the three cannot drift
// apart; see scripts/lib/migration-sync.mjs.
const { recorded } = await syncMigrations({
	exec: async (sql) => {
		d1Json(sql);
	},
	query: async (sql) => d1Json(sql)
});
if (recorded.length) ui.note(`${recorded.length} migrations already present, recorded as applied`);

const migrate = run(
	'the migrations',
	'node',
	['scripts/wrangler.mjs', 'd1', 'migrations', 'apply', 'DB', '--remote'],
	'applying migrations'
);
ui.ok(ui.migrationsSummary(migrate.text) ?? 'remote database up to date');

const build = run('the build', 'npm', ['run', 'build'], 'building');
ui.ok(`built in ${ui.duration(build.elapsedMs)}`);

const deploy = run('the deploy', 'node', ['scripts/wrangler.mjs', 'deploy'], 'deploying');
const facts = ui.deployFacts(deploy.text);
ui.ok(`deployed in ${ui.duration(deploy.elapsedMs)}`);
if (facts.bindings.length) ui.note(facts.bindings.join(' · '));
console.log(ui.box([ui.bold('deployed'), ui.url(facts.url ?? 'see the deploy output above')]));
console.log(`
  ${ui.bold('Next')}
    ${ui.green('·')} set a script token if you have not already: ${ui.dim('npm run secrets:put -- API_TOKEN')}
    ${ui.green('·')} scheduled posts tick from the Worker cron trigger (wrangler.jsonc → triggers);
      if the trigger could not be attached, Settings → Scheduled publishing has the
      tick URL and a token for an external cron.`);
