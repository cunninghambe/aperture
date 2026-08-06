import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { registrableDomain } from '@vault/vault';
import { originOf } from '@shared/origin.js';
import {
  EXPIRY_SECONDS,
  SHIPPED_SIGNATURE_AGENT_FORM,
  decideSigning,
  jwkThumbprint,
  parseBotAuthConfig,
  prepareSignature,
  signatureHeaderValue,
  type BotAuthConfig,
  type ContainerSigning,
  type OkpPublicJwk,
  type OriginFns,
} from './botAuthCore.js';
import { registerBeforeSendHeaders, type MuxRequest } from './webRequestMux.js';

/**
 * WEB BOT AUTH — MAIN-PROCESS WIRING.
 *
 * `docs/design/webbotauth.md` is the decision record. This file does the I/O
 * the pure leaf refuses to do: read the config, generate or load one Ed25519
 * keypair per configured container, write the ready-to-publish JWKS, and hand
 * one synchronous handler to the mux.
 *
 * ---------------------------------------------------------------------------
 * THE PRIVATE KEY NEVER LEAVES THIS MODULE — §2.5
 * ---------------------------------------------------------------------------
 *
 * No export below returns a private key, a private JWK, or anything derived
 * from one but the PUBLIC thumbprint. There is no IPC channel, no MCP tool, no
 * log line and no error message that carries it: the two functions that hold
 * one (`loadOrCreateKey`, the mux handler) keep it in a module-local map and
 * hand out `Buffer`s of SIGNATURES. `test/botauth.test.ts` asserts the module
 * surface, because "nobody would export that" is exactly the discipline this
 * project has now paid for on four other mechanisms.
 *
 * THE AGENT SURFACE IS ZERO — §6, §8.4. No MCP tool reads, writes, enables,
 * disables or reports any of this; no tool result names the key, the
 * thumbprint, the directory URL or the allowlist; the tool count does not
 * change. The ALLOWLIST in particular is withheld deliberately: handing a
 * manipulable agent a list of origins where this browser will assert an
 * identity is a targeting map for injected content, and withholding it costs
 * nothing — the agent can infer signing from an origin's behaviour and cannot
 * enumerate it.
 *
 * SIGNING IS IDENTIFICATION, NEVER EVASION — §8.1. Nothing in this file varies
 * any fingerprint surface with signing state. The UA story (`useragent.ts`,
 * `session.setUserAgent`) is untouched; the only bytes added are the three
 * signature headers, and the mux makes that additive by construction. This
 * feature tells origins the human chose who the agent is. It does not, and must
 * never be extended to, get the agent PAST anything — a future change that keys
 * evasion behaviour off this module re-litigates the project's founding
 * rejection of the anti-detect premise and is refused on that ground.
 */

const ORIGIN_FNS: OriginFns = { registrableDomain, originOf };

/** What the tab manager can tell us about the tab a request belongs to. */
export interface Attribution {
  tabId: string;
  agentOwned: boolean;
  container: string;
}

export interface AttributionResolver {
  forWebContents(webContentsId: number): Attribution | null;
}

interface HeldKey {
  /** The signing key. Never leaves this map. */
  privateKey: ReturnType<typeof createPrivateKey>;
  /** base64url RFC 7638 thumbprint over {crv,kty,x}. */
  keyid: string;
  publicJwk: OkpPublicJwk;
}

interface State {
  config: BotAuthConfig | null;
  keys: Map<string, HeldKey>;
  attribution: AttributionResolver | null;
}

const state: State = { config: null, keys: new Map(), attribution: null };

/**
 * Wire the tab manager in.
 *
 * The `setOriginScope` precedent, WITH ITS ASYMMETRY STATED: an unwired origin
 * scope redacts nothing, which is catastrophic; an unwired attribution resolver
 * signs nothing, which is merely off. Signing FAILS SAFE unwired, and a
 * resolver that answers `null` means unsigned everywhere it is asked — that is
 * the rule on every path below, not a special case here.
 */
export function setAttributionResolver(resolver: AttributionResolver): void {
  state.attribution = resolver;
}

