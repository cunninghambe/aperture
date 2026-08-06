import { createPrivateKey, sign as edSign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  EXPIRY_SECONDS,
  SHIPPED_SIGNATURE_AGENT_FORM,
  SIG_LABEL,
  WBA_TAG,
  coveredComponents,
  decideSigning,
  jwkThumbprint,
  parseBotAuthConfig,
  prepareSignature,
  serializeComponent,
  sfString,
  signatureAgentValue,
  signatureBase,
  signatureHeaderValue,
  signatureParamsValue,
  type BotAuthConfig,
  type Component,
  type ContainerSigning,
  type OriginFns,
  type SignContext,
} from '../src/net/botAuthCore.js';
import { occurrences, sources } from './lib/source.js';

/**
 * WEB BOT AUTH — THE UNIT GUARDS.
 *
 * `docs/design/webbotauth.md` is the decision record; every assertion below
 * names the clause it holds. Three kinds of thing live here and they are not
 * interchangeable:
 *
 *   · EXTERNAL VECTORS. RFC 9421 Appendix B.2.6 and RFC 8037 Appendix A.3,
 *     copied from the RFC text rather than from any document in this repo. A
 *     vector transcribed from our own prose proves that our prose and our code
 *     agree, which is the one thing an external vector exists to avoid proving.
 *     Ed25519 is deterministic (RFC 8032), so B.2.6 is asserted as EXACT
 *     SIGNATURE BYTES rather than as a verify-roundtrip: a roundtrip shows a
 *     pair agrees, byte equality shows what it agrees ON.
 *
 *   · THE PREDICATE MATRIX. §3's S1-S4, exhaustively, plus the traps §7.2
 *     names. This is possible only because `botAuthCore.ts` is a pure leaf and
 *     the predicate is a function of configuration, tab state and the request —
 *     no response, no clock, no I/O. `engine.ts` imports `electron` and that is
 *     why two lifetime members have rulings and no runtime measurement
 *     anywhere; this module does not repeat that.
 *
 *   · SOURCE GUARDS, over `test/lib/source.ts` — one parser, the house rule.
 *     The singleton guard is RECEIVER-INDEPENDENT because S-E3 measured what a
 *     lexical receiver check is worth: the same affordance was RED where a
 *     `const wc = …` binding existed and GREEN where it was written inline.
 *
 * WHAT THIS FILE CANNOT DO, stated because every guard in this repo states it.
 * It cannot execute the wiring. `botAuth.ts` imports `electron`, so nothing
 * here runs the mux, the key store, or the handler — those are G33a-e's job,
 * and the pure leaf is drawn exactly where it is so that the part a unit test
 * CAN reach is the part that decides anything.
 */

// ---------------------------------------------------------------------------
// The one spelling of each origin fact, taken from the modules that own it.
// ---------------------------------------------------------------------------

const scratch = '/nonexistent-aperture-botauth-test';
vi.mock('electron', () => ({ app: { getPath: () => scratch } }));

const { registrableDomain } = await import('../src/vault/vault.js');
const { originOf } = await import('../src/shared/origin.js');

/**
 * Injected rather than imported by the leaf, and REAL rather than stubbed here.
 *
 * A matrix run against a toy `registrableDomain` would be a matrix about the
 * toy. The whole reason §3 S1 routes through the vault's own function is that
 * there is one spelling of "which registrable domain is this" in the product,
 * and these tests are only about the shipped predicate if they use it.
 */
const FNS: OriginFns = { registrableDomain, originOf };

// ---------------------------------------------------------------------------
// 1. RFC 9421 Appendix B — external vectors, copied from the RFC.
// ---------------------------------------------------------------------------

/** RFC 9421 B.1.4, the JWK form printed in the RFC. */
const B14 = {
  kty: 'OKP' as const,
  crv: 'Ed25519' as const,
  d: 'n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU',
  x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs',
};

/** The B.2 `test-request` message, as the fields a signer reads. */
const B2_REQUEST = {
  method: 'POST',
  url: 'http://example.com/foo?param=Value&Pet=dog',
  headers: {
    host: 'example.com',
    date: 'Tue, 20 Apr 2021 02:07:55 GMT',
    'content-type': 'application/json',
    'content-digest':
      'sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:',
    'content-length': '18',
  },
};

const B26_COMPONENTS: Component[] = [
  { name: 'date' },
  { name: '@method' },
  { name: '@path' },
  { name: '@authority' },
  { name: 'content-type' },
  { name: 'content-length' },
];

