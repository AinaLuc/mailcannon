import { supabase } from "../supabase.js";
import type { ScheduleItem } from "../types.js";

export async function scheduleCampaign(
  campaignId: string,
  contactIds: string[],
  startAt?: string,
  providerId?: string,
): Promise<ScheduleItem[]> {
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .single();
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  const { data: steps, error: stepsErr } = await supabase
    .from("campaign_steps")
    .select("id")
    .eq("campaignId", campaignId);
  if (stepsErr) throw new Error(stepsErr.message);
  if (!steps || steps.length === 0) throw new Error("Campaign has no steps");

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id")
    .in("id", contactIds);
  const foundIds = new Set((contacts || []).map((c) => c.id));
  const missing = contactIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) throw new Error(`Contacts not found: ${missing.join(", ")}`);

  const startTime = startAt ? new Date(startAt).getTime() : Date.now();
  const items = contactIds.map((contactId) => ({
    campaignId,
    contactId,
    nextStepIndex: 0,
    nextSendAt: new Date(startTime).toISOString(),
    status: "active" as const,
    startedAt: new Date().toISOString(),
    providerId,
  }));

  const { data, error } = await supabase
    .from("schedules")
    .insert(items)
    .select();
  if (error) throw new Error(error.message);
  return data || [];
}

export async function listSchedules(): Promise<ScheduleItem[]> {
  const { data, error } = await supabase
    .from("schedules")
    .select("*")
    .order("startedAt", { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function getNextDue(): Promise<ScheduleItem[]> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("schedules")
    .select("*")
    .eq("status", "active")
    .lte("nextSendAt", now);
  if (error) throw new Error(error.message);
  return data || [];
}