// ---------------------------------------------------------------------------
// Configuration and keys.
// ---------------------------------------------------------------------------

function botauthDir(): string {
  return join(app.getPath('userData'), 'botauth');
}

/**
 * Generate a keypair, or load the one this container already has.
 *
 * `userData/botauth/<containerId>.key.json`, plaintext JWK, mode 0o600 — the
 * `mcp.json` precedent. **Windows ACLs make the mode largely symbolic and
 * saying otherwise would be theater**, so it is set and not relied on.
 *
 * NOT INSIDE THE VAULT, deliberately (§2.4). The vault idle-locks after five
 * minutes, and a signing key coupled to vault state produces an identity that
 * FLICKERS — signed traffic, then unsigned, then signed, within one session on
 * one origin. The fingerprint doctrine's whole lesson is that inconsistency is
 * the loudest signal there is, so an intermittent identity assertion is worse
 * for the user than a readable key file. The adversary who can read the file is
 * local code execution as the same OS user, who is out of envelope by
 * security.md's opening section and already owns the vault's plaintext
 * lifetime, the MCP bearer token and the browser itself. What such an adversary
 * GAINS here is impersonation of this container's agent identity until the
 * human unpublishes the public key from their directory — and "edit a JSON file
 * you host" is the revocation story, stated as such.
 *
 * GENERATED, NEVER IMPORTED (§2.2). There is no path in this file that reads a
 * private JWK the user supplied: the key file is one this process wrote, and
 * the only other producer is the dev seed (§7.4), which is a committed test
 * fixture behind a main-process flag on an unpackaged build. An import feature
 * is a second code path plus a standing invitation to move private keys through
 * chat windows, for a custody story that does not exist.
 */
async function loadOrCreateKey(containerId: string): Promise<HeldKey> {
  const path = join(botauthDir(), `${containerId}.key.json`);
  let jwk: Record<string, unknown> | null = null;
  try {
    jwk = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    jwk = null;
  }

  if (jwk && jwk['kty'] === 'OKP' && jwk['crv'] === 'Ed25519' && typeof jwk['d'] === 'string') {
    return fromPrivateJwk(jwk);
  }

  const { privateKey } = generateKeyPairSync('ed25519');
  const fresh = privateKey.export({ format: 'jwk' }) as Record<string, unknown>;
  await mkdir(botauthDir(), { recursive: true });
  await writeFile(path, `${JSON.stringify(fresh, null, 2)}\n`, { mode: 0o600 });
  return fromPrivateJwk(fresh);
}

function fromPrivateJwk(jwk: Record<string, unknown>): HeldKey {
  const privateKey = createPrivateKey({ key: jwk as never, format: 'jwk' });
  const pub = createPublicKey(privateKey).export({ format: 'jwk' }) as Record<string, unknown>;
  const publicJwk: OkpPublicJwk = { kty: 'OKP', crv: 'Ed25519', x: String(pub['x']) };
  return { privateKey, keyid: jwkThumbprint(publicJwk), publicJwk };
}

/**
 * The ready-to-publish JWKS, written next to the key.
 *
 * `userData/botauth/<containerId>.directory.json`. Hosting it at
 * `https://<their-host>/.well-known/http-message-signatures-directory` is the
 * human's job and out of Aperture's scope (§6); what Aperture owes them is a
 * file they can upload without composing one by hand.
 */
