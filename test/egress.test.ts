import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { safeDownloadName } from '../src/shared/download.js';

/**
 * THE EGRESS CLASS, ENUMERATED TO EXHAUSTION.
 *
 * The class: **an affordance where a page-supplied string causes Aperture to
 * act outside the page.** Its first member is the eleventh sink — a page called
 * `window.open('mailto:…' + MARKER)`, `normalizeUrl` answered a disallowed
 * scheme with a DuckDuckGo search over the whole string, and Aperture put
 * page-chosen bytes on the network to a host the page never named
 * (`docs/design/security.md`, "a page could make Aperture put its own bytes on
 * the network").
 *
 * It is a DIFFERENT PROPERTY from everything else in this programme, and the
 * distinction is load-bearing. Every other finding moves a value from one place
 * inside the browser to another place inside the browser, and the repair is a
 * scrub. No scrub applies to this one; the only repair is not to do it. It also
 * hits precisely the adversary the needle mechanism exists for — injected script
 * on an otherwise-honest origin, whose own CSP (`connect-src 'self'`) can forbid
 * its `fetch()` and forbade nothing here. Aperture was a CSP bypass.
 *
 * WHY THIS FILE EXISTS RATHER THAN ANOTHER PROBE. This is the one class in the
 * programme that can be **enumerated to exhaustion**. The set of ways a browser
 * reaches outside a page is small, fixed, and named by the platform: open a
 * window, navigate, download, hand a URL to the OS, put a request on the
 * network, write a file, raise a native dialog, register a protocol, start a
 * process, accept a connection. So the audit does not have to be remembered —
 * it can be a test, and the test can be TOTAL IN BOTH DIRECTIONS:
 *
 *   · a NEW affordance (a file reaching for one of these primitives) fails with
 *     the file and the primitive named, and cannot ship without a ruling;
 *   · a ruling whose affordance has DISAPPEARED also fails, so a guard that was
 *     deleted cannot leave a row behind claiming it is still there. That half is
 *     what stops this file becoming the stale audit `security.md`'s preload
 *     `reason:` count turned out to be — four sites, still four, different four.
 *
 * The rulings are the table in `docs/design/security.md` and the two must agree.
 * `docs.test.ts` sets the precedent for asserting over text when the property
 * lives in the text; this goes one better and asserts over the CODE.
 *
 * WHAT IT CANNOT DO, stated because every guard in this repo now states it: it
 * cannot falsify a ruling. A row that says "no — the argument is Aperture's own"
 * is checked by a human reading it, exactly as `completeness.test.ts` cannot
 * falsify a `not-page-text` claim. What it can do is guarantee that no
 * affordance exists without one, which is the failure that actually happened.
 */

const ROOT = join(__dirname, '..');

function filesUnder(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, ext));
    else if (p.endsWith(ext) && statSync(p).isFile()) out.push(p);
  }
  return out;
}

