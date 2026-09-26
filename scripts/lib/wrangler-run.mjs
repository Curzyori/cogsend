import { spawnSync } from 'node:child_process';

/** @typedef {{ status: number | null, stdout?: string | null, stderr?: string | null }} WranglerResult */

/**
 * Cloudflare's 7403 ("account is not valid or is not authorized"). Right after
 * wrangler refreshes an expired OAuth login, the new token can be refused for a
 * few seconds, so the first command after an hour away fails and the same
 * command a moment later works. The refusal happens before anything runs.
 *
 * @param {string} text
 */
export function isFreshLoginRefusal(text) {
	return /\[code: 7403\]|"code":\s*7403\b/.test(text);
}

/** @param {WranglerResult} result */
export function wranglerOutput(result) {
	return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @returns {WranglerResult}
 */
function capture(cmd, args) {
	return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/** @param {number} ms */
function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `scripts/wrangler.mjs` with its output captured, retrying once on a
 * refused fresh login. Any other failure is returned as it is.
 *
 * @param {string[]} args
 * @param {{
 *   spawn?: (cmd: string, args: string[]) => WranglerResult,
 *   wait?: (ms: number) => void,
 *   delayMs?: number,
 *   onRetry?: () => void
 * }} [options]
 * @returns {WranglerResult}
 */
export function runWrangler(
	args,
	{ spawn = capture, wait = sleep, delayMs = 5000, onRetry = () => {} } = {}
) {
	const attempt = () => spawn('node', ['scripts/wrangler.mjs', ...args]);
	const first = attempt();
	if (first.status === 0 || !isFreshLoginRefusal(wranglerOutput(first))) return first;
	onRetry();
	wait(delayMs);
	return attempt();
}