async function writeDirectoryExport(containerId: string, key: HeldKey): Promise<string> {
  const path = join(botauthDir(), `${containerId}.directory.json`);
  const body = { keys: [{ ...key.publicJwk, kid: key.keyid }] };
  await mkdir(botauthDir(), { recursive: true });
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

// ---------------------------------------------------------------------------
// The dev seed (§7.4).
// ---------------------------------------------------------------------------

/**
 * `--seed-botauth=<path>` — main-process argv, dev builds only.
 *
 * The `--seed-vault` pattern exactly: not reachable from MCP, from IPC, from an
 * env var, or from a page, and gated on `!app.isPackaged` INSIDE this function
 * rather than at the call site, so there is one place the gate can be checked
 * and one place it can be wrong. In-memory only — nothing is written to
 * `userData`, so a dev run cannot leave a key or a directory export behind for
 * a real container to pick up.
 *
 * The keypair it reads is a COMMITTED TEST FIXTURE that says so in its own
 * first field. File config never reads it; only this flag does.
 */
function seedPath(): string | null {
  const flag = process.argv.find((a) => a.startsWith('--seed-botauth='));
  if (!flag) return null;
  if (app.isPackaged) {
    console.error('[aperture] --seed-botauth refused: this is a packaged build');
    return null;
  }
  return flag.slice('--seed-botauth='.length);
}

// ---------------------------------------------------------------------------
// Startup.
// ---------------------------------------------------------------------------

export interface InstallOptions {
  /** Container ids that are ephemeral (§5.3). */
  isEphemeral: (containerId: string) => boolean;
}

/**
 * Load config, arm keys, register the signing handler. Called once, at startup.
 *
 * KEYS ARE MADE HERE AND NOT LAZILY PER REQUEST (§5): the signing path does no
 * I/O and no generation, because it runs inside `onBeforeSendHeaders` on the
 * critical path of every navigation in the browser. Rotation is manual — delete
 * `<containerId>.key.json`, restart, republish — and that is the whole
 * lifecycle.
 *
 * Every failure below is loud and none of them stop the browser: a config error
 * must never be quieter than the feature it disables (§6).
 */
export async function installBotAuth(opts: InstallOptions): Promise<void> {
  const seed = seedPath();
  const parsed = seed
    ? await loadSeedConfig(seed)
    : await loadFileConfig(opts);

  for (const line of parsed.errors) console.error(`[aperture] botauth: ${line}`);

  const ids = Object.keys(parsed.config.containers);
  if (ids.length === 0) {
    state.config = null;
    // Not an error and not silence. "No directory URL configured ⇒ signing is
    // structurally off" (§2) is the default state of this product, and a line
    // saying so is what tells a human who edited the file that it did not take.
    console.log('[aperture] botauth: no container is configured for request signing');
    return;
  }

  for (const id of ids) {
    const container = parsed.config.containers[id]!;
    try {
      const key = seed ? await seedKey(seed) : await loadOrCreateKey(id);
      state.keys.set(id, key);
      const exported = seed ? '(dev seed — nothing written)' : await writeDirectoryExport(id, key);
      logContainer(container, key, exported);
    } catch (err) {
      delete parsed.config.containers[id];
      console.error(
        `[aperture] botauth: container "${id}" has no usable key ` +
          `(${err instanceof Error ? err.message : String(err)}) — signing off for it`,
      );
    }
  }

  state.config = Object.keys(parsed.config.containers).length > 0 ? parsed.config : null;
  if (!state.config) return;

  registerBeforeSendHeaders('botauth', signIfEligible);
}

/**
 * The human's audit surface: one line per signing-enabled container.
 *
 * Container id, key thumbprint, directory URL and the whole allowlist. These
 * lines are the ONLY place any of that is disclosed — the tab strip's existing
 * agent-tab marking already shows WHICH tabs can produce signed traffic, and
 * nothing agent-facing carries any of it.
 */
function logContainer(c: ContainerSigning, key: HeldKey, exported: string): void {
  const targets = [...c.domains, ...c.origins].join(', ');
  console.log(
    `[aperture] botauth: container "${c.containerId}" signs agent main-frame requests to [${targets}] ` +
      `as ${c.directoryUrl} (keyid ${key.keyid}); publish ${exported} at ` +
      '<directoryUrl>/.well-known/http-message-signatures-directory',
  );
}

async function loadFileConfig(opts: InstallOptions): Promise<ReturnType<typeof parseBotAuthConfig>> {
  const path = join(app.getPath('userData'), 'botauth.json');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    // No file is the ordinary case and is not an error: the feature is opt-in
    // by a deliberate human edit, and §2's ruling is that no directory URL
    // means signing is structurally off rather than defaulted off.
    return { config: { containers: {} }, errors: [] };
  }
  return parseBotAuthConfig(text, ORIGIN_FNS, { ephemeral: opts.isEphemeral });
}

