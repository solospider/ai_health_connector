import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticatedUserId, sendUnauthorized } from "./auth/http.js";
import {
  listFamilyProfiles,
  renameFamilyProfile,
  setDisplayName,
  shareProfileWithOwner
} from "./services/family.js";

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

function page(body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Family · AI Health Connection</title></head><body style="font-family:system-ui,-apple-system,sans-serif;max-width:680px;margin:56px auto;padding:0 24px;line-height:1.5;color:#18212b"><p style="font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:12px">AI Health Connection</p>${body}</body></html>`;
}

async function familyHtml(userId: string, message?: string) {
  const profiles = await listFamilyProfiles(userId);
  const cards = profiles.map((profile) => {
    const name = escapeHtml(profile.name);
    const status = profile.oura_connected ? "Oura connected" : "Oura not connected";
    if (profile.is_self) {
      return `<section style="padding:18px;border:1px solid #e5e7eb;border-radius:12px;margin:12px 0"><strong>${name}</strong> <span style="color:#667085">(you)</span><div style="color:#667085">${status}</div></section>`;
    }
    return `<section style="padding:18px;border:1px solid #e5e7eb;border-radius:12px;margin:12px 0"><strong>${name}</strong><div style="color:#667085">${status}</div><form method="post" action="/family/rename" style="margin-top:12px"><input type="hidden" name="current_alias" value="${escapeHtml(profile.profile)}"><input name="new_alias" value="${name}" required maxlength="80" style="padding:8px"><button type="submit" style="padding:8px 12px;margin-left:6px">Rename</button></form></section>`;
  }).join("");

  return page(`<h1>Family profiles</h1><p style="color:#4b5563">Family access is consent-based. Each person keeps a separate AI Health Connection account and explicitly shares their health profile with the family owner.</p>${message ? `<p style="padding:10px 12px;background:#f2f4f7;border-radius:8px">${escapeHtml(message)}</p>` : ""}<h2>Profiles you can view</h2>${cards}<h2 style="margin-top:32px">Your profile name</h2><form method="post" action="/family/name"><input name="display_name" placeholder="e.g. Zhichao" required maxlength="80" style="padding:10px;width:220px"><button type="submit" style="padding:10px 14px;margin-left:6px">Save</button></form><h2 style="margin-top:32px">Share your profile with a family owner</h2><p style="color:#667085">Enter the owner's AI Health Connection email and the name they should use for your profile. This grants that account read access to your synced health data until access is revoked.</p><form method="post" action="/family/share"><label>Owner email<br><input name="owner_email" type="email" required style="padding:10px;width:100%;box-sizing:border-box;margin:6px 0 12px"></label><label>Profile name<br><input name="alias" placeholder="e.g. Heng" required maxlength="80" style="padding:10px;width:100%;box-sizing:border-box;margin:6px 0 16px"></label><button type="submit" style="padding:10px 14px">Share my health profile</button></form><p style="margin-top:28px"><a href="/">Back to account</a></p>`);
}

export async function handleFamilyRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/family")) return false;
  const userId = await authenticatedUserId(req);
  if (!userId) {
    sendUnauthorized(res);
    return true;
  }

  try {
    if (req.method === "GET" && url.pathname === "/family") {
      sendHtml(res, 200, await familyHtml(userId));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/family/name") {
      const form = await readForm(req);
      const name = await setDisplayName(userId, form.get("display_name") ?? "");
      sendHtml(res, 200, await familyHtml(userId, `Your profile name is now ${name}.`));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/family/share") {
      const form = await readForm(req);
      const result = await shareProfileWithOwner(userId, form.get("owner_email") ?? "", form.get("alias") ?? "");
      sendHtml(res, 200, await familyHtml(userId, `Shared successfully as ${result.alias}.`));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/family/rename") {
      const form = await readForm(req);
      const renamed = await renameFamilyProfile(userId, form.get("current_alias") ?? "", form.get("new_alias") ?? "");
      sendHtml(res, 200, await familyHtml(userId, `Profile renamed to ${renamed}.`));
      return true;
    }
  } catch (error) {
    sendHtml(res, 400, await familyHtml(userId, error instanceof Error ? error.message : "Family request failed"));
    return true;
  }

  sendHtml(res, 404, page("<h1>Not found</h1>"));
  return true;
}
