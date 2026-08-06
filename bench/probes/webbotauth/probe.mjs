import { createPrivateKey, sign as edSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { signatureHeaders, jwkToKeyID } from 'web-bot-auth';
import { Ed25519Signer, helpers, verifierFromJWK } from 'web-bot-auth/crypto';
import { verify as wbaVerify } from 'web-bot-auth';
import {
  RFC9421_B26,
  directoryIndex,
  selfTest,
  verifyRequest,
} from './verify.mjs';

/**
 * THE §4 DIFFERENTIAL PROBE.
 *
 * `docs/design/webbotauth.md` §4 could not pin one fact from where it was
 * written: the exact structured-field form of `Signature-Agent`, which moved
 * between draft revisions. It refused to guess and left a DECISION PROCEDURE
 * with one ordered fallback instead — pin the latest release of Cloudflare's
 * `web-bot-auth` npm package, byte-compare our base against its signer for the
 * same request, adopt the form it emits, and fall back to `("@authority"
 * "signature-agent")` if its verifier rejects the four-component list. This
 * file is that procedure, executed.
 *
 * RUN WITH:  node --experimental-strip-types bench/probes/webbotauth/probe.mjs
 *
 * `web-bot-auth` is depended on HERE AND NOWHERE ELSE. This directory has its
 * own `package.json`; the product's dependency set does not change, and the
 * acceptance battery diffs `package.json` to prove it. A protocol library in
 * the product would be a production dependency carrying a draft that is still
 * moving, which is the thing §4 spent its length avoiding.
 *
 * Ed25519 is deterministic (RFC 8032), so identical signature BYTES from two
 * implementations over the same key is identical signature BASE. That is why
 * the comparisons below are byte equalities rather than verify-roundtrips: a
 * roundtrip proves the pair agrees, and byte equality proves WHAT they agree
 * on.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const LIB_VERSION = JSON.parse(
  readFileSync(join(HERE, 'node_modules', 'web-bot-auth', 'package.json'), 'utf8'),
).version;

// The SHIPPED leaf, type-stripped by node rather than copied here. A probe that
// compared a transcription of our canonicalization against the library would be
// comparing two things neither of which is in the product.
const core = await import(pathToFileURL(join(ROOT, 'src', 'net', 'botAuthCore.ts')).href);

const results = [];
function record(id, claim, ok, detail = '') {
  results.push({ id, claim, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${claim}${detail ? `\n        ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/** RFC 9421 B.1.4's key. Used by the draft's own Appendix A.2 vectors too. */
const RFC_KEY = RFC9421_B26.privateJwk;
const RFC_PRIVATE = createPrivateKey({ key: RFC_KEY, format: 'jwk' });

const DIRECTORY_URL = 'https://bots.example.net';
const TARGET = 'http://127.0.0.1:8902/page?q=1';
const CREATED = 1735689600;

/** Standard base64, because the library's own `validateNonce` uses `atob`. */
const NONCE_B64 = Buffer.alloc(64, 0x5b).toString('base64');
/** What Aperture actually emits: base64url, per the draft's §4.2.2. */
const NONCE_B64URL = Buffer.from(
  Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256),
).toString('base64url');

// ---------------------------------------------------------------------------
// 0. The instrument, before it judges anything.
// ---------------------------------------------------------------------------

record(
  'D0',
  'the bench verifier passes its own acceptance (RFC 9421 B.2.6, and three mutations rejected)',
  (() => {
    try {
      return selfTest();
    } catch (err) {
      record._why = err.message;
      return false;
    }
  })(),
  `verify.mjs shares no code with src/net/; ${results.length === 0 ? '' : ''}RFC vector B.2.6 rebuilt byte-exact`,
);

// ---------------------------------------------------------------------------
// 1. Our leaf against the RFC's own vectors.
// ---------------------------------------------------------------------------

