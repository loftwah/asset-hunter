#!/usr/bin/env node
/**
 * Revoke the delivery token and delete the file holding it.
 *
 * The counterpart to `scripts/mint-delivery-token.mjs`. Safe to run at any time
 * and safe to run twice: revoking does not affect content already delivered,
 * because delivery only ever creates.
 *
 * Deletes by `name`, not by token hash, so it works even when the file has been
 * lost. Also removes `.env.delivery`, which is where the secret was kept.
 */
import { rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const OUT = ".env.delivery";

const out = execFileSync(
	"npx",
	[
		"wrangler",
		"d1",
		"execute",
		"asset-hunter",
		"--remote",
		"--command",
		"DELETE FROM _emdash_api_tokens WHERE name = 'asset-hunter-delivery'",
		"--json",
	],
	{ encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
);
const at = out.indexOf("[{");
const changes = JSON.parse(out.slice(at === -1 ? 0 : at)).at?.(0)?.meta?.changes ?? 0;

if (existsSync(OUT)) rmSync(OUT, { force: true });

console.log(
	changes > 0
		? `Revoked ${changes} token(s) and removed ${OUT}.`
		: `No token named "asset-hunter-delivery" existed${existsSync(OUT) ? "" : `, and there was no ${OUT}`}. Nothing to do.`,
);