/**
 * §7.4's in-memory config: default container, loopback directory, loopback
 * allowlist. Nothing written to `userData`, and the loopback HTTP directory is
 * allowed HERE and nowhere else — real file config may not carry one.
 */
async function loadSeedConfig(path: string): Promise<ReturnType<typeof parseBotAuthConfig>> {
  const text = JSON.stringify({
    version: 1,
    containers: {
      default: {
        directoryUrl: 'http://127.0.0.1:8902',
        sign: ['http://127.0.0.1:8902'],
      },
    },
  });
  const parsed = parseBotAuthConfig(text, ORIGIN_FNS, { allowInsecureDirectory: true });
  try {
    await readFile(path, 'utf8');
  } catch {
    parsed.errors.push(`--seed-botauth: cannot read ${path} — signing is off`);
    return { config: { containers: {} }, errors: parsed.errors };
  }
  console.log(
    '[aperture] ############ --seed-botauth: DEV SIGNING KEY LOADED FROM A COMMITTED ' +
      'TEST FIXTURE. DEV BUILD ONLY. NEVER AN IDENTITY. ############',
  );
  return parsed;
}

async function seedKey(path: string): Promise<HeldKey> {
  const jwk = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  return fromPrivateJwk(jwk);
}

// ---------------------------------------------------------------------------
// The signing path.
// ---------------------------------------------------------------------------

/**
 * The mux handler. Returns the three signature headers, or null.
 *
 * SYNCHRONOUS, ALLOCATION-LIGHT, AND WITHOUT ANY I/O. It runs on every request
 * in the browser, and the overwhelming majority of them leave on the first
 * `decideSigning` refusal.
 *
 * NOTHING HERE READS A RESPONSE (§3, §8.3). There is no `Accept-Signature`
 * handling, no block-page detection, no retry: the predicate reads
 * configuration, the tab and the request, and that is the whole of its input.
 * A server that wants to solicit an identity disclosure has no header it can
 * send to get one.
 */
function signIfEligible(req: MuxRequest): Record<string, string> | null {
  const config = state.config;
  if (!config) return null;

  const attribution =
    req.webContentsId === undefined
      ? null
      : (state.attribution?.forWebContents(req.webContentsId) ?? null);

  const decision = decideSigning(
    {
      resourceType: req.resourceType,
      tabAgentOwned: attribution?.agentOwned ?? false,
      containerId: attribution?.container ?? null,
      targetUrl: req.url,
      config,
    },
    ORIGIN_FNS,
  );
  if (!decision.sign) return null;

  const key = state.keys.get(decision.container.containerId);
  if (!key) return null;

  try {
    const prepared = prepareSignature(
      { method: req.method, url: req.url, headers: req.headers },
      {
        created: Math.floor(Date.now() / 1000),
        // 64 CSPRNG bytes, base64url. `crypto.randomBytes`, NEVER
        // `Math.random` — the envelope-nonce house rule. A fresh nonce per
        // request is what lets any verifier that cares close replay entirely;
        // each redirect hop gets its own, because each hop is a fresh request
        // through this handler with no state carried.
        nonce: randomBytes(64).toString('base64url'),
        keyid: key.keyid,
        directoryUrl: decision.container.directoryUrl,
        form: SHIPPED_SIGNATURE_AGENT_FORM,
      },
    );
    const signature = sign(null, Buffer.from(prepared.base, 'ascii'), key.privateKey);
    return {
      'Signature-Agent': prepared.signatureAgent,
      'Signature-Input': prepared.signatureInput,
      Signature: signatureHeaderValue(signature),
    };
  } catch (err) {
    // Unsigned is the safe direction. A malformed URL, a header the sf-string
    // rules refuse — none of them may take the navigation with them.
    console.error(
      `[aperture] botauth: could not sign ${req.method} request ` +
        `(${err instanceof Error ? err.message : String(err)}); sent unsigned`,
    );
    return null;
  }
}

/** The expiry window, re-exported so the guard block can assert on one constant. */
export { EXPIRY_SECONDS };
