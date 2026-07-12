import { google } from "googleapis";
import { listProviders } from "./tools/providers.js";
import { recordBounce, recordReply } from "./tools/tracking.js";
import { getOAuth2Client } from "./gmail.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getReadingTransport } from "./mcp-client.js";
import type { ProviderConfig } from "./types.js";

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

async function pollZohoInbox(provider: ProviderConfig) {
  if (provider.kind !== "zoho" || !provider.readingUrl) return;

  const client = new Client(
    { name: "mailcannon-client", version: "0.1.0" },
    { capabilities: {} },
  );

  try {
    const transport = getReadingTransport(provider);
    await client.connect(transport);

    const toolsResult = await client.listTools();
    const tools = toolsResult.tools;

    const listTool = tools.find(t => {
      const n = t.name.toLowerCase().replace(/^[a-z0-9]+_/, "").replace(/_/g, "");
      return n === "listemails" || n === "listmessages" ||
             n === "searchemails" || n === "searchmessages" ||
             n === "getmessages";
    });

    if (!listTool) {
      console.error(`[Poller] No read/list tool found on Zoho reading server for provider ${provider.name}`);
      await client.close();
      return;
    }

    function fillArgs(schemaProps: Record<string, any> | undefined, target: Record<string, any>) {
      if (!schemaProps) return;
      for (const [key, prop] of Object.entries(schemaProps)) {
        const p = prop as any;
        const lk = key.toLowerCase();
        if (p.properties) {
          const nested: Record<string, any> = {};
          fillArgs(p.properties, nested);
          if (Object.keys(nested).length) target[key] = nested;
        } else if (lk === "accountid" || lk === "account_id") {
          target[key] = provider.env?.accountId || "";
        } else if (lk === "folderid" || lk === "folder_id") {
          if (provider.env?.folderId) target[key] = provider.env.folderId;
        } else if (lk === "foldername" || lk === "folder_name") {
          target[key] = "Inbox";
        } else if (lk === "status") {
          target[key] = "unread";
        } else if (lk === "fields" && p.default) {
          target[key] = p.default;
        }
      }
    }

    const args: Record<string, any> = {};
    fillArgs(listTool.inputSchema?.properties as any, args);

    const listResponse = await client.callTool({
      name: listTool.name,
      arguments: args,
    });

    const contentText = (listResponse.content as any)
      ?.map((c: any) => c.text ?? "")
      .join("\n");

    if (!contentText) {
      await client.close();
      return;
    }

    let emails: any[] = [];
    try {
      const parsed = JSON.parse(contentText);
      if (Array.isArray(parsed)) {
        emails = parsed;
      } else if (parsed.data && Array.isArray(parsed.data)) {
        emails = parsed.data;
      } else if (parsed.emails && Array.isArray(parsed.emails)) {
        emails = parsed.emails;
      } else if (parsed.messages && Array.isArray(parsed.messages)) {
        emails = parsed.messages;
      }
    } catch {
      // raw/unparseable
    }

    if (!emails.length) {
      await client.close();
      return;
    }

    const { supabase } = await import("./supabase.js");
    const { data: activeSentEmails } = await supabase
      .from("sent_emails")
      .select("*")
      .in("status", ["sent", "opened"]);

    for (const email of emails) {
      try {
        let emailId = email.messageId || email.id || "";
        if (!emailId) continue;
        if (processedMessageIds.has(emailId)) continue;

        let from = email.from || email.sender || email.fromAddress || "";
        let subject = email.subject || "";
        let body = email.content || email.body || email.snippet || email.description || "";
        let threadId = email.threadId || email.thread_id || "";

        const readTool = tools.find(t => {
          const n = t.name.toLowerCase().replace(/^[a-z0-9]+_/, "").replace(/_/g, "");
          return n === "getmessagecontent" || n === "getmessagedetails" ||
                 n === "reademail" || n === "getmessage";
        });
        if ((!body || !from) && readTool) {
          const readArgs: Record<string, any> = {};
          const rProps = readTool.inputSchema?.properties as any;
          function fillReadArgs(schemaProps: Record<string, any> | undefined, target: Record<string, any>) {
            if (!schemaProps) return;
            for (const [key, prop] of Object.entries(schemaProps)) {
              const p = prop as any;
              const lk = key.toLowerCase();
              if (p.properties) {
                const nested: Record<string, any> = {};
                fillReadArgs(p.properties, nested);
                if (Object.keys(nested).length) target[key] = nested;
              } else if (lk === "messageid" || lk === "id" || lk === "emailid" || lk === "email_id") {
                target[key] = emailId;
              } else if (lk === "accountid" || lk === "account_id") {
                target[key] = provider.env?.accountId || "";
              }
            }
          }
          fillReadArgs(rProps, readArgs);
          const detailRes = await client.callTool({
            name: readTool.name,
            arguments: readArgs,
          });
          const detailText = (detailRes.content as any)?.map((c: any) => c.text ?? "").join("\n");
          if (detailText) {
            try {
              const parsedDetail = JSON.parse(detailText);
              const data = parsedDetail.data || parsedDetail;
              from = from || data.from || data.sender || data.fromAddress || "";
              subject = subject || data.subject || "";
              body = body || data.content || data.body || data.snippet || "";
              threadId = threadId || data.threadId || data.thread_id || "";
            } catch {}
          }
        }

        processedMessageIds.add(emailId);

        const isBounceSender = /mailer-daemon|postmaster/i.test(from);
        const isBounceSubject = /delivery status notification|undeliverable|failure notice|returned mail/i.test(subject);
        const fullText = (body + " " + subject).toLowerCase();

        if (isBounceSender || isBounceSubject) {
          let bouncedEmail = "";
          for (const sent of activeSentEmails || []) {
            if (fullText.includes(sent.recipientEmail.toLowerCase())) {
              bouncedEmail = sent.recipientEmail;
              break;
            }
          }
          if (bouncedEmail) {
            const updated = await recordBounce(bouncedEmail);
            if (updated) {
              console.error(`[Poller] Zoho successfully recorded bounce for: ${bouncedEmail}`);
            }
          }
          continue;
        }

        if (threadId) {
          const originalSent = (activeSentEmails || []).find(
            (e: any) => e.threadId === threadId || e.messageId === threadId
          );

          if (originalSent) {
            if (from.toLowerCase().includes(originalSent.recipientEmail.toLowerCase())) {
              const updated = await recordReply(originalSent.threadId || originalSent.messageId || threadId);
              if (updated) {
                console.error(`[Poller] Zoho successfully recorded reply in thread: ${threadId}`);
              }
            }
          }
        } else {
          for (const sent of activeSentEmails || []) {
            if (from.toLowerCase().includes(sent.recipientEmail.toLowerCase())) {
              const cleanSentSubject = sent.subject.replace(/^(re|fwd):\s*/i, "").trim().toLowerCase();
              const cleanRecvSubject = subject.replace(/^(re|fwd):\s*/i, "").trim().toLowerCase();
              if (cleanSentSubject === cleanRecvSubject) {
                const updated = await recordReply(sent.id);
                if (updated) {
                  console.error(`[Poller] Zoho successfully matched reply by subject: ${subject}`);
                }
              }
            }
          }
        }
      } catch (err: any) {
        console.error(`[Poller] Zoho error processing email:`, err.message);
      }
    }

    await client.close();
  } catch (err: any) {
    console.error(`[Poller] Zoho error polling inbox for provider ${provider.name}:`, err.message);
  }
}