{
  const b = RFC9421_B26;
  const components = [
    { name: 'date' },
    { name: '@method' },
    { name: '@path' },
    { name: '@authority' },
    { name: 'content-type' },
    { name: 'content-length' },
  ];
  const paramsValue = core.signatureParamsValue(components, [
    ['created', 1618884473],
    ['keyid', 'test-key-ed25519'],
  ]);
  const req = {
    method: 'POST',
    url: 'http://example.com/foo?param=Value&Pet=dog',
    headers: b.request.headers,
  };
  const base = core.signatureBase(req, components, paramsValue);
  const sig = edSign(null, Buffer.from(base, 'ascii'), RFC_PRIVATE).toString('base64');
  record(
    'D1',
    'our leaf reproduces RFC 9421 B.2.6 — the base byte-exact and the signature bytes exact',
    base === b.base && sig === b.signature,
    base === b.base ? `signature ${sig.slice(0, 24)}…` : 'BASE DIFFERS — see the diff above',
  );
}

// ---------------------------------------------------------------------------
// 2. Our leaf against the ARCHITECTURE DRAFT's Ed25519 vectors, both forms.
// ---------------------------------------------------------------------------

/**
 * draft-meunier-web-bot-auth-architecture-05, Appendix A.2.2 and A.2.3.
 *
 * A third-party vector for each of the two candidate `Signature-Agent` forms,
 * produced by the draft's authors over RFC 9421's own key. These are what make
 * "both forms are implemented" a measurement rather than a claim.
 */
const DRAFT_VECTORS = [
  {
    id: 'D2',
    what: 'A.2.2 — the sf-dictionary form the draft prefers',
    components: [{ name: '@authority' }, { name: 'signature-agent', key: 'agent2' }],
    header: 'agent2="https://signature-agent.test"',
    params: [
      ['created', 1735689600],
      ['keyid', 'poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U'],
      ['alg', 'ed25519'],
      ['expires', 4889289600],
      ['nonce', 'XeP72svPKNiGEg3aDE7WJuTpN69H08oMFqC8NLFy1MptpENAT3WZTYwK+MYdsFMlaqHCJGo9ZAhqer1NWY9Epg=='],
      ['tag', 'web-bot-auth'],
    ],
    base:
      '"@authority": example.com\n' +
      '"signature-agent";key="agent2": "https://signature-agent.test"\n' +
      '"@signature-params": ("@authority" "signature-agent";key="agent2")' +
      ';created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519"' +
      ';expires=4889289600' +
      ';nonce="XeP72svPKNiGEg3aDE7WJuTpN69H08oMFqC8NLFy1MptpENAT3WZTYwK+MYdsFMlaqHCJGo9ZAhqer1NWY9Epg=="' +
      ';tag="web-bot-auth"',
    signature: 'DGiW2ErlQh0hc8wY2FQdbnFd6CEmonyY8nlvECIJFaUSYYNvNvSsGyP99BUGtq51gA4ouXlkUwjnta084bpjCg==',
  },
  {
    id: 'D3',
    what: 'A.2.3 — the legacy sf-string form, which is what the library speaks',
    components: [{ name: '@authority' }, { name: 'signature-agent' }],
    header: '"https://signature-agent.test"',
    params: [
      ['created', 1735689600],
      ['keyid', 'poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U'],
      ['alg', 'ed25519'],
      ['expires', 1735693200],
      ['nonce', 'e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg=='],
      ['tag', 'web-bot-auth'],
    ],
    base:
      '"@authority": example.com\n' +
      '"signature-agent": "https://signature-agent.test"\n' +
      '"@signature-params": ("@authority" "signature-agent")' +
      ';created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519"' +
      ';expires=1735693200' +
      ';nonce="e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg=="' +
      ';tag="web-bot-auth"',
    signature: 'jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQdi5N5YYKrD+mCT1HA1nZDsi6nJKuHxUi/5Syp3rLWBA==',
  },
];

for (const v of DRAFT_VECTORS) {
  const paramsValue = core.signatureParamsValue(v.components, v.params);
  const req = {
    method: 'POST',
    url: 'http://example.com/foo?param=Value&Pet=dog',
    headers: { 'signature-agent': v.header },
  };
  const base = core.signatureBase(req, v.components, paramsValue);
  const sig = edSign(null, Buffer.from(base, 'ascii'), RFC_PRIVATE).toString('base64');
  record(
    v.id,
    `our leaf reproduces the base of the architecture draft's ${v.what}`,
    base === v.base,
    base === v.base
      ? `byte-exact; signature ${sig === v.signature ? 'bytes exact' : 'DIFFERS FROM THE DRAFT\'S — see the next row'}`
      : `BASE DIFFERS\n        got:  ${JSON.stringify(base)}\n        want: ${JSON.stringify(v.base)}`,
  );
}

