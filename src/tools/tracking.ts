import crypto from "node:crypto";
import { supabase } from "../supabase.js";
import type { SentEmail } from "../types.js";

export async function recordSentEmail(
  email: Omit<SentEmail, "id" | "status" | "sentAt"> & { id?: string }
): Promise<SentEmail> {
  const record = {
    id: email.id || crypto.randomUUID(),
    campaignId: email.campaignId,
    contactId: email.contactId,
    recipientEmail: email.recipientEmail,
    subject: email.subject,
    messageId: email.messageId,
    threadId: email.threadId,
  };

  const { data, error } = await supabase
    .from("sent_emails")
    .insert(record)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function recordOpen(id: string): Promise<boolean> {
  const { data: current } = await supabase
    .from("sent_emails")
    .select("status")
    .eq("id", id)
    .single();

  if (!current || current.status !== "sent") return false;

  const { error } = await supabase
    .from("sent_emails")
    .update({ status: "opened", openedAt: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "sent");
  if (error) throw new Error(error.message);
  return true;
}

export async function recordBounce(recipientEmail: string, bouncedAt?: string): Promise<boolean> {
  const { data: matches } = await supabase
    .from("sent_emails")
    .select("id, status")
    .eq("recipientEmail", recipientEmail.toLowerCase())
    .order("sentAt", { ascending: false })
    .limit(1);

  if (!matches || matches.length === 0) return false;
  const target = matches[0];
  if (target.status === "bounced") return false;

  const { error } = await supabase
    .from("sent_emails")
    .update({ status: "bounced", bouncedAt: bouncedAt || new Date().toISOString() })
    .eq("id", target.id);
  if (error) throw new Error(error.message);
  return true;
}

export async function recordReply(threadId: string, repliedAt?: string): Promise<boolean> {
  const { data: matches } = await supabase
    .from("sent_emails")
    .select("id, status")
    .eq("threadId", threadId)
    .order("sentAt", { ascending: false })
    .limit(1);

  if (!matches || matches.length === 0) return false;
  const target = matches[0];
  if (target.status === "replied" || target.status === "bounced") return false;

  const { error } = await supabase
    .from("sent_emails")
    .update({ status: "replied", repliedAt: repliedAt || new Date().toISOString() })
    .eq("id", target.id);
  if (error) throw new Error(error.message);
  return true;
}

export async function getDeliverabilityStats() {
  const { data: sentEmails, error } = await supabase
    .from("sent_emails")
    .select("*")
    .order("sentAt", { ascending: false });

  if (error) throw new Error(error.message);

  const total = sentEmails?.length || 0;
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

  for (const email of sentEmails || []) {
    if (email.status === "opened") opened++;
    else if (email.status === "bounced") bounced++;
    else if (email.status === "replied") replied++;
  }

  return {
    sent: total,
    opened,
    bounced,
    replied,
    openRate: Math.round((opened / total) * 100),
    bounceRate: Math.round((bounced / total) * 100),
    replyRate: Math.round((replied / total) * 100),
    records: sentEmails || [],
  };
}
