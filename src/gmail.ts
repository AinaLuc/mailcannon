import { google } from "googleapis";
import type { ProviderConfig } from "./types.js";
import { readFileSync, existsSync } from "node:fs";

if (existsSync(".env")) {
  const env = readFileSync(".env", "utf-8");
  for (const line of env.split("\n")) {
    const parts = line.split("=");
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const val = parts.slice(1).join("=").trim();
      process.env[key] = val;
    }
  }
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const REDIRECT_URI = "http://localhost:3456/api/gmail/oauth/callback";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly"
];

export function getOAuth2Client() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
}

export function getGmailAuthUrl(state: string): string {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    state,
    prompt: "consent",
  });
}

export async function handleGmailCallback(code: string) {
  const oauth2 = getOAuth2Client();
  const { tokens } = await oauth2.getToken(code);
  return tokens;
}

function mimeEncodeWord(text: string): string {
  const needsEncoding = /[^\x00-\x7F]/.test(text);
  if (!needsEncoding) return text;
  const encoded = Buffer.from(text, "utf-8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

import crypto from "node:crypto";

export async function sendViaGmail(
  config: ProviderConfig & { accessToken?: string; refreshToken?: string },
  to: string[],
  subject: string,
  body: string,
  trackingId?: string,
): Promise<{ ok: boolean; message: string; messageId?: string; threadId?: string; trackingId?: string }> {
  const actualTrackingId = trackingId || crypto.randomUUID();
  try {
    const oauth2 = getOAuth2Client();
    oauth2.setCredentials({
      access_token: config.accessToken,
      refresh_token: config.refreshToken,
    });

    const gmail = google.gmail({ version: "v1", auth: oauth2 });

    const trackingPixel = `<img src="http://localhost:3456/track/open/${actualTrackingId}" width="1" height="1" style="display:none" />`;
    const bodyWithPixel = body.includes("</body>")
      ? body.replace("</body>", `${trackingPixel}</body>`)
      : `${body}${trackingPixel}`;

    const headers = [
      `To: ${to.join(", ")}`,
      `Subject: ${mimeEncodeWord(subject)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
    ];

    const email = [...headers, "", bodyWithPixel].join("\r\n");
    const encoded = Buffer.from(email)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const result = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded },
    });

    return {
      ok: true,
      message: JSON.stringify(result.data),
      messageId: result.data.id || undefined,
      threadId: result.data.threadId || undefined,
      trackingId: actualTrackingId,
    };
  } catch (err: any) {
    return { ok: false, message: `Gmail send failed: ${err.message}` };
  }
}
