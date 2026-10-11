/** Canonical policy; the standalone DSH copy is byte-checked by the SDK tests. */
const tokenPattern = /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----|-----BEGIN [P]GP PRIVATE KEY BLOCK-----|\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{22,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{15,}/;
const fields = /["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|password|authorization)["']?\s*[:=]\s*["']([^"']{24,})["']/gi;
export function hasSecretCandidate(text) {
  let value = text;
  for (let pass = 0; pass < 16; pass++) {
    if (tokenPattern.test(value)) return true;
    for (const match of value.matchAll(fields)) {
      if (!/^<[A-Z0-9_:-]+>$/.test(match[1])) return true;
    }
    const decoded = value.replace(/\\(?:u([0-9a-f]{4})|(["'\\/]))/gi, (_, hex, character) => hex ? String.fromCharCode(parseInt(hex, 16)) : character);
    if (decoded === value) return false;
    value = decoded;
  }
  // Excessively nested encodings are rejected instead of bypassing the finite decoder.
  return true;
}
export function isPrivatePath(file) {
  const name = file.replaceAll('\\', '/');
  return /(?:^|\/)(?:node_modules|\.work|\.git|artifacts|\.codex|\.dsh|\.private|\.local|\.state|\.cache)(?:\/|$)|\.(?:dpapi(?:\.[^/]+)?|log|tmp|pem|key|p12|pfx|jks|keystore|kdbx)$|(?:^|\/)\.env[^/]*$|(?:^|\/)(?:credentials?|auth|tokens?|secrets?)[^/]*\.json$/i.test(name);
}