{
  // A.2.2 IS INTERNALLY INCONSISTENT AT DRAFT-05, AND THIS ROW IS WHERE THAT IS
  // RECORDED RATHER THAN WORKED AROUND.
  //
  // The draft prints its base with the dictionary member serialized as an
  // sf-string — `"signature-agent";key="agent2": "https://signature-agent.test"`
  // — and publishes a signature that does NOT verify against it. Re-signing the
  // printed base with the draft's own key (RFC 9421 B.1.4) produces different
  // bytes. The signature it DOES verify against is the same base with the
  // member value BARE:
  //
  //     "signature-agent";key="agent2": https://signature-agent.test
  //
  // So at this revision the draft's preferred form has no self-consistent
  // normative anchor: the printed base says one thing, the published signature
  // says another, and Cloudflare's own library implements a third (it covers
  // the WHOLE header value, `agent2="https://…"` — D10). Meanwhile A.2.1 and
  // A.2.3, the two vectors with no dictionary member in them, both verify
  // exactly and both match our leaf's bytes.
  //
  // That is the third independent reason the legacy sf-string form ships, and
  // the strongest: not "the library is behind the draft" but "there are three
  // readings of the draft-preferred form in the wild and no vector that settles
  // which is right". This row asserts the INCONSISTENCY, so it goes RED the day
  // the draft is corrected — which is exactly when somebody should re-run §4's
  // decision procedure.
  const printed = DRAFT_VECTORS[0];
  const bare = printed.base.replace(
    '"signature-agent";key="agent2": "https://signature-agent.test"',
    '"signature-agent";key="agent2": https://signature-agent.test',
  );
  const overPrinted = edSign(null, Buffer.from(printed.base, 'ascii'), RFC_PRIVATE).toString('base64');
  const overBare = edSign(null, Buffer.from(bare, 'ascii'), RFC_PRIVATE).toString('base64');
  record(
    'D2b',
    'RECORDED: draft-05 A.2.2\'s published signature does not verify against A.2.2\'s own printed base',
    overPrinted !== printed.signature && overBare === printed.signature,
    overBare === printed.signature
      ? 'it verifies against the same base with the member value UNQUOTED; A.2.1 and A.2.3 are both self-consistent'
      : 'THE DRAFT MAY HAVE BEEN CORRECTED — re-run §4\'s decision procedure before trusting this row\'s absence',
  );
}

// ---------------------------------------------------------------------------
// 3. Our leaf against the LIBRARY, byte for byte, on the same request.
// ---------------------------------------------------------------------------

const signer = await Ed25519Signer.fromJWK(RFC_KEY);
const libKeyid = await jwkToKeyID(
  { kty: 'OKP', crv: 'Ed25519', x: RFC_KEY.x },
  helpers.WEBCRYPTO_SHA256,
  helpers.BASE64URL_DECODE,
);

record(
  'D4',
  'our RFC 7638/8037 thumbprint equals the library\'s keyid for the same key',
  core.jwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: RFC_KEY.x }) === libKeyid,
  `keyid ${libKeyid}`,
);

