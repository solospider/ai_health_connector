import type { IncomingMessage, ServerResponse } from "node:http";
import { env } from "./config.js";
import { setSessionCookie } from "./auth/http.js";
import { loginUser, registerUser } from "./auth/service.js";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sendHtml(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff"
  });
  res.end(html);
}

async function readForm(req: IncomingMessage, limit = 16_384) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · AI Health Connection</title>
</head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:64px auto;padding:0 24px;line-height:1.5;color:#18212b">
  <p style="font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:12px">AI Health Connection</p>
  ${body}
</body>
</html>`;
}

function signupHtml(error?: string, email = "") {
  const inviteField = env.REGISTRATION_INVITE_CODE
    ? `<label>Invite code<br><input name="invite_code" autocomplete="one-time-code" required style="width:100%;box-sizing:border-box;padding:10px;margin:6px 0 16px"></label>`
    : "";
  return page(
    "Create account",
    `<h1>Create your account</h1>
<p style="color:#4b5563">Create one AI Health Connection account, then continue directly to Oura to authorize your health data.</p>
${error ? `<p style="color:#b42318">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/signup">
  <label>Email<br><input name="email" type="email" value="${escapeHtml(email)}" autocomplete="email" required style="width:100%;box-sizing:border-box;padding:10px;margin:6px 0 16px"></label>
  <label>Password<br><input name="password" type="password" autocomplete="new-password" minlength="12" required style="width:100%;box-sizing:border-box;padding:10px;margin:6px 0 16px"></label>
  <label>Confirm password<br><input name="confirm_password" type="password" autocomplete="new-password" minlength="12" required style="width:100%;box-sizing:border-box;padding:10px;margin:6px 0 16px"></label>
  ${inviteField}
  <button type="submit" style="padding:11px 18px;font-weight:600">Create account &amp; Connect Oura</button>
</form>
<p style="margin-top:24px;color:#667085;font-size:14px">Already have an account? <a href="/login">Sign in and connect Oura</a>.</p>`
  );
}

function loginHtml(error?: string, email = "") {
  return page(
    "Sign in",
    `<h1>Sign in</h1>
<p style="color:#4b5563">Sign in to connect or reconnect your Oura account.</p>
${error ? `<p style="color:#b42318">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/login">
  <label>Email<br><input name="email" type="email" value="${escapeHtml(email)}" autocomplete="email" required style="width:100%;box-sizing:border-box;padding:10px;margin:6px 0 16px"></label>
  <label>Password<br><input name="password" type="password" autocomplete="current-password" required style="width:100%;box-sizing:border-box;padding:10px;margin:6px 0 20px"></label>
  <button type="submit" style="padding:11px 18px;font-weight:600">Sign in &amp; Connect Oura</button>
</form>
<p style="margin-top:24px;color:#667085;font-size:14px">New here? <a href="/signup">Create an account</a>.</p>`
  );
}

export function setupCompleteHtml() {
  return page(
    "Setup complete",
    `<h1>Oura connected ✓</h1>
<p style="font-size:18px">Your AI Health Connection account is ready. A 90-day health-data import has started in the background.</p>
<section style="margin-top:28px;padding:20px;border:1px solid #e5e7eb;border-radius:14px">
  <p style="margin-top:0"><strong>What happens next</strong></p>
  <p>Sleep, readiness, activity, heart rate, SpO₂ and workouts will become available as Oura sync completes.</p>
  <p style="margin-bottom:0">You can now return to ChatGPT and use the AI Health Connection plugin.</p>
</section>
<p style="margin-top:24px"><a href="/">View account status</a></p>`
  );
}

export async function handleOnboardingRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/signup") {
    sendHtml(res, 200, signupHtml());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/signup") {
    const form = await readForm(req);
    const email = form.get("email") ?? "";
    const password = form.get("password") ?? "";
    const confirmPassword = form.get("confirm_password") ?? "";
    const inviteCode = form.get("invite_code") ?? undefined;
    if (password !== confirmPassword) {
      sendHtml(res, 400, signupHtml("Passwords do not match", email));
      return true;
    }
    try {
      const result = await registerUser(email, password, inviteCode);
      setSessionCookie(res, result.session.token, result.session.expiresAt);
      res.writeHead(303, { location: "/auth/oura/start", "cache-control": "no-store" });
      res.end();
    } catch (error) {
      sendHtml(res, 400, signupHtml(error instanceof Error ? error.message : "Registration failed", email));
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/login") {
    sendHtml(res, 200, loginHtml());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/login") {
    const form = await readForm(req);
    const email = form.get("email") ?? "";
    const password = form.get("password") ?? "";
    try {
      const result = await loginUser(email, password);
      setSessionCookie(res, result.session.token, result.session.expiresAt);
      res.writeHead(303, { location: "/auth/oura/start", "cache-control": "no-store" });
      res.end();
    } catch {
      sendHtml(res, 401, loginHtml("Invalid email or password", email));
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/setup/complete") {
    sendHtml(res, 200, setupCompleteHtml());
    return true;
  }

  return false;
}