/** Prose removed, so this measures call sites and not the comments about them. */
function code(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const SOURCES = filesUnder(join(ROOT, 'src'), '.ts').map((path) => ({
  rel: path.slice(ROOT.length + 1).replace(/\\/g, '/'),
  code: code(readFileSync(path, 'utf8')),
}));

/**
 * Every way this codebase can act outside a page.
 *
 * Deliberately at the level of the PLATFORM PRIMITIVE rather than of the
 * feature, because a feature is a thing somebody remembers to list and a
 * primitive is a thing the compiler can find. `dialog.show…` is spelled out
 * rather than matched loosely on purpose: `<dialog>.showModal()` in the renderer
 * is a DOM call with no egress in it at all, and a regex that swept it up would
 * teach a reader to ignore this table's rows.
 */
const PRIMITIVES: [string, RegExp][] = [
  ['window.open handler', /setWindowOpenHandler\(/],
  ['navigation', /\.loadURL\(/],
  ['renderer navigation', /'will-navigate'/],
  ['download', /'will-download'/],
  ['hand to the OS', /shell\.openExternal\(/],
  ['network request', /\bfetch\b/],
  ['inbound listener', /createServer\(/],
  ['write to disk', /\bwriteFile\(/],
  ['native file dialog', /dialog\.show(MessageBox|OpenDialog|SaveDialog|ErrorBox)/],
  ['custom protocol', /protocol\.register/],
  ['child process', /child_process|\bspawn\(|\bexecFile\(/],
];

/**
 * The ruled table. `page-supplied?` is the question the class is about: can a
 * PAGE choose the bytes this primitive acts on?
 *
 * Kept in step with `docs/design/security.md`'s egress table by hand, and that
 * is a real seam — but the seam is between two documents that both have to be
 * edited, rather than between a document and a fact nobody is checking.
 */
const RULED: Record<string, string> = {
  // --- page-supplied: YES. These are the class. ----------------------------
  'src/main/tabs.ts :: window.open handler':
    'YES, and it is the eleventh sink. Chromium hands the page\'s target over ' +
    'resolved and absolute; the scheme is checked HERE rather than left to ' +
    'normalizeUrl, whose search fallback would have put the string on the ' +
    'network. Guarded by G19l.',
  'src/main/tabs.ts :: navigation':
    'YES — a page can navigate itself, and the agent can be steered into a ' +
    'navigate call. isAllowedScheme is enforced again at this funnel rather ' +
    'than trusted from the caller, because this is the last place a bad scheme ' +
    'can be stopped. Guarded by test/security.test.ts and G20.',
  'src/privacy/containers.ts :: download':
    'YES — `a.download` and Content-Disposition are the page\'s strings. The ' +
    'transfer is gated by the human\'s save dialog, as in every browser; what ' +
    'this handler closes is the NAME, via safeDownloadName (no path, no ' +
    'invisible characters, bounded). Was the enumeration\'s one unruled row ' +
    'until 2026-08-05: there was no will-download handler anywhere in src/.',
  'src/main/index.ts :: renderer navigation':
    'YES for a tab, and this listener is the app-wide one. It denies only ' +
    'file://, which is E1 — a known-open item, unchanged, and theoretical ' +
    'because the shell renderer has no link, no window.open and no innerHTML ' +
    'sink to reach it with. Chromium resolves the target and there is no ' +
    'normalizeUrl search fallback on this path.',
  'src/main/index.ts :: hand to the OS':
    'YES IF REACHED, and it is E2 — the chrome renderer\'s window-open handler ' +
    'passes any URL to shell.openExternal with no scheme check, which on ' +
    'Windows is a ShellExecute-class primitive. Known-open, unchanged, and ' +
    'gated behind E1: it needs script in the chrome renderer first. E1+E2 are ' +
    'one chain and the only path in this codebase that ends in code execution.',

  // --- page-supplied: NO. Ruled, so the table is total. --------------------
  'src/main/index.ts :: window.open handler':
    'NO — the chrome renderer is local content and opens nothing on a page\'s ' +
    'behalf. The URL it receives is E2\'s argument, ruled above.',
  'src/main/index.ts :: navigation':
    'NO — loads the bundled renderer HTML, a path Aperture built.',
  'src/main/index.ts :: write to disk':
    'NO — writes mcp.json to userData from Aperture\'s own config object.',
  'src/main/vaultWindow.ts :: window.open handler':
    'NO — unconditional deny. The vault window opens nothing.',
  'src/main/vaultWindow.ts :: renderer navigation':
    'NO — unconditional preventDefault, which is what the shell window (E1) ' +
    'does not do and should.',
  'src/main/vaultWindow.ts :: navigation':
    'NO — the bundled vault HTML.',
  'src/main/vaultWindow.ts :: hand to the OS':
    'NO — allowlisted to Notion HTTPS URLs, with the comment saying why. This ' +
    'is the treatment index.ts (E2) did not get.',
  'src/main/vaultWindow.ts :: network request':
    'NO — api.notion.com, a fixed host, with the human\'s own token.',
  'src/main/vaultWindow.ts :: native file dialog':
    'NO — a human picking a file to attach; the agent cannot raise it and ' +
    'browser_attach takes library ids, never paths.',
  'src/main/consent.ts :: native file dialog':
    'NO — the fill consent dialog. Native by design: there is no parameter an ' +
    'agent can set that asserts prior consent, and no page can render it.',
  'src/capture/notion.ts :: network request':
    'NO — api.notion.com. The CAPTION and SOURCE URL it carries are ' +
    'page-written and are scrubbed at both routeCapture call sites; the ' +
    'DESTINATION is the active tab only, which is F-G. test/urlsurfaces.test.ts ' +
    'asserts all three.',
  'src/capture/capture.ts :: write to disk':
    'NO — a PNG under userData, named from a timestamp Aperture generated.',
  'src/privacy/blocker.ts :: network request':
    'NO — the prebuilt filter lists, fetched by @ghostery/adblocker from its ' +
    'own fixed endpoints.',
  'src/privacy/blocker.ts :: write to disk':
    'NO — the filter-list cache, under userData.',
  'src/telemetry/reporter.ts :: write to disk':
    'NO — the telemetry config, under userData.',
  'src/telemetry/uh-oh-client.ts :: network request':
    'NO — a vendored analytics client reached through a locally-typed view of ' +
    'globals; it mints and sends no identifier, and no page string reaches it.',
  'src/vault/vault.ts :: write to disk':
    'NO — the encrypted vault file, under userData.',
  'src/vault/profileStore.ts :: write to disk':
    'NO — the encrypted profile store, under userData.',
  'src/vault/attachments.ts :: write to disk':
    'NO — the attachment index, under userData.',
  'src/mcp/server.ts :: inbound listener':
    'NO, and it is inbound rather than egress — bound to 127.0.0.1 only, ' +
    'behind a per-launch bearer, with Host and Origin validated BEFORE auth so ' +
    'the DNS-rebinding defence is not gated on a token a page does not have.',
};

describe('the egress class, enumerated', () => {
  const observed = new Set<string>();
  for (const f of SOURCES) {
    for (const [name, re] of PRIMITIVES) {
      if (re.test(f.code)) observed.add(`${f.rel} :: ${name}`);
    }
  }

  it('every affordance that can act outside a page carries a ruling', () => {
    const unruled = [...observed].filter((k) => !(k in RULED)).sort();
    expect(
      unruled,
      'A NEW AFFORDANCE. Something in src/ can now act outside a page and ' +
        'nothing says whether a page chooses the bytes. Rule it here and in ' +
        'docs/design/security.md\'s egress table. This is the class the third ' +
        'gate said could be closed by enumeration rather than by probing — ' +
        'which only works if the enumeration is enforced.',
    ).toEqual([]);
  });

  it('every ruling still has an affordance under it', () => {
    const stale = Object.keys(RULED).filter((k) => !observed.has(k)).sort();
    expect(
      stale,
      'A STALE RULING. This row claims to rule on something that is no longer ' +
        'in the code. Delete it — a table that keeps rows for affordances that ' +
        'left is how the preload `reason:` audit stayed plausible while its ' +
        'membership changed underneath the count.',
    ).toEqual([]);
  });

  it('the download row is a handler and not a hope', () => {
    // The row that was open. Asserted on its own because "there is no handler
    // at all" is what the third gate found, and the whole-table check above
    // would pass just as happily if this row were ruled and absent.
    const containers = SOURCES.find((f) => f.rel === 'src/privacy/containers.ts')!;
    expect(containers.code).toMatch(/'will-download'/);
    expect(
      containers.code,
      'the save dialog must be pre-filled with a name Aperture built, not with ' +
        'the page\'s',
    ).toMatch(/safeDownloadName\(/);
  });
});

describe('safeDownloadName, executed', () => {
  // A pure leaf, so the suite runs the shipped function rather than a copy.
  it('drops the path, in both flavours and both directions', () => {
    expect(safeDownloadName('../../Startup/evil.lnk')).toBe('evil.lnk');
    expect(safeDownloadName('..\\..\\Startup\\evil.lnk')).toBe('evil.lnk');
    expect(safeDownloadName('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe('hosts');
    expect(safeDownloadName('\\\\server\\share\\payload.exe')).toBe('payload.exe');
    expect(safeDownloadName('/etc/passwd')).toBe('passwd');
  });

  it('removes the override that makes an extension read backwards', () => {
    // `invoice\u202Egnp.exe` DRAWS as `invoiceexe.png` in the dialog the human
    // is reading before they click Save. The strip is the same one text.ts
    // applies everywhere else; here it is a spoofing defence rather than a
    // redaction one.
    const spoof = 'invoice\u202Egnp.exe';
    expect(safeDownloadName(spoof)).toBe('invoicegnp.exe');
    expect(safeDownloadName(spoof)).not.toContain('\u202e');
    expect(safeDownloadName('re\u0000port.pdf')).toBe('report.pdf');
  });

  it('never returns an empty name, whatever it was handed', () => {
    for (const junk of ['', '   ', '..', '../..', '/', '\\', '...', '~', '\u202e']) {
      expect(safeDownloadName(junk), `for ${JSON.stringify(junk)}`).toBe('download');
    }
  });

  it('bounds the length and keeps the extension while doing it', () => {
    // Truncating from the END would remove the extension, which is the same
    // deception the RTL override buys — produced by us, this time.
    const long = 'a'.repeat(4000) + '.pdf';
    const out = safeDownloadName(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('.pdf')).toBe(true);
  });

  it('leaves an ordinary name exactly as it was', () => {
    // The non-vacuity half: a sanitiser that mangled every name would pass every
    // assertion above and break the feature.
    for (const ok of ['statement-2026-08.pdf', 'Invoice 41.xlsx', 'a.tar.gz']) {
      expect(safeDownloadName(ok)).toBe(ok);
    }
  });

  it('replaces the characters Win32 refuses, rather than dropping the name', () => {
    expect(safeDownloadName('re:port<1>.pdf')).toBe('re_port_1_.pdf');
  });
});
