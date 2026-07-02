import { google } from "googleapis";
import { listProviders } from "./tools/providers.js";
import { db } from "./db.js";
import { recordBounce, recordReply } from "./tools/tracking.js";
import { getOAuth2Client } from "./gmail.js";
const processedMessageIds = new Set<string>();


function getHeader(headers: { name?: string | null; value?: string | null }[] | undefined, name: string): string {
  if (!headers) return "";
  const found = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return found?.value || "";
}

function getMessageBody(payload: any): string {
  if (!payload) return "";
  if (payload.body?.data) {
    try {
      return Buffer.from(payload.body.data, "base64").toString("utf-8");
    } catch {
      return "";
    }
  }
  let body = "";
  if (payload.parts) {
    for (const part of payload.parts) {
      body += getMessageBody(part);
    }
  }
  return body;
}

export async function pollInbox() {
  const providers = listProviders().filter(
    (p) => p.kind === "gmail" && p.refreshToken
  );

  for (const provider of providers) {
    try {
      const oauth2 = getOAuth2Client();
      oauth2.setCredentials({
        access_token: provider.accessToken,
        refresh_token: provider.refreshToken,
      });

      const gmail = google.gmail({ version: "v1", auth: oauth2 });

      // List unread messages in the inbox
      const res = await gmail.users.messages.list({
        userId: "me",
        q: "is:unread",
        maxResults: 20,
      });

      const messages = res.data.messages || [];
      if (messages.length === 0) continue;

      const store = db.load();
      const activeSentEmails = store.sentEmails.filter(
        (e) => e.status === "sent" || e.status === "opened"
      );

      for (const msgRef of messages) {
        if (!msgRef.id) continue;
        if (processedMessageIds.has(msgRef.id)) continue;

        try {
          const msgDetails = await gmail.users.messages.get({
            userId: "me",
            id: msgRef.id,
            format: "full",
          });

          const data = msgDetails.data;
          const headers = data.payload?.headers || [];
          const from = getHeader(headers, "From");
          const subject = getHeader(headers, "Subject");
          const xFailedRecipients = getHeader(headers, "X-Failed-Recipients");
          
          const body = getMessageBody(data.payload);
          const snippet = data.snippet || "";
          const fullText = (body + " " + snippet).toLowerCase();

          // Mark as processed
          processedMessageIds.add(msgRef.id);

          // 1. Detect if it is a bounce
          const isBounceSender = /mailer-daemon|postmaster/i.test(from);
          const isBounceSubject = /delivery status notification|undeliverable|failure notice|returned mail/i.test(subject);
          const hasFailedHeader = !!xFailedRecipients;

          if (isBounceSender || isBounceSubject || hasFailedHeader) {
            let bouncedEmail = "";

            if (xFailedRecipients) {
              const match = xFailedRecipients.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
              if (match) bouncedEmail = match[0];
            }

            if (!bouncedEmail) {
              // Search body/snippet for any of our active sent emails' recipients
              for (const sent of activeSentEmails) {
                if (fullText.includes(sent.recipientEmail.toLowerCase())) {
                  bouncedEmail = sent.recipientEmail;
                  break;
                }
              }
            }

            if (bouncedEmail) {
              const updated = recordBounce(bouncedEmail);
              if (updated) {
                console.error(`[Poller] Successfully recorded bounce for: ${bouncedEmail}`);
              }
            }
            continue;
          }

          // 2. Detect if it is a reply
          const threadId = data.threadId;
          if (threadId) {
            const originalSent = store.sentEmails.find(
              (e) => e.threadId === threadId
            );

            if (originalSent) {
              // Ensure the sender is the recipient (not ourselves replying to them)
              if (from.toLowerCase().includes(originalSent.recipientEmail.toLowerCase())) {
                const updated = recordReply(threadId);
                if (updated) {
                  console.error(`[Poller] Successfully recorded reply in thread: ${threadId}`);
                }
              }
            }
          }
        } catch (err: any) {
          console.error(`[Poller] Error processing message ${msgRef.id}:`, err.message);
        }
      }
    } catch (err: any) {
      console.error(`[Poller] Error polling inbox for provider ${provider.name}:`, err.message);
    }
  }
}

let pollerInterval: NodeJS.Timeout | null = null;

export function startInboxPoller(intervalMs: number = 30000) {
  if (pollerInterval) return;
  
  // Run immediately on start, then at intervals
  pollInbox().catch((err) => console.error("[Poller] Immediate run failed:", err.message));
  
  pollerInterval = setInterval(() => {
    pollInbox().catch((err) => console.error("[Poller] Interval execution failed:", err.message));
  }, intervalMs);

  console.error(`[Poller] Inbox poller started with interval ${intervalMs}ms`);
}

export function stopInboxPoller() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.error("[Poller] Inbox poller stopped");
  }
}
