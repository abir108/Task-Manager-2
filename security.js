/* Shared security helpers: password rules, rate limiting, invite tokens, response headers. */
const crypto = require("crypto");

/* ---------- Password rules ---------- */
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200; // bcrypt only reads the first 72 bytes; this just stops silly payloads
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password12", "password123", "passw0rd", "qwerty", "qwertyuiop", "qwerty123",
  "1234567890", "123456789", "12345678", "11111111", "0123456789", "abc123456", "abcd1234", "iloveyou1",
  "letmein123", "welcome123", "admin12345", "administrator", "changeme123", "cloudtech", "cloudtech123",
  "cloudtech1122", "cloudtech2026", "cloudtechacademy", "bookkeeping", "bookkeeping123"
]);

/* Returns an error message, or null when the password is acceptable. `context` may hold the
   person's name and email so their own details cannot be used as the password. */
function passwordProblem(password, context = {}) {
  if (typeof password !== "string") return "Password is required";
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return "Password is too long";
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return "Password must contain both letters and numbers";
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return "That password is too common. Choose something harder to guess";
  if (/^(.)\1+$/.test(password)) return "That password is too easy to guess";
  const email = String(context.email || "").toLowerCase();
  const name = String(context.name || "").toLowerCase().replace(/\s+/g, "");
  if (email && (lower === email || lower === email.split("@")[0])) return "Password cannot be your email address";
  if (name.length >= 4 && lower.replace(/[^a-z]/g, "") === name) return "Password cannot be your name";
  return null;
}

/* ---------- Invite / reset tokens ----------
   The link carries a random token; only its SHA-256 is stored, so a leaked backup
   cannot be used to build a working link. */
function newToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}
function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/* ---------- Rate limiting (in memory) ----------
   limiter.hit(key) -> true while the key is still allowed. Counting is per window;
   once `max` is passed the key stays blocked until the window ends. */
function createLimiter({ max, windowMs }) {
  const entries = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of entries) if (rec.resetAt <= now) entries.delete(key);
  }, Math.min(windowMs, 5 * 60 * 1000));
  sweep.unref();

  function current(key) {
    const now = Date.now();
    let rec = entries.get(key);
    if (!rec || rec.resetAt <= now) { rec = { count: 0, resetAt: now + windowMs }; entries.set(key, rec); }
    return rec;
  }
  return {
    /* Count one attempt. Returns false once the limit has been exceeded. */
    hit(key) { const rec = current(key); rec.count += 1; return rec.count <= max; },
    /* Is the key already over the limit (without counting)? */
    blocked(key) { const rec = entries.get(key); return !!rec && rec.resetAt > Date.now() && rec.count >= max; },
    reset(key) { entries.delete(key); },
    retryAfterSeconds(key) { const rec = entries.get(key); return rec ? Math.max(1, Math.ceil((rec.resetAt - Date.now()) / 1000)) : 1; }
  };
}

/* ---------- Response headers ---------- */
function securityHeaders(isProduction) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; ");
  return (req, res, next) => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.removeHeader("X-Powered-By");
    if (isProduction) res.setHeader("Strict-Transport-Security", "max-age=15552000");
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    next();
  };
}

module.exports = { MIN_PASSWORD_LENGTH, passwordProblem, newToken, hashToken, createLimiter, securityHeaders };
