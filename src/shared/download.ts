/**
 * The filename a page proposed, made safe to hand to a save dialog.
 *
 * A PURE LEAF — no imports at all, so the suite executes the shipped function
 * rather than a copy of it, for the same reason `redact.ts` is one.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS — the download row of the egress class, 2026-08-05
 * ---------------------------------------------------------------------------
 *
 * The class is *"an affordance where a page-supplied string causes Aperture to
 * act outside the page"*, and it is the one class in this programme that can be
 * enumerated to exhaustion rather than probed (`test/egress.test.ts` is that
 * enumeration; `docs/design/security.md` carries the ruled table). Downloads
 * were the enumeration's open row: there was **no `will-download` handler
 * anywhere in `src/`**, so every string on that path was the page's and the
 * only thing between them and the disk was Electron's default behaviour.
 *
 * WHAT THE PAGE CHOOSES ON THAT PATH. Two strings, both page-supplied:
 * `a.download = '…'` on the element that was clicked, and the
 * `Content-Disposition` filename from a response the page chose to fetch.
 * Electron pre-fills the save dialog with whichever it gets. So the page picks
 * the name of a file that lands on the human's disk.
 *
 * THE RULING, and it is deliberately not "refuse". The human's save dialog is a
 * real gate and it is the same gate every browser uses; removing downloads
 * would delete a working browser feature to close a hole that is about the
 * STRING rather than about the transfer. What this function adds is that the
 * string is Aperture's by the time it reaches the dialog:
 *
 *   · **No path.** `..`, `/`, `\`, a drive letter and a leading `~` are the
 *     traversal and absolute-path spellings; a save dialog pre-filled with
 *     `..\..\Startup\x.lnk` puts the default one confirmation away from a
 *     directory the human did not choose.
 *   · **No invisible characters.** The same strip `text.ts` applies everywhere
 *     else, and here it is a spoofing defence rather than a redaction one:
 *     `U+202E` (right-to-left override) is how `invoice\u202Egnp.exe` draws as
 *     `invoiceexe.png` in a dialog the human is reading before they click Save.
 *   · **Bounded, and never empty.** A 4000-character name is not a name.
 *
 * WHAT IT DOES NOT DO, stated so nobody reads more into it. It does not rule on
 * the EXTENSION: an executable that is honestly named `setup.exe` still reaches
 * the dialog, because deciding which extensions a browser may download is a
 * product decision and the human's dialog is the gate that exists for it. And
 * it does not needle-scrub — the bytes go to the human's own disk, not into
 * agent context and not to a third party, so the disclosure argument that
 * covers `browser_capture`'s Notion caption does not apply here.
 */

/** Never longer than this. Long enough for any real name, short enough that a
 *  dialog renders it whole rather than eliding the part that matters. */
const MAX_DOWNLOAD_NAME = 120;

/** What a nameless or wholly-unusable proposal becomes. */
const FALLBACK_DOWNLOAD_NAME = 'download';

export function safeDownloadName(proposed: string): string {
  // 1. The invisible code points, deleted rather than escaped — a dialog draws
  //    what is left, so anything that reorders or hides characters has to go
  //    before the human reads the string.
  const stripped = [...(proposed ?? '')]
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return !(
        c <= 0x1f ||
        c === 0x7f ||
        c === 0x85 ||
        (c >= 0x80 && c <= 0x9f) ||
        c === 0x2028 ||
        c === 0x2029 ||
        (c >= 0x202a && c <= 0x202e) ||
        (c >= 0x2066 && c <= 0x2069)
      );
    })
    .join('');

  // 2. The path, dropped rather than escaped. Everything up to the last
  //    separator of either flavour goes, which collapses `../../x`, `C:\y` and
  //    `\\server\share\z` to their final component in one step.
  const base = stripped.split(/[/\\]/).pop() ?? '';

  // 3. Characters Win32 refuses in a filename, plus the leading `~` and `-`
  //    that a shell or a dialog can read as something other than a name.
  const cleaned = base
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^[.~\-\s]+/, '')
    .replace(/[.\s]+$/, '')
    .trim();

  if (!cleaned) return FALLBACK_DOWNLOAD_NAME;
  if (cleaned.length <= MAX_DOWNLOAD_NAME) return cleaned;

  // 4. Truncated from the FRONT, keeping the extension, because the extension
  //    is the part a human uses to decide and a name cut at 120 characters
  //    would otherwise arrive with the extension removed — which is the same
  //    deception the RTL override buys, produced by us.
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX_DOWNLOAD_NAME - ext.length) + ext;
}
