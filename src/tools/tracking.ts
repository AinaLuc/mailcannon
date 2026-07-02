import crypto from "node:crypto";
import { db } from "../db.js";
import type { SentEmail } from "../types.js";

export function recordSentEmail(
  email: Omit<SentEmail, "id" | "status" | "sentAt"> & { id?: string }
): SentEmail {
  const store = db.load();
  const record: SentEmail = {
    id: email.id || crypto.randomUUID(),
    campaignId: email.campaignId,
    contactId: email.contactId,
    recipientEmail: email.recipientEmail,
    subject: email.subject,
    sentAt: new Date().toISOString(),
    status: "sent",
    messageId: email.messageId,
    threadId: email.threadId,
  };

  store.sentEmails.push(record);
  db.save(store);
  return record;
}

export function recordOpen(id: string): boolean {
  const store = db.load();
  const idx = store.sentEmails.findIndex((e) => e.id === id);
  if (idx === -1) return false;

  // Only update status if it's currently 'sent' (i.e. don't overwrite bounced or replied status)
  const current = store.sentEmails[idx];
  if (current.status === "sent") {
    current.status = "opened";
    current.openedAt = new Date().toISOString();
    db.save(store);
    return true;
  }
  return false;
}

export function recordBounce(recipientEmail: string, bouncedAt?: string): boolean {
  const store = db.load();
  // Find the most recent sent email to this recipient
  const matches = store.sentEmails
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.recipientEmail.toLowerCase() === recipientEmail.toLowerCase())
    .sort((a, b) => new Date(b.e.sentAt).getTime() - new Date(a.e.sentAt).getTime());

  if (matches.length === 0) return false;

  // Update status of the most recent one
  const targetIndex = matches[0].index;
  const current = store.sentEmails[targetIndex];
  if (current.status !== "bounced") {
    current.status = "bounced";
    current.bouncedAt = bouncedAt || new Date().toISOString();
    db.save(store);
    return true;
  }
  return false;
}

export function recordReply(threadId: string, repliedAt?: string): boolean {
  const store = db.load();
  // Find the most recent sent email in this thread
  const matches = store.sentEmails
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.threadId === threadId)
    .sort((a, b) => new Date(b.e.sentAt).getTime() - new Date(a.e.sentAt).getTime());

  if (matches.length === 0) return false;

  const targetIndex = matches[0].index;
  const current = store.sentEmails[targetIndex];
  if (current.status !== "replied" && current.status !== "bounced") {
    current.status = "replied";
    current.repliedAt = repliedAt || new Date().toISOString();
    db.save(store);
    return true;
  }
  return false;
}

export function getDeliverabilityStats() {
  const store = db.load();
  const sentEmails = store.sentEmails;

  const total = sentEmails.length;
  if (total === 0) {
    return {
      sent: 0,
      opened: 0,
      bounced: 0,
      replied: 0,
      openRate: 0,
      bounceRate: 0,
      replyRate: 0,
      records: [],
    };
  }

  let opened = 0;
  let bounced = 0;
  let replied = 0;

  for (const email of sentEmails) {
    if (email.status === "opened") opened++;
    else if (email.status === "bounced") bounced++;
    else if (email.status === "replied") replied++;
  }

  // Note: Rates are calculated as percentage of total sent
  const openRate = total > 0 ? Math.round((opened / total) * 100) : 0;
  const bounceRate = total > 0 ? Math.round((bounced / total) * 100) : 0;
  const replyRate = total > 0 ? Math.round((replied / total) * 100) : 0;

  return {
    sent: total,
    opened,
    bounced,
    replied,
    openRate,
    bounceRate,
    replyRate,
    records: sentEmails.sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime()),
  };
}