export async function pollInbox() {
  const providers = await listProviders();

  for (const provider of providers) {
    if (provider.kind === "gmail" && provider.refreshToken) {
      try {
        const oauth2 = getOAuth2Client();
        oauth2.setCredentials({
          access_token: provider.accessToken,
          refresh_token: provider.refreshToken,
        });

        const gmail = google.gmail({ version: "v1", auth: oauth2 });

        const res = await gmail.users.messages.list({
          userId: "me",
          q: "is:unread",
          maxResults: 20,
        });

        const messages = res.data.messages || [];
        if (messages.length === 0) continue;

        const { supabase } = await import("./supabase.js");
        const { data: activeSentEmails } = await supabase
          .from("sent_emails")
          .select("*")
          .in("status", ["sent", "opened"]);

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

            processedMessageIds.add(msgRef.id);

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
                for (const sent of activeSentEmails || []) {
                  if (fullText.includes(sent.recipientEmail.toLowerCase())) {
                    bouncedEmail = sent.recipientEmail;
                    break;
                  }
                }
              }

              if (bouncedEmail) {
                const updated = await recordBounce(bouncedEmail);
                if (updated) {
                  console.error(`[Poller] Successfully recorded bounce for: ${bouncedEmail}`);
                }
              }
              continue;
            }

            const threadId = data.threadId;
            if (threadId) {
              const originalSent = (activeSentEmails || []).find(
                (e: any) => e.threadId === threadId
              );

              if (originalSent) {
                if (from.toLowerCase().includes(originalSent.recipientEmail.toLowerCase())) {
                  const updated = await recordReply(threadId);
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
    } else if (provider.kind === "zoho" && provider.readingUrl) {
      try {
        await pollZohoInbox(provider);
      } catch (err: any) {
        console.error(`[Poller] Error polling Zoho inbox for provider ${provider.name}:`, err.message);
      }
    }
  }
}

let pollerInterval: NodeJS.Timeout | null = null;

export function startInboxPoller(intervalMs: number = 30000) {
  if (pollerInterval) return;

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
