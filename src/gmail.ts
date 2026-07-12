import { google } from "googleapis";
import type { ProviderConfig } from "./types.js";
import crypto from "node:crypto";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly"
];

export function getRedirectUri() {
  const baseUrl = process.env.PUBLIC_URL || process.env.APP_URL || "http://localhost:3456";
  return `${baseUrl}/api/gmail/oauth/callback`;
}

export function getOAuth2Client() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, getRedirectUri());
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

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .trim();
}

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

    const baseUrl = process.env.PUBLIC_URL || process.env.APP_URL || "http://localhost:3456";
    const trackingPixel = `<img src="${baseUrl}/track/open/${actualTrackingId}" width="1" height="1" style="display:none" />`;
    const bodyWithPixel = body.includes("</body>")
      ? body.replace("</body>", `${trackingPixel}</body>`)
      : `${body}${trackingPixel}`;

    const unsubscribeUrl = `${baseUrl}/unsubscribe?email=${encodeURIComponent(to[0])}`;
    const unsubscribeHtml = `
<hr style="border:none;border-top:1px solid #eee;margin:20px 0;" />
<p style="font-size:12px;color:#666;text-align:center;">
  You are receiving this email because you are on our list.
  <a href="${unsubscribeUrl}" style="color:#1155cc;text-decoration:underline;">Unsubscribe</a>
</p>
`;
    const finalHtml = bodyWithPixel.includes("</body>")
      ? bodyWithPixel.replace("</body>", `${unsubscribeHtml}</body>`)
      : `${bodyWithPixel}${unsubscribeHtml}`;

    const plainText = stripHtml(body);
    const finalPlainText = `${plainText}\n\n---\nYou are receiving this email because you are on our list.\nUnsubscribe: ${unsubscribeUrl}`;

    const boundary = `----=_Part_${crypto.randomUUID().replace(/-/g, "")}`;

    const headers = [
      `To: ${to.join(", ")}`,
      `Subject: ${mimeEncodeWord(subject)}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      `List-Unsubscribe: <${unsubscribeUrl}>`,
      `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
    ];

    const parts = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      finalPlainText,
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      finalHtml,
      `--${boundary}--`,
    ];

    const email = [...headers, "", ...parts].join("\r\n");
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
