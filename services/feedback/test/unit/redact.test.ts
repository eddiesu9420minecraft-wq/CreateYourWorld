import { describe, expect, it } from "vitest";
import { isIPv6, redact, totalRedactions } from "../../src/redact";

const r = (s: string) => redact(s);

describe("redact: private_key", () => {
  it("PEM RSA / OPENSSH / PGP blocks", () => {
    const pem = "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----\nafter";
    expect(r(pem).text).toBe("before\n[REDACTED:private_key]\nafter");
    const ssh = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
    expect(r(ssh).text).toBe("[REDACTED:private_key]");
    const pgp = "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----";
    expect(r(pgp).counts.private_key).toBe(1);
  });
  it("unterminated PEM block runs to the end", () => {
    expect(r("x -----BEGIN PRIVATE KEY-----\nMIIE...").text).toBe("x [REDACTED:private_key]");
  });
  it("minisign secret key", () => {
    const ms = "untrusted comment: minisign encrypted secret key\nRWRTY0IyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    expect(r(ms).text).toBe("[REDACTED:private_key]");
    expect(r("key RWRTY0Iy" + "Q".repeat(60)).text).toBe("key [REDACTED:private_key]");
  });
  it("does not touch public keys", () => {
    expect(r("-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----").counts.private_key).toBe(0);
  });
});

describe("redact: token", () => {
  const cases: [string, string][] = [
    ["ghp_" + "a".repeat(36), "[REDACTED:token]"],
    ["gho_" + "B".repeat(36), "[REDACTED:token]"],
    ["ghs_" + "1".repeat(36), "[REDACTED:token]"],
    ["github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz", "[REDACTED:token]"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "[REDACTED:token]"],
    ["AKIAIOSFODNN7EXAMPLE", "[REDACTED:token]"],
    ["xoxb-1234567890-abcdefghij", "[REDACTED:token]"],
    ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123", "[REDACTED:token]"],
    ["sk-proj0123456789abcdefghijkl", "[REDACTED:token]"],
    ["AIzaSyA-1234567890abcdefghijklmnopqrstu", "[REDACTED:token]"],
    ["Authorization: Bearer abcdefghijklmnop1234", "Authorization: Bearer [REDACTED:token]"],
    ["password=hunter2", "password=[REDACTED:token]"],
    ["GITHUB_TOKEN=abc123", "GITHUB_TOKEN=[REDACTED:token]"],
    ["api_key = 'xyz'", "api_key = '[REDACTED:token]'"],
    ['"client_secret"="s3cr3t"', '"client_secret"="[REDACTED:token]"'],
    ["https://x.test/?access_key=QQQ&b=1", "https://x.test/?access_key=[REDACTED:token]&b=1"],
    ["pwd=abc passwd=def secret=ghi", "pwd=[REDACTED:token] passwd=[REDACTED:token] secret=[REDACTED:token]"],
  ];
  for (const [input, out] of cases) {
    it(input.slice(0, 30), () => {
      const res = r(input);
      expect(res.text).toBe(out);
      expect(res.counts.token).toBeGreaterThan(0);
    });
  }
  it("negatives: prose about tokens and keys", () => {
    for (const s of [
      "The token expired after an hour.",
      "Press the key to continue",
      "monkey=banana is not a key",
      "sk-learn is a library",
      "Bearer tokens are common",
      "task-1234 is done",
    ]) {
      expect(r(s).counts.token, s).toBe(0);
    }
  });
});

describe("redact: url_credentials, email", () => {
  it("scheme://user:pass@", () => {
    const res = r("clone https://bob:s3cret@git.example.com/repo.git");
    expect(res.text).toBe("clone https://[REDACTED:url_credentials]@git.example.com/repo.git");
    expect(res.counts.url_credentials).toBe(1);
    expect(res.counts.email).toBe(0);
  });
  it("email", () => {
    const res = r("contact me at eddie.su+cyw@example.co.uk please");
    expect(res.text).toBe("contact me at [REDACTED:email] please");
    expect(res.counts.email).toBe(1);
  });
  it("email next to Chinese text", () => {
    expect(r("請寄到test@example.com謝謝").text).toBe("請寄到[REDACTED:email]謝謝");
  });
});

