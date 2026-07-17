import { supabaseAdmin as supabase } from "../supabase.js";
import crypto from "node:crypto";
import type { CampaignStep, ProviderConfig, ScheduleItem } from "../types.js";

function sortCampaignSteps(steps: CampaignStep[]): CampaignStep[] {
  return [...steps].sort((a, b) => {
    if (a.day !== b.day) return a.day - b.day;
    return a.id.localeCompare(b.id);
  });
}

async function getSteps(campaignId: string): Promise<CampaignStep[]> {
  const { data } = await supabase
    .from("campaign_steps")
    .select("*")
    .eq("campaignId", campaignId);
  return sortCampaignSteps(data || []);
}

async function getProvider(providerId?: string, userId?: string): Promise<ProviderConfig | undefined> {
  if (providerId) {
    const { data } = await supabase
      .from("providers")
      .select("*")
      .eq("id", providerId)
      .single();
    if (data) return data;
  }
  // Fallback: prefer Gmail (uses app OAuth refreh), then any other
  if (userId) {
    const { data: gmailProvider } = await supabase
      .from("providers")
      .select("*")
      .eq("user_id", userId)
      .eq("kind", "gmail")
      .order("createdAt", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (gmailProvider) return gmailProvider;
    const { data: anyProvider } = await supabase
      .from("providers")
      .select("*")
      .eq("user_id", userId)
      .order("createdAt", { ascending: false })
      .limit(1)
      .maybeSingle();
    return anyProvider || undefined;
  }
  return undefined;
}

async function getContactInfo(contactId: string): Promise<{ email?: string; firstName?: string; lastName?: string; company?: string; title?: string; unsubscribed?: boolean } | undefined> {
  const { data } = await supabase
    .from("contacts")
    .select("email, firstName, lastName, company, title, unsubscribed")
    .eq("id", contactId)
    .single();
  return data || undefined;
}

function fillTemplate(text: string, contact: { email: string; firstName?: string; lastName?: string; company?: string; title?: string }): string {
  return text
    .replace(/\{\{email\}\}/g, contact.email)
    .replace(/\{\{firstName\}\}/g, contact.firstName || contact.email.split("@")[0])
    .replace(/\{\{lastName\}\}/g, contact.lastName || "")
    .replace(/\{\{company\}\}/g, contact.company || "")
    .replace(/\{\{title\}\}/g, contact.title || "");
}

async function claimScheduleItem(id: string): Promise<boolean> {
  const { data } = await supabase
    .from("schedules")
    .update({ status: "processing" })
    .eq("id", id)
    .eq("status", "active")
    .select()
    .single();
  return !!data;
}

async function processItem(item: ScheduleItem, steps: CampaignStep[]): Promise<void> {
  // Atomic claim: only process if we can transition active -> processing
  const claimed = await claimScheduleItem(item.id);
  if (!claimed) return; // Another process already claimed this item

  const step = steps[item.nextStepIndex];
  if (!step) {
    await supabase.from("schedules").update({ status: "completed" }).eq("id", item.id).eq("status", "processing");
    return;
  }

  const contactInfo = await getContactInfo(item.contactId);
  if (!contactInfo || !contactInfo.email) {
    await supabase.from("schedules").update({ status: "failed" }).eq("id", item.id).eq("status", "processing");
    return;
  }

  if (contactInfo.unsubscribed) {
    await supabase.from("schedules").update({ status: "completed" }).eq("id", item.id).eq("status", "processing");
    return;
  }

  const contact = { email: contactInfo.email, firstName: contactInfo.firstName, lastName: contactInfo.lastName, company: contactInfo.company, title: contactInfo.title };
  const subject = fillTemplate(step.subject, contact);
  const body = fillTemplate(step.body, contact);

  // Dedup: check if this step was already sent
  const { data: existing } = await supabase
    .from("sent_emails")
    .select("id")
    .eq("campaignId", item.campaignId)
    .eq("contactId", item.contactId)
    .eq("subject", subject)
    .maybeSingle();
  if (existing) {
    // Already sent, just advance the step
    await advanceToNextStep(item.id, steps, item.nextStepIndex);
    return;
  }

  let sendOk = false;
  const provider = await getProvider(item.providerId, item.user_id);

  if (provider?.kind === "gmail" && provider.refreshToken) {
    const { getOAuth2Client } = await import("../gmail.js");
    const { google } = await import("googleapis");
    const oauth2 = getOAuth2Client();
    oauth2.setCredentials({
      access_token: provider.accessToken,
      refresh_token: provider.refreshToken,
    });
    const gmail = google.gmail({ version: "v1", auth: oauth2 });
    const utf8Subject = "=?UTF-8?B?" + Buffer.from(subject).toString("base64") + "?=";
    const messageParts = [
      `From: me`,
      `To: ${contactInfo.email}`,
      `Subject: ${utf8Subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      body,
    ];
    const encoded = Buffer.from(messageParts.join("\n")).toString("base64url");
    try {
      const sent = await gmail.users.messages.send({ userId: "me", requestBody: { raw: encoded } });
      const { recordSentEmail } = await import("./tracking.js");
      await recordSentEmail({
        id: crypto.randomUUID(),
        campaignId: item.campaignId,
        contactId: item.contactId,
        recipientEmail: contactInfo.email,
        subject,
        messageId: sent.data.id || undefined,
        threadId: sent.data.threadId || undefined,
      }, item.user_id!);
      sendOk = true;
    } catch (err: any) {
      console.error("[Processor] Gmail send failed:", err.message);
    }
  } else if (provider) {
    const { sendViaMCP } = await import("../mcp-client.js");
    const result = await sendViaMCP(provider, [contactInfo.email], subject, body);
    if (result.ok && result.trackingId) {
      const { recordSentEmail } = await import("./tracking.js");
      await recordSentEmail({
        id: result.trackingId,
        campaignId: item.campaignId,
        contactId: item.contactId,
        recipientEmail: contactInfo.email,
        subject,
        messageId: (result as any).messageId || undefined,
        threadId: (result as any).threadId || undefined,
      }, item.user_id!);
      sendOk = true;
    }
  }

  if (sendOk) {
    await supabase.from("schedules").update({ error: null }).eq("id", item.id);
    await advanceToNextStep(item.id, steps, item.nextStepIndex);
  } else {
    const errMsg = !provider ? "No email provider found — add one in Settings > Providers" : provider.kind === "gmail" ? "Gmail send failed — check OAuth tokens are valid" : `Provider "${provider.kind}" send failed`;
    await supabase.from("schedules").update({ status: "failed", error: errMsg }).eq("id", item.id).eq("status", "processing");
  }
}

async function advanceToNextStep(scheduleId: string, steps: CampaignStep[], currentIndex: number): Promise<void> {
  const nextIndex = currentIndex + 1;
  const nextStep = steps[nextIndex];
  if (!nextStep) {
    await supabase.from("schedules").update({ status: "completed" }).eq("id", scheduleId);
  } else {
    const delayMs = (nextStep as any).day * 3600000;
    const nextSendAt = new Date(Date.now() + delayMs).toISOString();
    await supabase.from("schedules").update({
      status: "active",
      nextStepIndex: nextIndex,
      nextSendAt,
    }).eq("id", scheduleId);
  }
}

export async function processDueCampaigns(includeFailed = false): Promise<number> {
  const now = new Date().toISOString();
  let allItems: any[] = [];
  const { data: active } = await supabase.from("schedules").select("*").eq("status", "active").lte("nextSendAt", now);
  if (active) allItems.push(...active);
  if (includeFailed) {
    const { data: failed } = await supabase.from("schedules").select("*").eq("status", "failed");
    if (failed) allItems.push(...failed);
  }
  if (allItems.length === 0) return 0;

  const stepCache = new Map<string, CampaignStep[]>();
  let count = 0;
  for (const item of allItems) {
    try {
      if (!stepCache.has(item.campaignId)) {
        stepCache.set(item.campaignId, await getSteps(item.campaignId));
      }
      await processItem(item, stepCache.get(item.campaignId)!);
      count++;
    } catch (err: any) {
      console.error("[Processor] Error processing schedule", item.id, err.message);
      await supabase.from("schedules").update({ error: `Unexpected error: ${err.message}`, status: "failed" }).eq("id", item.id);
    }
  }
  return count;
}

export async function retryFailedSchedules(): Promise<number> {
  const { data: failed } = await supabase
    .from("schedules")
    .select("*")
    .eq("status", "failed");
  if (!failed || failed.length === 0) return 0;
  const ids = failed.map((r: any) => r.id);
  const { error } = await supabase
    .from("schedules")
    .update({ status: "active", error: null, nextSendAt: new Date().toISOString() })
    .in("id", ids);
  if (error) throw new Error(error.message);
  return ids.length;
}
