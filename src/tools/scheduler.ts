import { supabaseAdmin as supabase } from "../supabase.js";
import type { CampaignStep, ScheduleItem } from "../types.js";

function sortCampaignSteps(steps: CampaignStep[]): CampaignStep[] {
  return [...steps].sort((a, b) => {
    if (a.day !== b.day) return a.day - b.day;
    return a.id.localeCompare(b.id);
  });
}

export async function scheduleCampaign(
  campaignId: string,
  contactIds: string[],
  userId: string,
  startAt?: string,
  providerId?: string,
  tags?: string[],
): Promise<ScheduleItem[]> {
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("user_id", userId)
    .single();
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  const { data: steps } = await supabase
    .from("campaign_steps")
    .select("id")
    .eq("campaignId", campaignId);
  if (!steps || steps.length === 0) throw new Error("Campaign has no steps");

  // Resolve final contact list
  let finalIds = contactIds;
  if (tags && tags.length > 0) {
    const { data: tagContacts } = await supabase
      .from("contacts")
      .select("id")
      .eq("user_id", userId)
      .eq("unsubscribed", false)
      .overlaps("tags", tags);
    finalIds = (tagContacts || []).map((c) => c.id);
    if (finalIds.length === 0) throw new Error("No contacts found matching the specified tags");
  } else {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id")
      .in("id", contactIds)
      .eq("user_id", userId)
      .eq("unsubscribed", false);
    const foundIds = new Set((contacts || []).map((c) => c.id));
    const missing = contactIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) throw new Error(`Contacts not found: ${missing.join(", ")}`);
  }

  const startTime = startAt ? new Date(startAt).getTime() : Date.now();
  const items = finalIds.map((contactId) => ({
    campaignId,
    contactId,
    user_id: userId,
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

function renderTemplate(text: string, contact: { firstName?: string; lastName?: string; company?: string; title?: string; email?: string }): string {
  return text
    .replace(/\{\{email\}\}/g, contact.email || "")
    .replace(/\{\{firstName\}\}/g, contact.firstName || contact.email?.split("@")[0] || "")
    .replace(/\{\{lastName\}\}/g, contact.lastName || "")
    .replace(/\{\{company\}\}/g, contact.company || "")
    .replace(/\{\{title\}\}/g, contact.title || "");
}

export interface RenderedStep extends CampaignStep {
  renderedSubject: string;
  renderedBody: string;
}

export interface EnrichedSchedule extends ScheduleItem {
  contactEmail?: string;
  contactFirstName?: string;
  contactLastName?: string;
  contactCompany?: string;
  contactTitle?: string;
  campaignName?: string;
  steps?: CampaignStep[];
  renderedSteps?: RenderedStep[];
}

export async function listSchedules(userId: string): Promise<EnrichedSchedule[]> {
  const { data, error } = await supabase
    .from("schedules")
    .select("*")
    .eq("user_id", userId)
    .order("startedAt", { ascending: false });
  if (error) throw new Error(error.message);
  const schedules = data || [];

  const campIds = [...new Set(schedules.map((s) => s.campaignId))];
  const contactIds = [...new Set(schedules.map((s) => s.contactId))];

  const [campaignsRes, contactsRes] = await Promise.all([
    supabase.from("campaigns").select("id,name").in("id", campIds),
    supabase.from("contacts").select("id,email,firstName,lastName,company,title").in("id", contactIds),
  ]);

  const campaignNames = new Map((campaignsRes.data || []).map((c) => [c.id, c.name]));
  const contactMap = new Map((contactsRes.data || []).map((c) => [c.id, c]));

  // Also fetch campaign steps for each campaign
  const { data: allSteps } = await supabase
    .from("campaign_steps")
    .select("*")
    .in("campaignId", campIds);
  const stepsByCampaign = new Map<string, CampaignStep[]>();
  for (const step of allSteps || []) {
    const cid = (step as any).campaignId;
    if (!stepsByCampaign.has(cid)) stepsByCampaign.set(cid, []);
    stepsByCampaign.get(cid)!.push(step);
  }
  for (const [campaignId, steps] of stepsByCampaign.entries()) {
    stepsByCampaign.set(campaignId, sortCampaignSteps(steps));
  }

  return schedules.map((s) => {
    const c = contactMap.get(s.contactId) || { email: '', firstName: '', lastName: '', company: '', title: '' };
    const contactInfo = { firstName: c.firstName, lastName: c.lastName, company: c.company, title: c.title, email: c.email };
    const steps = stepsByCampaign.get(s.campaignId) || [];
    const renderedSteps: RenderedStep[] = steps.map((step) => ({
      ...step,
      renderedSubject: renderTemplate(step.subject, contactInfo),
      renderedBody: renderTemplate(step.body, contactInfo),
    }));
    return {
      ...s,
      contactEmail: c.email,
      contactFirstName: c.firstName,
      contactLastName: c.lastName,
      contactCompany: c.company,
      contactTitle: c.title,
      campaignName: campaignNames.get(s.campaignId),
      steps,
      renderedSteps,
    };
  });
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