describe("redact: ip", () => {
  it("IPv4", () => {
    expect(r("server 192.168.1.20:8080 down").text).toBe("server [REDACTED:ip]:8080 down");
    expect(r("ping 8.8.8.8.").text).toBe("ping [REDACTED:ip].");
  });
  it("IPv6 full, compressed, loopback, mapped", () => {
    expect(r("addr 2001:0db8:85a3:0000:0000:8a2e:0370:7334 ok").text).toBe("addr [REDACTED:ip] ok");
    expect(r("addr 2001:db8::8a2e:370:7334 ok").text).toBe("addr [REDACTED:ip] ok");
    expect(r("addr fe80::1 ok").text).toBe("addr [REDACTED:ip] ok");
    expect(r("[::1]:8080").text).toBe("[[REDACTED:ip]]:8080");
    expect(r("::ffff:192.0.2.128").text).toBe("[REDACTED:ip]");
  });
  it("negatives: versions, Windows builds, times", () => {
    for (const s of [
      "cyw 0.1.3-alpha",
      "Windows 10.0.26200.1",
      "build 10.0.26200.1 x64",
      "v1.2.3.4",
      "version 1.2.3",
      "at 12:30:45 it froze",
      "2026-11-28T12:30:45Z",
      "999.1.1.1",
      "1.2.3.4.5",
      "cyw_core::feedback::redact",
      "Ratio 16:9 and 4:3",
    ]) {
      expect(r(s).counts.ip, s).toBe(0);
      expect(r(s).text, s).toBe(s);
    }
  });
  it("isIPv6 validator", () => {
    expect(isIPv6("12:30:45")).toBe(false);
    expect(isIPv6("00:1A:2B:3C:4D:5E")).toBe(false);
    expect(isIPv6("::1")).toBe(true);
    expect(isIPv6("1:2:3:4:5:6:7:8")).toBe(true);
    expect(isIPv6("1:2:3:4:5:6:7:8:9")).toBe(false);
    expect(isIPv6("1::2::3")).toBe(false);
  });
});

describe("redact: mac", () => {
  it("colon and dash forms", () => {
    expect(r("mac 00:1A:2B:3C:4D:5E end").text).toBe("mac [REDACTED:mac] end");
    expect(r("mac 00-1a-2b-3c-4d-5e").text).toBe("mac [REDACTED:mac]");
  });
  it("negatives", () => {
    expect(r("12:30:45").counts.mac).toBe(0);
    expect(r("00:1A:2B:3C:4D").counts.mac).toBe(0);
  });
});

describe("redact: path", () => {
  it("home folders become <home>", () => {
    expect(r(String.raw`C:\Users\Eddie\AppData\Local\cyw\log.txt`).text).toBe(String.raw`<home>\AppData\Local\cyw\log.txt`);
    expect(r(String.raw`"C:\\Users\\Eddie\\Desktop"`).text).toBe(String.raw`"<home>\\Desktop"`);
    expect(r("/Users/eddie/Library/Logs").text).toBe("<home>/Library/Logs");
    expect(r("open /home/eddie/.config/cyw").text).toBe("open <home>/.config/cyw");
    expect(r("/home/eddie").counts.path).toBe(1);
  });
  it("credential folders become [REDACTED:path]", () => {
    expect(r(String.raw`read C:\Users\Eddie\.ssh\id_ed25519 failed`).text).toBe("read [REDACTED:path] failed");
    expect(r("cat ~/.aws/credentials").text).toBe("cat [REDACTED:path]");
    expect(r("using .kube/config.").text).toBe("using [REDACTED:path].");
    expect(r("/home/x/.docker/config.json").text).toBe("[REDACTED:path]");
    expect(r("/home/x/.gnupg/secring.gpg").text).toBe("[REDACTED:path]");
    expect(r(String.raw`%APPDATA%\Microsoft\Credentials\ABC`).text).toBe("[REDACTED:path]");
    expect(r("/Users/x/Library/Keychains/login.keychain-db").text).toBe("[REDACTED:path]");
  });
  it("negatives", () => {
    for (const s of ["Credentials expired, please sign in", "the .sshd process", "https://example.com/home/page", "/usr/local/bin"]) {
      expect(r(s).counts.path, s).toBe(0);
    }
  });
});

describe("redact: prose and Chinese text are untouched", () => {
  it("normal prose", () => {
    const s = "When I click Save at 10:30 the window freezes for 5 seconds. Version 0.1.3-alpha, Windows 11 (26200).";
    const res = r(s);
    expect(res.text).toBe(s);
    expect(totalRedactions(res.counts)).toBe(0);
  });
  it("Chinese", () => {
    const s = "我在 10 點 30 分按下儲存，程式就當機了。版本 0.1.3-alpha，作業系統 Windows 11。請幫忙修復，謝謝！";
    expect(r(s).text).toBe(s);
  });
  it("is idempotent", () => {
    const s = String.raw`token=abc C:\Users\Eddie\.ssh\id_rsa a@b.co 10.0.0.1 fe80::1 00:11:22:33:44:55 https://u:p@h.test`;
    const once = r(s).text;
    expect(r(once).text).toBe(once);
    expect(totalRedactions(r(once).counts)).toBe(0);
  });
  it("is fast on a 1 MiB log without separators", () => {
    const big = "a.".repeat(512 * 1024);
    const t = Date.now();
    r(big);
    expect(Date.now() - t).toBeLessThan(5000);
  });
});
