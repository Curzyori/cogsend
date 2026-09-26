import { describe, expect, it } from 'vitest';
import { isFreshLoginRefusal, runWrangler, wranglerOutput } from '../scripts/lib/wrangler-run.mjs';

/** A real `d1 execute --json` run right after an OAuth refresh (ids redacted). */
const REFUSED_JSON = `{
  "error": {
    "text": "A request to the Cloudflare API (/accounts/0123456789abcdef0123456789abcdef/d1/database/00000000-0000-0000-0000-000000000000/query) failed.",
    "notes": [
      {
        "text": "The given account is not valid or is not authorized to access this service [code: 7403]"
      }
    ],
    "kind": "error",
    "name": "APIError",
    "code": 7403,
    "accountTag": "0123456789abcdef0123456789abcdef"
  }
}`;
const WRAPPER_LINE = '\n$ npx wrangler d1 execute DB --remote --json --command SELECT 1\n';

type Result = { status: number; stdout: string; stderr: string };
const refused: Result = { status: 1, stdout: REFUSED_JSON, stderr: WRAPPER_LINE };
const succeeded: Result = { status: 0, stdout: '[{"results":[]}]', stderr: WRAPPER_LINE };
const brokenMigration: Result = {
	status: 1,
	stdout: '',
	stderr: '✘ [ERROR] near "CREAT": syntax error at offset 0 [code: 7500]'
};

/** Wrangler answering each attempt in turn, and no real waiting. */
function run(...answers: Result[]) {
	let attempts = 0;
	const result = runWrangler(['d1', 'execute', 'DB'], {
		spawn: () => answers[attempts++],
		wait: () => {}
	});
	return { result, attempts };
}

describe('fresh login refusal', () => {
	it('recognises the 7403 from --json output and from plain output', () => {
		expect(isFreshLoginRefusal(REFUSED_JSON)).toBe(true);
		expect(
			isFreshLoginRefusal(
				'✘ [ERROR] The given account is not valid or is not authorized to access this service [code: 7403]'
			)
		).toBe(true);
	});

	it('ignores other failures and other codes', () => {
		expect(isFreshLoginRefusal(brokenMigration.stderr)).toBe(false);
		expect(isFreshLoginRefusal('[code: 74030]')).toBe(false);
		expect(isFreshLoginRefusal('')).toBe(false);
	});
});

describe('runWrangler', () => {
	it('recovers when the refreshed login is refused once', () => {
		const { result, attempts } = run(refused, succeeded);
		expect(result.status).toBe(0);
		expect(attempts).toBe(2);
	});

	it('gives up after one retry', () => {
		const { result, attempts } = run(refused, refused, succeeded);
		expect(result.status).toBe(1);
		expect(attempts).toBe(2);
	});

	it('does not retry any other failure', () => {
		const { result, attempts } = run(brokenMigration, succeeded);
		expect(result.status).toBe(1);
		expect(attempts).toBe(1);
	});

	it('keeps both streams, so the error behind the wrapper line is shown', () => {
		const output = wranglerOutput(refused);
		expect(output).toContain('$ npx wrangler');
		expect(output).toContain('not authorized to access this service [code: 7403]');
	});
});