{
  // The library's own parameter order — created, keyid, alg, expires, nonce,
  // tag — handed to our leaf, because ORDER IS SIGNED BYTES and a comparison
  // between two different orders would prove nothing about canonicalization.
  const components = core.coveredComponents('sf-string');
  const params = [
    ['created', CREATED],
    ['keyid', libKeyid],
    ['alg', 'ed25519'],
    ['expires', CREATED + 300],
    ['nonce', NONCE_B64],
    ['tag', 'web-bot-auth'],
  ];
  const agentValue = core.signatureAgentValue(DIRECTORY_URL, 'sf-string');
  const paramsValue = core.signatureParamsValue(components, params);
  const ours = core.signatureBase(
    { method: 'GET', url: TARGET, headers: { 'signature-agent': agentValue } },
    components,
    paramsValue,
  );
  const oursSig = edSign(null, Buffer.from(ours, 'ascii'), RFC_PRIVATE).toString('base64');

  const theirs = await signatureHeaders(
    { method: 'GET', url: TARGET, headers: { 'Signature-Agent': agentValue } },
    signer,
    {
      created: new Date(CREATED * 1000),
      expires: new Date((CREATED + 300) * 1000),
      nonce: NONCE_B64,
      components: ['@authority', '@method', '@path', 'signature-agent'],
    },
  );
  const theirInput = theirs['Signature-Input'].replace(/^sig1=/, '');
  const theirSig = /^sig1=:(.*):$/.exec(theirs.Signature)[1];

  record(
    'D5',
    'signature-params line byte-identical to the library\'s, for the four-component list',
    theirInput === paramsValue,
    theirInput === paramsValue ? paramsValue.slice(0, 90) + '…' : `ours:   ${paramsValue}\n        theirs: ${theirInput}`,
  );
  record(
    'D6',
    'signature BYTES identical to the library\'s — Ed25519 is deterministic, so the bases are identical',
    theirSig === oursSig,
    theirSig === oursSig ? `${oursSig.slice(0, 32)}…` : `ours:   ${oursSig}\n        theirs: ${theirSig}`,
  );
}

// ---------------------------------------------------------------------------
// 4. Interop, both directions, on the form and parameter set that SHIP.
// ---------------------------------------------------------------------------

const shippedForm = core.SHIPPED_SIGNATURE_AGENT_FORM;

{
  // Exactly what Aperture puts on the wire: §4's parameter enumeration in §4's
  // order, no `alg`, a base64url nonce, the shipped Signature-Agent form.
  const now = Math.floor(Date.now() / 1000);
  const prepared = core.prepareSignature(
    { method: 'GET', url: TARGET, headers: {} },
    {
      created: now,
      nonce: NONCE_B64URL,
      keyid: libKeyid,
      directoryUrl: DIRECTORY_URL,
      form: shippedForm,
    },
  );
  const signature = edSign(null, Buffer.from(prepared.base, 'ascii'), RFC_PRIVATE);
  const wire = {
    'Signature-Agent': prepared.signatureAgent,
    'Signature-Input': prepared.signatureInput,
    Signature: core.signatureHeaderValue(signature),
  };

  let theirVerdict = 'accepted';
  try {
    const v = await verifierFromJWK({ kty: 'OKP', crv: 'Ed25519', x: RFC_KEY.x });
    await wbaVerify({ method: 'GET', url: TARGET, headers: wire }, v);
  } catch (err) {
    theirVerdict = `REJECTED: ${err.message}`;
  }
  record(
    'D7',
    `Cloudflare's verifier accepts Aperture's shipped wire form (${shippedForm}, four components, no alg, base64url nonce)`,
    theirVerdict === 'accepted',
    theirVerdict === 'accepted'
      ? `components ${prepared.signatureInput.slice(5, 60)}…`
      : theirVerdict,
  );

  // §4's ordered fallback trigger, stated as its own row so the record says
  // whether it fired rather than leaving a reader to infer it from D7.
  record(
    'D8',
    '§4 fallback to ("@authority" "signature-agent") NOT required — the four-component list is accepted',
    theirVerdict === 'accepted',
    theirVerdict === 'accepted' ? 'shipping the four-component list' : 'FALLBACK REQUIRED — shrink the component list and re-run',
  );
}

{
  // The other direction: the library signs, our bench verifier judges.
  const theirs = await signatureHeaders(
    { method: 'GET', url: TARGET, headers: { 'Signature-Agent': core.signatureAgentValue(DIRECTORY_URL, 'sf-string') } },
    signer,
    {
      created: new Date(),
      expires: new Date(Date.now() + 300_000),
      nonce: NONCE_B64,
      components: ['@authority', '@method', '@path', 'signature-agent'],
    },
  );
  const keys = directoryIndex({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: RFC_KEY.x }] });
  const verdict = verifyRequest(
    {
      method: 'GET',
      target: '/page?q=1',
      scheme: 'http',
      headers: {
        host: '127.0.0.1:8902',
        'signature-agent': core.signatureAgentValue(DIRECTORY_URL, 'sf-string'),
        'signature-input': theirs['Signature-Input'],
        signature: theirs.Signature,
      },
    },
    keys,
  );
  record(
    'D9',
    'our bench verifier accepts a signature CLOUDFLARE\'S library produced',
    verdict.ok,
    verdict.reason,
  );
}

