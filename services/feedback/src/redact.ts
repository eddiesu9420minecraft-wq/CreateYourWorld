// Server-side redaction. Same rules as the Rust client (`cyw_core::feedback::redact`), see docs/feedback/API.md.
// The server has no "user" (local user name) rule: it cannot know the reporter's local account name.
// Pure string processing: no dynamic code, everything is treated as data.
// Every quantifier is bounded so that a 1 MiB log cannot cause catastrophic backtracking.

export type RedactionKind = "private_key" | "token" | "url_credentials" | "email" | "ip" | "mac" | "path";

export const REDACTION_KINDS: readonly RedactionKind[] = [
  "private_key",
  "token",
  "url_credentials",
  "email",
  "ip",
  "mac",
  "path",
];

export interface RedactionResult {
  text: string;
  counts: Record<RedactionKind, number>;
}

const tag = (kind: RedactionKind) => `[REDACTED:${kind}]`;

type RegexRule = {
  kind: RedactionKind;
  re: RegExp;
  /** Returns the replacement, or null to keep the match unchanged. */
  replace: (m: RegExpExecArray) => string | null;
};
type CustomRule = {
  kind: RedactionKind;
  apply: (text: string) => { text: string; count: number };
};
type Rule = RegexRule | CustomRule;

const HEX4 = /^[0-9A-Fa-f]{1,4}$/;
const IPV4_STRICT = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** Validates an IPv6 candidate so that times (12:30:45), MACs and `a::b` code paths are not redacted. */
export function isIPv6(candidate: string): boolean {
  if (!/\d/.test(candidate)) return false; // require at least one digit (skips `dead::beef`-like text)
  let s = candidate;
  const lastColon = s.lastIndexOf(":");
  const tailPart = s.slice(lastColon + 1);
  if (tailPart.includes(".")) {
    // embedded IPv4 (::ffff:192.0.2.1) counts as two groups
    if (!IPV4_STRICT.test(tailPart)) return false;
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return false;
  if (halves.length === 1) {
    const groups = s.split(":");
    return groups.length === 8 && groups.every((g) => HEX4.test(g));
  }
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves[1] === "" ? [] : halves[1].split(":");
  const all = head.concat(tail);
  return all.length >= 1 && all.length <= 7 && all.every((g) => HEX4.test(g));
}

// Characters that may be part of a path token.
const isPathChar = (c: string) => !/[\s"'<>|]/.test(c);

// A credentials folder: `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker/config.json` may start a token
// (`~/.ssh/id_rsa`, `.aws/credentials`); `Credentials` / `Keychains` must follow a path separator.
const SENSITIVE_DIR_RE =
  /(?:(?<=[\\/])(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker[\\/]config\.json|Credentials|Keychains)|(?<![^\s"'(=:])(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker[\\/]config\.json))(?=[\\/\s"'<>|),;]|$)/g;

function redactSensitivePaths(text: string): { text: string; count: number } {
  SENSITIVE_DIR_RE.lastIndex = 0;
  let out = "";
  let last = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = SENSITIVE_DIR_RE.exec(text)) !== null) {
    if (m.index < last) continue;
    let start = m.index;
    while (start > last && start - m.index > -1024 && isPathChar(text[start - 1])) start--;
    let end = m.index + m[0].length;
    while (end < text.length && end - m.index < 1024 && isPathChar(text[end])) end++;
    // don't swallow trailing sentence punctuation
    while (end > m.index + m[0].length && /[.,;:)]/.test(text[end - 1])) end--;
    out += text.slice(last, start) + tag("path");
    last = end;
    count++;
    SENSITIVE_DIR_RE.lastIndex = end;
  }
  if (count === 0) return { text, count };
  return { text: out + text.slice(last), count };
}

const RULES: Rule[] = [
  // ---- private_key -------------------------------------------------------------------------------
  {
    kind: "private_key",
    // PEM blocks (RSA/EC/OPENSSH/ENCRYPTED/PGP ... PRIVATE KEY [BLOCK]); an unterminated block runs to the end.
    re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$(?![\s\S]))/g,
    replace: () => tag("private_key"),
  },
  {
    kind: "private_key",
    // minisign secret key file: comment line + base64 key line
    re: /untrusted comment:[^\n]{0,200}secret key[^\n]{0,200}\r?\n[ \t]{0,10}[A-Za-z0-9+/]{20,1024}={0,2}/gi,
    replace: () => tag("private_key"),
  },
  {
    kind: "private_key",
    // bare minisign secret key ("EdScB2" header -> base64 "RWRTY0Iy...")
    re: /\bRWRTY0Iy[A-Za-z0-9+/]{40,1024}={0,2}/g,
    replace: () => tag("private_key"),
  },
  // ---- url_credentials ---------------------------------------------------------------------------
  {
    kind: "url_credentials",
    re: /\b([A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/)[^\s/@:[\]]{1,256}:[^\s/@[\]]{1,256}@/g,
    replace: (m) => `${m[1]}${tag("url_credentials")}@`,
  },
  // ---- token ---------------------------------------------------------------------------------------
  { kind: "token", re: /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g, replace: () => tag("token") },
  { kind: "token", re: /\bgithub_pat_[A-Za-z0-9_]{20,255}/g, replace: () => tag("token") },
  {
    kind: "token",
    re: /\beyJ[A-Za-z0-9_-]{5,8192}\.eyJ[A-Za-z0-9_-]{5,8192}\.[A-Za-z0-9_-]{0,8192}/g,
    replace: () => tag("token"),
  },
  { kind: "token", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => tag("token") },
  { kind: "token", re: /\bxox[abpr]-[A-Za-z0-9-]{10,255}/g, replace: () => tag("token") },
  { kind: "token", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,512}/g, replace: () => tag("token") },
  { kind: "token", re: /\bAIza[0-9A-Za-z_-]{35}/g, replace: () => tag("token") },
  {
    kind: "token",
    re: /\b(Bearer)[ \t]{1,10}([A-Za-z0-9._~+/-]{16,8192}={0,3})/gi,
    replace: (m) => `${m[1]} ${tag("token")}`,
  },
  {
    kind: "token",
    // key/token/secret/password/passwd/pwd/api_key/access_key/client_secret = value
    // (also prefixed names such as GITHUB_TOKEN=..., db.password = ..., "api_key"="...")
    re: /\b((?:[A-Za-z0-9]{1,40}[_.-]){0,6}(?:api_key|apikey|access_key|client_secret|secret|password|passwd|pwd|token|key))(["']?[ \t]{0,10}=[ \t]{0,10})(["']?)([^\s"'&,;<>]{1,1024})(["']?)/gi,
    replace: (m) => {
      const value = m[4];
      if (value.startsWith("[REDACTED") || value.startsWith("<home>")) return null;
      return `${m[1]}${m[2]}${m[3]}${tag("token")}${m[5]}`;
    },
  },
  // ---- email -------------------------------------------------------------------------------------
  {
    kind: "email",
    re: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g,
    replace: () => tag("email"),
  },
  // ---- path --------------------------------------------------------------------------------------
  { kind: "path", apply: redactSensitivePaths },
  {
    kind: "path",
    re: /\b[A-Za-z]:[\\/]{1,4}Users[\\/]{1,4}[^\\/\s"'<>|:*?]{1,256}/gi,
    replace: () => "<home>",
  },
  {
    kind: "path",
    re: /(?<![A-Za-z0-9_.~-])\/(?:Users|home)\/[^/\s"'<>|:]{1,256}/g,
    replace: () => "<home>",
  },
  // ---- ip ----------------------------------------------------------------------------------------
  {
    kind: "ip",
    // IPv6 candidates, validated by isIPv6 (so 12:30:45 and MAC addresses are left alone)
    re: /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:[0-9A-Fa-f]{1,4}|(?:\d{1,3}\.){3}\d{1,3})?(?![\w:]|\.\d)/g,
    replace: (m) => (isIPv6(m[0]) ? tag("ip") : null),
  },
  {
    kind: "ip",
    // IPv4, every octet <= 255; not part of a longer dotted/word run (0.1.3-alpha, 10.0.26200.1, v1.2.3.4)
    re: /(?<![\w.-])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w-]|\.\d)/g,
    replace: () => tag("ip"),
  },
  // ---- mac ---------------------------------------------------------------------------------------
  {
    kind: "mac",
    re: /(?<![\w:-])[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}(?![\w:-])/g,
    replace: () => tag("mac"),
  },
];

export function emptyCounts(): Record<RedactionKind, number> {
  return { private_key: 0, token: 0, url_credentials: 0, email: 0, ip: 0, mac: 0, path: 0 };
}

function applyRegexRule(rule: RegexRule, text: string): { text: string; count: number } {
  rule.re.lastIndex = 0;
  let out = "";
  let last = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = rule.re.exec(text)) !== null) {
    if (m[0].length === 0) {
      rule.re.lastIndex++;
      continue;
    }
    const replacement = rule.replace(m);
    if (replacement === null) continue;
    out += text.slice(last, m.index) + replacement;
    last = m.index + m[0].length;
    count++;
  }
  if (count === 0) return { text, count };
  return { text: out + text.slice(last), count };
}

/** Redacts secrets and personal data. Idempotent: redact(redact(x).text).text === redact(x).text. */
export function redact(input: string): RedactionResult {
  const counts = emptyCounts();
  let text = input;
  for (const rule of RULES) {
    const r = "apply" in rule ? rule.apply(text) : applyRegexRule(rule, text);
    text = r.text;
    counts[rule.kind] += r.count;
  }
  return { text, counts };
}

export function totalRedactions(counts: Record<RedactionKind, number>): number {
  let n = 0;
  for (const k of REDACTION_KINDS) n += counts[k];
  return n;
}
