/** Helpers for reading PR descriptions. All pure, so they are easy to test. */

/** Removes `<!-- ... -->` blocks, which PR templates use for instructions and examples. */
export function stripComments(body: string): string {
  return body.replace(/<!--[\s\S]*?(-->|$)/g, "");
}

/** Removes fenced (``` and ~~~) and inline code so that examples inside code are ignored. */
export function stripCode(body: string): string {
  return body
    .replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(^[ \t]{0,3}\1[ \t\r]*$|(?![\s\S]))/gm, "")
    .replace(/`[^`\n]*`/g, "");
}

export interface IssueRef {
  number: number;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Finds references to issues in the same repository: `#12`, `owner/repo#12` and
 * `https://<host>/owner/repo/issues/12`. References to other repositories are ignored.
 * `host` is the GitHub server's host name, so GitHub Enterprise Server works too.
 */
export function findIssueRefs(body: string, owner: string, repo: string, host = "github.com"): IssueRef[] {
  const text = stripCode(stripComments(body));
  const self = `${owner}/${repo}`.toLowerCase();
  const found = new Set<number>();
  const add = (n: string) => {
    const number = Number(n);
    if (Number.isSafeInteger(number) && number > 0) found.add(number);
  };

  const hostPattern = `(?:www\\.)?${escapeRegex(host.replace(/^www\./i, ""))}`;
  const url = new RegExp(`https?://${hostPattern}/([\\w.-]+)/([\\w.-]+)/issues/(\\d+)`, "gi");
  for (const m of text.matchAll(url)) {
    if (`${m[1]}/${m[2]}`.toLowerCase() === self) add(m[3]!);
  }
  const withoutUrls = text.replace(url, "");

  const short = /(?<![\w/#&])(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b/g;
  for (const m of withoutUrls.matchAll(short)) {
    if (m[1] && `${m[1]}/${m[2]}`.toLowerCase() !== self) continue;
    add(m[3]!);
  }
  return [...found].map((number) => ({ number }));
}

export interface Checklist {
  checked: string[];
  unchecked: string[];
}

/** Matches a task-list item, optionally inside a blockquote: `- [ ] x`, `> * [x] y`, `1. [X] z`. */
const TASK = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[([ xX])\](?=\s|$)\s*(.*)$/;
const LIST_ITEM = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s/;

/** Reads GitHub task-list items (`- [ ]`, `* [x]`, `1. [X]`). */
export function readChecklist(body: string): Checklist {
  const result: Checklist = { checked: [], unchecked: [] };
  for (const line of stripCode(stripComments(body)).split(/\r?\n/)) {
    const m = TASK.exec(line);
    if (!m) continue;
    (m[1] === " " ? result.unchecked : result.checked).push(m[2]!.trim());
  }
  return result;
}

const isAtxHeading = (line: string) => /^\s{0,3}#{1,6}(\s|$)/.test(line);
/** A setext underline (`===`/`---`) or a thematic break (`***`, `- - -`, `___`). */
const isRule = (line: string) => /^\s{0,3}(?:=+|(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})\s*$/.test(line);

/** True when line `i` starts a new section: an ATX heading, or a setext heading (text then underline). */
function startsSection(lines: string[], i: number): boolean {
  const line = lines[i]!;
  if (isAtxHeading(line)) return true;
  const next = lines[i + 1];
  return line.trim() !== "" && !isRule(line) && next !== undefined && /^\s{0,3}(?:=+|-+)\s*$/.test(next);
}

/** Strips heading markers and emphasis from the start of a line, for matching labels. */
function labelText(line: string): string {
  return line.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^\s*(?:\*\*|__|\*|_)/, "");
}

interface Section {
  start: number;
  end: number;
  /** The heading line was a markdown heading (ATX or setext), not just a label like `AI usage:`. */
  isHeading: boolean;
  /** Text after `heading:` on the same line, if any. */
  inline: string;
}

/**
 * Locates the section introduced by `heading`. It matches a markdown heading, or a plain
 * (non-list) line, whose text *starts* with `heading` followed by a word boundary. The
 * section runs to the next heading. Returns line indices into `lines`, end exclusive.
 */
function findSection(lines: string[], heading: string): Section | null {
  const needle = heading.trim().toLowerCase();
  if (!needle) return null;
  const startsWith = new RegExp(`^${escapeRegex(needle)}(?![\\w])`, "i");
  for (let start = 0; start < lines.length; start++) {
    const line = lines[start]!;
    if (LIST_ITEM.test(line)) continue;
    const text = labelText(line);
    if (!startsWith.test(text.trim())) continue;

    const rest = text.trim().slice(needle.length);
    const colon = /^[\s*_]*:(.*)$/.exec(rest);
    const inline = colon ? colon[1]!.replace(/^[\s*_]+|[\s*_]+$/g, "") : "";
    const isHeading = startsSection(lines, start);
    let end = start + 1;
    if (isHeading && !isAtxHeading(line)) end++; // skip the setext underline
    while (end < lines.length && !startsSection(lines, end)) end++;
    return { start, end, isHeading, inline };
  }
  return null;
}

/**
 * Returns the body without the section introduced by `heading`. With `headingsOnly`, only
 * a real markdown heading is removed, never a plain `heading:` line.
 */
export function withoutSection(body: string, heading: string, headingsOnly = false): string {
  const lines = stripCode(stripComments(body)).split(/\r?\n/);
  const section = findSection(lines, heading);
  if (!section || (headingsOnly && !section.isHeading)) return lines.join("\n");
  return [...lines.slice(0, section.start), ...lines.slice(section.end)].join("\n");
}

/**
 * Checks whether the section introduced by `heading` has an answer: either text after
 * `heading:` on the same line (e.g. `AI usage: none`), or, in the lines below up to the next
 * heading, a ticked box or other text. Unticked boxes, rules and template comments do not count.
 */
export function hasDisclosure(body: string, heading: string): { found: boolean; answered: boolean } {
  const lines = stripCode(stripComments(body)).split(/\r?\n/);
  const section = findSection(lines, heading);
  if (!section) return { found: false, answered: false };
  if (section.inline) return { found: true, answered: true };

  for (const line of lines.slice(section.start + 1, section.end)) {
    if (isRule(line)) continue;
    const box = TASK.exec(line);
    if (box) {
      if (box[1] !== " ") return { found: true, answered: true };
      continue;
    }
    if (line.trim()) return { found: true, answered: true };
  }
  return { found: true, answered: false };
}