// ---------------------------------------------------------------------------
// 5. Why the sf-dictionary form does NOT ship — measured, not asserted.
// ---------------------------------------------------------------------------

{
  // draft-05 §4.2.1 prefers `Signature-Agent: sig1="https://…"` covered as
  // `"signature-agent";key="sig1"`, and marks the sf-string spelling LEGACY.
  // The library at this version cannot speak it: `buildSignedData` hands the
  // WHOLE header value to the base builder for a component with parameters
  // instead of the named member, so it computes
  //     "signature-agent";key="sig1": sig1="https://…"
  // where the draft's own A.2.2 vector says
  //     "signature-agent";key="sig1": "https://…"
  // Two implementations, two different bases, no signature that verifies across
  // them. This row is the evidence for §4's "adopt the form it emits".
  const agentValue = core.signatureAgentValue(DIRECTORY_URL, 'sf-dict');
  const now = Math.floor(Date.now() / 1000);
  const prepared = core.prepareSignature(
    { method: 'GET', url: TARGET, headers: {} },
    { created: now, nonce: NONCE_B64URL, keyid: libKeyid, directoryUrl: DIRECTORY_URL, form: 'sf-dict' },
  );
  const signature = edSign(null, Buffer.from(prepared.base, 'ascii'), RFC_PRIVATE);
  let verdict = 'accepted';
  try {
    const v = await verifierFromJWK({ kty: 'OKP', crv: 'Ed25519', x: RFC_KEY.x });
    await wbaVerify(
      {
        method: 'GET',
        url: TARGET,
        headers: {
          'Signature-Agent': agentValue,
          'Signature-Input': prepared.signatureInput,
          Signature: core.signatureHeaderValue(signature),
        },
      },
      v,
    );
  } catch (err) {
    verdict = `rejected: ${err.message}`;
  }
  record(
    'D10',
    `the library CANNOT verify the draft-preferred sf-dictionary form — which is why ${shippedForm} ships`,
    verdict !== 'accepted',
    verdict === 'accepted'
      ? 'IT NOW CAN. Re-run §4\'s decision procedure: SHIPPED_SIGNATURE_AGENT_FORM should move to sf-dict.'
      : verdict,
  );
}

// ---------------------------------------------------------------------------
// 6. A divergence worth recording rather than fixing.
// ---------------------------------------------------------------------------

{
  // The draft (§4.2.2) says the nonce is "base64url encoded random byte array",
  // and Aperture emits base64url. The library's own `validateNonce` decodes
  // with `atob`, which is standard base64 and rejects `-` and `_`; roughly 93%
  // of 64 random bytes contain one. It bites only on the library's SIGNING
  // path — its verifier never inspects the nonce — so it is a note about their
  // signer rather than a compatibility problem for ours, and D7 is the row that
  // proves that.
  const { validateNonce } = await import('web-bot-auth');
  const urlish = Buffer.from([0xfb, 0xff, 0x3e, 0x3f]).toString('base64url') + 'A'.repeat(82);
  record(
    'D11',
    'RECORDED: the library\'s validateNonce is standard-base64 only, so it refuses the draft\'s own base64url nonce',
    !validateNonce(urlish),
    'their SIGNER refuses it; their VERIFIER never reads the nonce (D7 passes with a base64url one)',
  );
}

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} probe rows hold`);
console.log(
  '\nRECORD FOR security.md / RESULTS.md:\n' +
    `  web-bot-auth npm         ${LIB_VERSION}\n` +
    '  draft revision           draft-meunier-web-bot-auth-architecture-05 (2026-03-02)\n' +
    `  Signature-Agent form     ${shippedForm} (legacy sf-string; the library cannot verify sf-dict at ${LIB_VERSION})\n` +
    '  covered components       ("@authority" "@method" "@path" "signature-agent")\n' +
    '  parameters               created, expires, keyid, tag, nonce  (no alg)\n' +
    `  RESULT: ${failed.length ? `RED — ${failed.map((f) => f.id).join(', ')}` : 'GREEN'}`,
);
process.exit(failed.length ? 1 : 0);
