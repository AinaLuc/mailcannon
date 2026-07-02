import crypto from "node:crypto";
import { db } from "../db.js";
import type { ScheduleItem } from "../types.js";

export function scheduleCampaign(
  campaignId: string,
  contactIds: string[],
  startAt?: string,
  providerId?: string,
): ScheduleItem[] {
  const store = db.load();
  const campaign = store.campaigns.find((c) => c.id === campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  if (campaign.steps.length === 0) throw new Error("Campaign has no steps");

  const campaignContacts = store.contacts.filter((c) => contactIds.includes(c.id));
  const missing = contactIds.filter((id) => !campaignContacts.some((c) => c.id === id));
  if (missing.length > 0) throw new Error(`Contacts not found: ${missing.join(", ")}`);

  const startTime = startAt ? new Date(startAt).getTime() : Date.now();
  const scheduleItems: ScheduleItem[] = contactIds.map((contactId) => ({
    id: crypto.randomUUID(),
    campaignId,
    contactId,
    nextStepIndex: 0,
    nextSendAt: new Date(startTime).toISOString(),
    status: "active" as const,
    startedAt: new Date().toISOString(),
    providerId,
  }));

  store.schedules.push(...scheduleItems);
  db.save(store);
  return scheduleItems;
}

export function listSchedules() {
  return db.load().schedules;
}

export function getNextDue(): ScheduleItem[] {
  const now = new Date();
  return db
    .load()
    .schedules.filter((s) => s.status === "active" && new Date(s.nextSendAt) <= now);
}