/** B.2.6's signature base, copied line for line from the RFC text. */
const B26_BASE =
  '"date": Tue, 20 Apr 2021 02:07:55 GMT\n' +
  '"@method": POST\n' +
  '"@path": /foo\n' +
  '"@authority": example.com\n' +
  '"content-type": application/json\n' +
  '"content-length": 18\n' +
  '"@signature-params": ("date" "@method" "@path" "@authority" "content-type" ' +
  '"content-length");created=1618884473;keyid="test-key-ed25519"';

/** B.2.6's signature, copied from the RFC text. */
const B26_SIGNATURE =
  'wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==';

describe('RFC 9421 Appendix B.2.6, byte for byte', () => {
  const paramsValue = signatureParamsValue(B26_COMPONENTS, [
    ['created', 1618884473],
    ['keyid', 'test-key-ed25519'],
  ]);

  it('builds the signature base the RFC prints', () => {
    expect(signatureBase(B2_REQUEST, B26_COMPONENTS, paramsValue)).toBe(B26_BASE);
  });

  it('produces the exact signature bytes the RFC prints', () => {
    // Ed25519 is deterministic, so this is an equality and not a roundtrip.
    // A verify-roundtrip against our own base would pass for any base we and
    // only we compute; this fails unless the bytes are the RFC's.
    const key = createPrivateKey({ key: B14, format: 'jwk' });
    const base = signatureBase(B2_REQUEST, B26_COMPONENTS, paramsValue);
    expect(edSign(null, Buffer.from(base, 'ascii'), key).toString('base64')).toBe(B26_SIGNATURE);
  });

  it('has no trailing newline — the ABNF is *( line LF ) params-line', () => {
    // The single most common way two implementations produce different bytes
    // from the same intent, and invisible in any assertion that trims.
    expect(B26_BASE.endsWith('\n')).toBe(false);
    expect(signatureBase(B2_REQUEST, B26_COMPONENTS, paramsValue).endsWith('\n')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Canonicalization edges (§7.2 item 2).
// ---------------------------------------------------------------------------

describe('canonicalization edges', () => {
  const P = signatureParamsValue([{ name: '@authority' }], [['created', 1]]);
  const authority = (url: string): string =>
    signatureBase({ method: 'GET', url, headers: {} }, [{ name: '@authority' }], P).split('\n')[0]!;
  const path = (url: string): string =>
    signatureBase({ method: 'GET', url, headers: {} }, [{ name: '@path' }], P).split('\n')[0]!;

  it('lowercases the authority', () => {
    expect(authority('https://Example.COM/x')).toBe('"@authority": example.com');
  });

  it('elides the default port and keeps a non-default one', () => {
    expect(authority('http://example.com:80/x')).toBe('"@authority": example.com');
    expect(authority('https://example.com:443/x')).toBe('"@authority": example.com');
    // The guard fixture's own authority. A verifier that dropped this port
    // would rebuild a different base for every request on 8902.
    expect(authority('http://127.0.0.1:8902/page')).toBe('"@authority": 127.0.0.1:8902');
    expect(authority('https://example.com:8443/x')).toBe('"@authority": example.com:8443');
    // The other direction: a port that is default for the OTHER scheme stays.
    expect(authority('http://example.com:443/x')).toBe('"@authority": example.com:443');
    expect(authority('https://example.com:80/x')).toBe('"@authority": example.com:80');
  });

  it('excludes the query from @path, and normalizes an empty path to /', () => {
    expect(path('https://example.com/a/b?q=1&r=2')).toBe('"@path": /a/b');
    expect(path('https://example.com?q=1')).toBe('"@path": /');
    expect(path('https://example.com')).toBe('"@path": /');
    expect(path('https://example.com/?')).toBe('"@path": /');
  });

  it('preserves percent-encoding exactly as sent, rather than decoding it', () => {
    // RFC 9421 §2.2.6: "before decoding any percent-encoded octets". A verifier
    // reads the bytes off the request line; decoding on our side would make the
    // two disagree for every path containing an escape.
    expect(path('https://example.com/a%2Fb')).toBe('"@path": /a%2Fb');
    expect(path('https://example.com/caf%C3%A9')).toBe('"@path": /caf%C3%A9');
    expect(path('https://example.com/a%20b')).toBe('"@path": /a%20b');
  });

  it('uppercases the method', () => {
    const line = signatureBase({ method: 'get', url: 'https://example.com/', headers: {} }, [{ name: '@method' }], P);
    expect(line.split('\n')[0]).toBe('"@method": GET');
  });

  it('refuses a duplicate covered component rather than signing a base a verifier cannot rebuild', () => {
    expect(() =>
      signatureBase(B2_REQUEST, [{ name: '@method' }, { name: '@method' }], P),
    ).toThrow(/duplicate/i);
  });

  it('refuses to put a non-ASCII byte in the base', () => {
    // §2.5 step 4. Silently transcoding would make the signature cover
    // different bytes than the header carries, which is the one failure a
    // signature cannot express.
    expect(() => sfString('https://exämple.test')).toThrow(/ASCII/i);
  });

  it('escapes the two characters an sf-string must escape', () => {
    expect(sfString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

// ---------------------------------------------------------------------------
// 3. Thumbprints — RFC 8037 A.3 (§7.2 item 4).
// ---------------------------------------------------------------------------

describe('RFC 7638 / RFC 8037 thumbprint', () => {
  it('reproduces RFC 8037 A.3\'s worked example', () => {
    expect(
      jwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' }),
    ).toBe('kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k');
  });

  it('is taken over crv, kty and x in that order — RFC 7638 §3.2', () => {
    // The lexicographic order is not decorative: any other order hashes
    // different bytes, and the failure is a keyid the directory does not
    // contain, which is silent everywhere except at the verifier.
    expect(jwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: B14.x })).toBe(
      'poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. The wire format (§4).
// ---------------------------------------------------------------------------

describe('the pinned wire format', () => {
  const INPUTS = {
    created: 1735689600,
    nonce: 'A'.repeat(86),
    keyid: 'poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U',
    directoryUrl: 'https://bots.example.net',
    form: SHIPPED_SIGNATURE_AGENT_FORM,
  } as const;

  const prepared = prepareSignature(
    { method: 'GET', url: 'http://127.0.0.1:8902/page', headers: {} },
    INPUTS,
  );

  it('covers @authority, @method, @path and signature-agent, in that order', () => {
    expect(coveredComponents('sf-string').map(serializeComponent)).toEqual([
      '"@authority"',
      '"@method"',
      '"@path"',
      '"signature-agent"',
    ]);
    expect(coveredComponents('sf-dict').map(serializeComponent)).toEqual([
      '"@authority"',
      '"@method"',
      '"@path"',
      '"signature-agent";key="sig1"',
    ]);
  });

  it('emits label sig1, tag web-bot-auth, and a 300-second window', () => {
    expect(prepared.signatureInput.startsWith(`${SIG_LABEL}=(`)).toBe(true);
    expect(prepared.signatureInput).toContain(`;tag="${WBA_TAG}"`);
    expect(EXPIRY_SECONDS).toBe(300);
    const created = Number(/;created=(\d+)/.exec(prepared.signatureInput)![1]);
    const expires = Number(/;expires=(\d+)/.exec(prepared.signatureInput)![1]);
    expect(expires - created).toBe(300);
  });

  it('covers the Signature-Agent value it actually sends', () => {
    // The draft requires the header to be covered when it is sent, and the base
    // must carry the SAME bytes the header does. Two spellings of one value is
    // a signature nobody can verify.
    expect(prepared.base).toContain(`"signature-agent": ${prepared.signatureAgent}`);
    expect(prepared.signatureAgent).toBe('"https://bots.example.net"');
  });

  it('sends no `alg` — the key the directory publishes determines the algorithm', () => {
    // §4 does not list it; RFC 9421 §7.3.7 warns against a verifier trusting
    // it. The probe measures that Cloudflare's verifier does not require it.
    expect(prepared.signatureInput).not.toContain(';alg=');
  });

  it('serializes the Signature header as a byte sequence under the same label', () => {
    expect(signatureHeaderValue(new Uint8Array([1, 2, 3]))).toBe('sig1=:AQID:');
  });

  it('spells the two candidate Signature-Agent forms distinctly', () => {
    expect(signatureAgentValue('https://x.test', 'sf-string')).toBe('"https://x.test"');
    expect(signatureAgentValue('https://x.test', 'sf-dict')).toBe('sig1="https://x.test"');
  });
});

// ---------------------------------------------------------------------------
// 5. The predicate matrix (§7.2 item 3).
// ---------------------------------------------------------------------------

const CONTAINER: ContainerSigning = {
  containerId: 'default',
  directoryUrl: 'https://bots.example.net',
  domains: ['example.com'],
  origins: ['http://127.0.0.1:8902'],
};
const CONFIG: BotAuthConfig = { containers: { default: CONTAINER } };

function ctx(over: Partial<SignContext> = {}): SignContext {
  return {
    resourceType: 'mainFrame',
    tabAgentOwned: true,
    containerId: 'default',
    targetUrl: 'https://www.example.com/page',
    config: CONFIG,
    ...over,
  };
}

const signs = (over: Partial<SignContext> = {}): boolean => decideSigning(ctx(over), FNS).sign;

describe('the §3 predicate, exhaustively over S1-S4', () => {
  // S1 allowlisted · S2 mainFrame · S3 agentOwned · S4 configured container.
  // Sixteen rows, one true. Written as a product rather than as sixteen `it`s
  // so that a clause added to the predicate cannot be covered by fifteen rows
  // that happen not to reach it.
  const AXES = {
    S1: { yes: 'https://www.example.com/page', no: 'https://not-allowlisted.test/page' },
    S2: { yes: 'mainFrame', no: 'xhr' },
    S3: { yes: true, no: false },
    S4: { yes: 'default', no: 'other' },
  };

  for (const s1 of ['yes', 'no'] as const) {
    for (const s2 of ['yes', 'no'] as const) {
      for (const s3 of ['yes', 'no'] as const) {
        for (const s4 of ['yes', 'no'] as const) {
          const all = s1 === 'yes' && s2 === 'yes' && s3 === 'yes' && s4 === 'yes';
          it(`S1=${s1} S2=${s2} S3=${s3} S4=${s4} ⇒ ${all ? 'sign' : 'do not sign'}`, () => {
            expect(
              signs({
                targetUrl: AXES.S1[s1],
                resourceType: AXES.S2[s2],
                tabAgentOwned: AXES.S3[s3],
                containerId: AXES.S4[s4],
              }),
            ).toBe(all);
          });
        }
      }
    }
  }
});

describe('the named traps', () => {
  it('a HUMAN tab on an allowlisted origin is never signed — S3', () => {
    // A Web Bot Auth signature asserts "automated agent traffic". A human's tab
    // is shared authorship, and a false bot assertion on human browsing is the
    // anti-detect lie inverted: the doctrine cuts against false claims in BOTH
    // directions. The remedy is `browser_tabs action:"open"`, not a widened S3.
    expect(signs({ tabAgentOwned: false })).toBe(false);
    expect(signs({ tabAgentOwned: false, targetUrl: 'http://127.0.0.1:8902/page' })).toBe(false);
    expect(decideSigning(ctx({ tabAgentOwned: false }), FNS)).toEqual({
      sign: false,
      why: 'not-agent-owned',
    });
  });

  it('no tab at all — an unwired attribution resolver — signs nothing', () => {
    // The asymmetry index.ts states at the injection site: an unwired origin
    // scope redacts nothing, which is catastrophic; an unwired attribution
    // resolver signs nothing, which is merely off.
    expect(decideSigning(ctx({ containerId: null }), FNS)).toEqual({ sign: false, why: 'no-tab' });
  });

  it('no config at all signs nothing — §2, structurally off without a directory URL', () => {
    expect(decideSigning(ctx({ config: null }), FNS)).toEqual({ sign: false, why: 'no-config' });
  });

  it('an empty allowlist signs nothing, on any origin', () => {
    const empty: BotAuthConfig = {
      containers: { default: { ...CONTAINER, domains: [], origins: [] } },
    };
    for (const url of ['https://www.example.com/x', 'http://127.0.0.1:8902/x', 'https://example.com/']) {
      expect(decideSigning(ctx({ config: empty, targetUrl: url }), FNS)).toEqual({
        sign: false,
        why: 'not-allowlisted',
      });
    }
  });

  it('EVERY resourceType but mainFrame is refused — the gate is an equality, not a denylist', () => {
    // THE SABOTAGE THIS ROW EXISTS FOR: `resourceType !== 'subFrame'` reads
    // plausibly ("don't sign frames") and signs `image` and `xhr`, which
    // re-opens the fetch() minting oracle S2 closes. Enumerating every value
    // Electron can produce is what makes the halfway spellings fail too.
    const ALL = [
      'mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font', 'object',
      'xhr', 'ping', 'cspReport', 'media', 'webSocket', 'other',
    ];
    for (const rt of ALL) expect(signs({ resourceType: rt })).toBe(rt === 'mainFrame');
  });

  it('subdomains of a domain entry are in; a sibling tenant of a shared host is not', () => {
    for (const url of ['https://example.com/', 'https://a.example.com/', 'https://a.b.example.com/']) {
      expect(signs({ targetUrl: url })).toBe(true);
    }
    // The PSL's private section is what keeps tenants apart, and it is why
    // `allowPrivateDomains` is load-bearing in the vault's own function.
    const tenants: BotAuthConfig = {
      containers: { default: { ...CONTAINER, domains: ['victim.github.io'], origins: [] } },
    };
    expect(decideSigning(ctx({ config: tenants, targetUrl: 'https://victim.github.io/x' }), FNS).sign).toBe(true);
    expect(decideSigning(ctx({ config: tenants, targetUrl: 'https://attacker.github.io/x' }), FNS).sign).toBe(false);
  });

  it('a null registrableDomain matches NOTHING — never another null, never a bucket', () => {
    // `registrableDomain` answers null for a host whose suffix is not in the
    // PSL and for a bare public suffix. A null-equality comparison would pool
    // every such origin into one identity, which is `originOf`'s documented
    // failure transplanted into a new module.
    expect(registrableDomain('https://a.b.notarealtld')).toBeNull();
    expect(registrableDomain('https://c.d.alsonotreal')).toBeNull();
    const nulls: BotAuthConfig = {
      containers: { default: { ...CONTAINER, domains: ['a.b.notarealtld'], origins: [] } },
    };
    // Both sides null. Neither may match — not the entry itself, and above all
    // not the OTHER null-yielding origin.
    expect(decideSigning(ctx({ config: nulls, targetUrl: 'https://c.d.alsonotreal/x' }), FNS).sign).toBe(false);
    expect(decideSigning(ctx({ config: nulls, targetUrl: 'https://a.b.notarealtld/x' }), FNS).sign).toBe(false);
  });

  it('an exact-origin entry matches on scheme, host AND port — nothing coarser', () => {
    // THE CONSTRUCTIBLE FORM OF G33b's SECOND SABOTAGE ROW. The spec's version
    // — route exact-origin entries through registrableDomain() "for
    // uniformity", both 127.0.0.1 and localhost yield null, a null bucket
    // matches them to each other — CANNOT BE BUILT against this tree, because
    // `registrableDomain` returns the HOST for a literal address and for
    // `localhost`, not null (src/vault/vault.ts: "literal addresses have no
    // registrable domain; they are their own identity"). Under that refactor
    // 127.0.0.1 and localhost stay distinct and the guard's control stays
    // green.
    //
    // The CLASS still bites, one granularity up: registrableDomain() throws
    // away the scheme and the port, so the same tidiness refactor makes an
    // exact-origin entry match every port and both schemes on that host. This
    // row is that instance, and it is red under exactly the substitution the
    // spec's row describes.
    expect(signs({ targetUrl: 'http://127.0.0.1:8902/page' })).toBe(true);
    for (const other of [
      'http://localhost:8902/page',   // the G33b control
      'http://127.0.0.1:9999/page',   // another port — what the refactor pools
      'https://127.0.0.1:8902/page',  // another scheme — likewise
      'http://127.0.0.2:8902/page',
      'http://10.0.0.199:8902/page',
    ]) {
      expect(signs({ targetUrl: other }), other).toBe(false);
    }
  });

  it('an unparseable target signs nothing', () => {
    for (const url of ['not a url', '', 'about:blank', 'data:text/html,x']) {
      expect(signs({ targetUrl: url }), url).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Config validation (§6, §5) — fails closed per entry, never throws.
// ---------------------------------------------------------------------------

const ok = (sign: string[], directoryUrl = 'https://bots.example.net'): string =>
  JSON.stringify({ version: 1, containers: { default: { directoryUrl, sign } } });

describe('config validation', () => {
  it('accepts the §6 example', () => {
    const { config, errors } = parseBotAuthConfig(
      JSON.stringify({
        version: 1,
        containers: {
          default: {
            directoryUrl: 'https://bots.example.net',
            sign: ['example.com', 'https://tools.example.net', 'http://10.0.0.199:8080'],
          },
        },
      }),
      FNS,
    );
    expect(errors).toEqual([]);
    expect(config.containers['default']).toEqual({
      containerId: 'default',
      directoryUrl: 'https://bots.example.net',
      domains: ['example.com'],
      origins: ['https://tools.example.net', 'http://10.0.0.199:8080'],
    });
  });

  it('never throws, whatever it is handed', () => {
    // The loader runs at startup on a file a human edited. A throw here is a
    // browser that does not start because of a stray comma.
    for (const junk of ['', '{', 'null', '[]', '"x"', '{"version":2}', '{"version":1}', '{"version":1,"containers":[]}']) {
      expect(() => parseBotAuthConfig(junk, FNS), junk).not.toThrow();
      expect(parseBotAuthConfig(junk, FNS).config.containers, junk).toEqual({});
    }
  });

  it('is loud about every refusal — a config error must never be quieter than the feature', () => {
    for (const junk of ['{', 'null', '{"version":2}', '{"version":1,"containers":[]}']) {
      expect(parseBotAuthConfig(junk, FNS).errors.length, junk).toBeGreaterThan(0);
    }
  });

  it('refuses a directoryUrl that is not https, and says so', () => {
    const { config, errors } = parseBotAuthConfig(ok(['example.com'], 'http://bots.example.net'), FNS);
    expect(config.containers).toEqual({});
    expect(errors.join(' ')).toMatch(/https/);
  });

  it('allows loopback http ONLY on the seeded dev path', () => {
    const seeded = parseBotAuthConfig(ok(['example.com'], 'http://127.0.0.1:8902'), FNS, {
      allowInsecureDirectory: true,
    });
    expect(seeded.errors).toEqual([]);
    expect(Object.keys(seeded.config.containers)).toEqual(['default']);
  });

  it('refuses a host that is not its own registrable domain, naming the canonical form', () => {
    // Silently canonicalizing would make the file claim something the human did
    // not write.
    const { config, errors } = parseBotAuthConfig(ok(['www.example.com']), FNS);
    expect(config.containers).toEqual({});
    expect(errors.join(' ')).toContain('"example.com"');
  });

  it('refuses a bare public suffix and an unknown suffix', () => {
    for (const entry of ['github.io', 'a.b.notarealtld']) {
      expect(parseBotAuthConfig(ok([entry]), FNS).config.containers, entry).toEqual({});
    }
  });

  it('refuses an address literal or single-label host as a DOMAIN entry', () => {
    // A DEVIATION, FAILING CLOSED — implementation report item 1. §3 S1 says
    // registrableDomain() returns null for these; it does not, it returns the
    // host. So `127.0.0.1` would pass the "equals its own registrable domain"
    // check and then match at domain granularity: every port and BOTH schemes.
    // Refused here, naming the exact-origin spelling that does what the human
    // meant.
    for (const entry of ['127.0.0.1', 'localhost', '10.0.0.199']) {
      const { config, errors } = parseBotAuthConfig(ok([entry]), FNS);
      expect(config.containers, entry).toEqual({});
      expect(errors.join(' '), entry).toMatch(/exact origin/);
    }
    // ...and the exact-origin spelling of the same thing is accepted.
    const good = parseBotAuthConfig(ok(['http://127.0.0.1:8902']), FNS);
    expect(good.errors).toEqual([]);
    expect(good.config.containers['default']!.origins).toEqual(['http://127.0.0.1:8902']);
  });

  it('refuses an ephemeral container — §5.3', () => {
    // An ephemeral container is the maximal-unlinkability primitive; a
    // persistent identity assertion inside one is a contradiction.
    const { config, errors } = parseBotAuthConfig(ok(['example.com']), FNS, {
      ephemeral: (id) => id === 'default',
    });
    expect(config.containers).toEqual({});
    expect(errors.join(' ')).toMatch(/ephemeral/);
  });

  it('a duplicate directoryUrl disables BOTH containers — §5.2, never a winner', () => {
    // THE SABOTAGE THIS ROW EXISTS FOR: "pick a winner" (last-writer-wins) is
    // what a reasonable implementer does with a duplicate key, and it silently
    // grants one container an identity the human ambiguously assigned. The
    // Signature-Agent VALUE is itself an identifier: two containers sending it
    // are linkable by any origin allowlisted in both, which defeats the
    // container boundary through a side door the per-container keys had closed.
    const { config, errors } = parseBotAuthConfig(
      JSON.stringify({
        version: 1,
        containers: {
          work: { directoryUrl: 'https://bots.example.net', sign: ['example.com'] },
          personal: { directoryUrl: 'https://bots.example.net', sign: ['example.org'] },
          third: { directoryUrl: 'https://other.example.net', sign: ['example.net'] },
        },
      }),
      FNS,
    );
    expect(Object.keys(config.containers)).toEqual(['third']);
    expect(errors.join(' ')).toMatch(/2 containers/);
    // And a container that was never in the duplicate keeps working — the rule
    // is scoped to the containers that share the URL, not to the file.
    expect(config.containers['third']!.domains).toEqual(['example.net']);
  });

  it('one bad entry disables only its own container', () => {
    const { config, errors } = parseBotAuthConfig(
      JSON.stringify({
        version: 1,
        containers: {
          good: { directoryUrl: 'https://a.example', sign: ['example.com'] },
          bad: { directoryUrl: 'https://b.example', sign: ['www.example.com'] },
        },
      }),
      FNS,
    );
    expect(Object.keys(config.containers)).toEqual(['good']);
    expect(errors.length).toBe(1);
  });

  it('refuses an empty or non-array sign list', () => {
    for (const body of [
      { directoryUrl: 'https://a.example', sign: [] },
      { directoryUrl: 'https://a.example', sign: 'example.com' },
      { directoryUrl: 'https://a.example' },
      { sign: ['example.com'] },
    ]) {
      const text = JSON.stringify({ version: 1, containers: { default: body } });
      expect(parseBotAuthConfig(text, FNS).config.containers, text).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Source guards (§7.2 items 6 and 7).
// ---------------------------------------------------------------------------

const SOURCES = sources();

describe('the mux is the one door', () => {
  it('there is exactly one `.onBeforeSendHeaders(` call site in src/, and it is the mux', () => {
    // RECEIVER-INDEPENDENT, and that is the whole assertion. S-E3 measured what
    // a lexical receiver check is worth: `webContents.downloadURL(<page URL>)`
    // was RED where a `const wc = …` binding existed and GREEN where the same
    // call was written inline — the same act, caught or missed by how its author
    // spelled the receiver. So this matches the MEMBER, wherever it is reached
    // from: `s.webRequest.onBeforeSendHeaders`, `const wr = s.webRequest; wr.…`,
    // and anything else that ends in this call.
    //
    // Electron keeps ONE listener per event per session, so a second registrant
    // silently EVICTS the first — no error, no log, the previous handler simply
    // stops being called. That is verification-queue item #4, and this is what
    // closes it by construction rather than answering it.
    const sites: string[] = [];
    for (const f of SOURCES) {
      for (const at of occurrences(f.code, '.onBeforeSendHeaders(')) {
        sites.push(`${f.rel}:${f.raw.slice(0, at).split('\n').length}`);
      }
    }
    expect(
      sites.map((s) => s.split(':')[0]),
      'A SECOND onBeforeSendHeaders REGISTRATION. Electron keeps one listener per ' +
        'event per session: whichever of these runs second silently evicts the ' +
        'first, and nothing anywhere reports it. Register through ' +
        'webRequestMux.registerBeforeSendHeaders instead.',
    ).toEqual(['src/net/webRequestMux.ts']);
  });

  it('the mux is installed from containers.harden, on the CONTAINER session', () => {
    // G33a's second sabotage row is "register on session.defaultSession
    // instead": every unit test stays green, the wiring is plausible, and no
    // header appears anywhere on the wire because no tab ever loads there (E5).
    // A source guard cannot see which session an expression evaluates to — that
    // is G33a's job — but it can see that the call is inside `harden` and that
    // `defaultSession` is not named in this file at all.
    const containers = SOURCES.find((f) => f.rel === 'src/privacy/containers.ts')!;
    expect(containers.code).toMatch(/installMux\(/);
    expect(containers.code, 'the mux must not be installed on the default session').not.toMatch(
      /defaultSession/,
    );
    const at = containers.code.indexOf('installMux(s)');
    expect(at).toBeGreaterThan(containers.code.indexOf('private harden('));
  });
});

describe('the module surface', () => {
  /** Which files import each of the three new modules, from anywhere in src/. */
  function importersOf(module: string): string[] {
    const out: string[] = [];
    for (const f of SOURCES) {
      if (f.rel === `src/net/${module}.ts`) continue;
      if (new RegExp(`from\\s+'[^']*${module}(\\.js)?'`).test(f.raw) && f.code.includes('import')) {
        out.push(f.rel);
      }
    }
    return out.sort();
  }

  it('nothing outside the frozen list reaches for these modules', () => {
    // TOTAL IN BOTH DIRECTIONS. A new importer fails by name — which is what
    // catches an MCP tool, an IPC handler or a renderer reaching for signing
    // state — and an importer that has DISAPPEARED fails too, so this cannot
    // become the stale audit the preload `reason:` count turned out to be.
    expect(importersOf('botAuthCore')).toEqual(['src/net/botAuth.ts']);
    expect(importersOf('botAuth')).toEqual(['src/main/index.ts']);
    expect(importersOf('webRequestMux')).toEqual(['src/net/botAuth.ts', 'src/privacy/containers.ts']);
  });

  it('THE AGENT SURFACE IS ZERO — no MCP file names any of this', () => {
    // §6 and §8.4. No tool reads, writes, enables, disables or reports signing
    // config; no tool result names the key, the thumbprint, the directory URL
    // or the allowlist; the tool count does not change. The ALLOWLIST is
    // withheld deliberately — a list of origins where this browser will assert
    // an identity is a targeting map for injected content, and withholding it
    // costs nothing, because the agent can infer signing from an origin's
    // behaviour and cannot enumerate it.
    const NAMES = [
      'botAuth', 'botauth', 'BotAuth', 'signatureAgent', 'Signature-Agent',
      'directoryUrl', 'jwkThumbprint', 'decideSigning', 'installMux',
      'registerBeforeSendHeaders', 'web-bot-auth',
    ];
    const offenders: string[] = [];
    for (const f of SOURCES) {
      if (!f.rel.startsWith('src/mcp/') && !f.rel.startsWith('src/preload/') && !f.rel.startsWith('src/renderer/')) continue;
      for (const n of NAMES) if (f.quoted.includes(n)) offenders.push(`${f.rel} :: ${n}`);
    }
    expect(
      offenders,
      'AGENT-REACHABLE SIGNING STATE. The agent must be unable to cause an ' +
        'identity assertion the human did not configure, to enumerate where ' +
        'assertions happen, or to learn key material.',
    ).toEqual([]);
  });

  it('no export of botAuth.ts can return a private key', () => {
    // The load-bearing property from security.md, extended to this key: no
    // agent-facing response type has a field that can carry a secret, and the
    // key never leaves the main process. Asserted over the source because the
    // module imports `electron` and cannot be executed here.
    const botAuth = SOURCES.find((f) => f.rel === 'src/net/botAuth.ts')!;
    const exported = [...botAuth.code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)].map(
      (m) => m[1]!,
    );
    expect(exported.sort()).toEqual(['installBotAuth', 'setAttributionResolver']);
    // `privateKey` appears only inside the module; nothing returns one.
    expect(botAuth.code).not.toMatch(/return\s+[A-Za-z0-9_$.]*privateKey/);
    expect(botAuth.code).not.toMatch(/export\s+(const|let|var)\s+[A-Za-z0-9_$]*[Kk]ey/);
  });

  it('the leaf imports nothing from electron or from src/', () => {
    // The `redact.ts` / `origin.ts` precedent: the suite executes the SHIPPED
    // code rather than a copy of it. `node:crypto` is the one import and is a
    // Node builtin available identically to the main process and to vitest.
    const leaf = SOURCES.find((f) => f.rel === 'src/net/botAuthCore.ts')!;
    const imports = [...leaf.raw.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]!);
    expect(imports).toEqual(['node:crypto']);
  });

  it('nothing in src/ reads a response header to decide whether to sign — §8.3', () => {
    // No `Accept-Signature`, no block-page detection, no retry. The predicate
    // reads configuration, the tab and the request; nothing a server or a page
    // emits can turn signing on, off, or re-aim it. Matched over `quoted`, so a
    // mention in a comment (there is one, in botAuthCore's header) does not
    // count and a real string does.
    for (const f of SOURCES) {
      expect(f.quoted, f.rel).not.toMatch(/'accept-signature'|"accept-signature"|Accept-Signature/i);
      expect(f.code, f.rel).not.toMatch(/onHeadersReceived/);
    }
  });
});
