import { z } from "zod";
import { supabaseAdmin as supabase } from "../supabase.js";
import type { Campaign, CampaignStep } from "../types.js";

export const CreateCampaignSchema = z.object({
  name: z.string().min(1),
});

export const AddStepSchema = z.object({
  campaignId: z.string(),
  day: z.number().min(0),
  subject: z.string(),
  body: z.string(),
});

export const DeleteCampaignSchema = z.object({
  id: z.string(),
});

export const UpdateCampaignSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
});

export const DeleteStepSchema = z.object({
  id: z.string(),
});

export const UpdateStepSchema = z.object({
  id: z.string(),
  day: z.number().min(0).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
});

export const ScheduleCampaignSchema = z.object({
  campaignId: z.string(),
  contactIds: z.array(z.string()).min(1),
  startAt: z.string().optional(),
  provider: z.enum(["gmail", "zoho"]).optional().default("gmail"),
});

export async function createCampaign(name: string, userId: string): Promise<Campaign> {
  const { data, error } = await supabase
    .from("campaigns")
    .insert({ name, user_id: userId })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return { ...data, steps: [] };
}

export async function addStep(input: z.infer<typeof AddStepSchema>, userId: string): Promise<CampaignStep> {
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", input.campaignId)
    .eq("user_id", userId)
    .single();
  if (!campaign) throw new Error(`Campaign ${input.campaignId} not found`);

  const { data, error } = await supabase
    .from("campaign_steps")
    .insert({
      campaignId: input.campaignId,
      day: input.day,
      subject: input.subject,
      body: input.body,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function listCampaigns(userId: string): Promise<Campaign[]> {
  const { data: campaigns, error } = await supabase
    .from("campaigns")
    .select("*")
    .eq("user_id", userId)
    .order("createdAt", { ascending: false });
  if (error) throw new Error(error.message);

  const campaignIds = (campaigns || []).map((c) => c.id);
  const { data: steps } = campaignIds.length
    ? await supabase.from("campaign_steps").select("*").in("campaignId", campaignIds)
    : { data: [] };
  const stepsByCampaign: Record<string, CampaignStep[]> = {};
  for (const step of steps || []) {
    const cid = (step as any).campaignId;
    if (!stepsByCampaign[cid]) stepsByCampaign[cid] = [];
    stepsByCampaign[cid].push(step);
  }

  for (const campaignId of Object.keys(stepsByCampaign)) {
    stepsByCampaign[campaignId].sort((a, b) => {
      if (a.day !== b.day) return a.day - b.day;
      return a.id.localeCompare(b.id);
    });
  }

  return (campaigns || []).map((c) => ({
    ...c,
    steps: stepsByCampaign[c.id] || [],
  }));
}

export async function deleteCampaign(id: string, userId: string): Promise<boolean> {
  const { count } = await supabase
    .from("campaigns")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("user_id", userId);
  return (count ?? 0) > 0;
}

export async function updateCampaign(id: string, name: string, userId: string): Promise<Campaign> {
  const { data, error } = await supabase
    .from("campaigns")
    .update({ name })
    .eq("id", id)
    .eq("user_id", userId)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return { ...data, steps: [] };
}

export async function deleteStep(id: string, userId: string): Promise<boolean> {
  const { data: step } = await supabase
    .from("campaign_steps")
    .select("campaignId")
    .eq("id", id)
    .single();
  if (!step) return false;

  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", (step as any).campaignId)
    .eq("user_id", userId)
    .single();
  if (!campaign) return false;

  const { count } = await supabase
    .from("campaign_steps")
    .delete({ count: "exact" })
    .eq("id", id);
  return (count ?? 0) > 0;
}

export async function updateStep(
  id: string,
  fields: { day?: number; subject?: string; body?: string },
  userId: string,
): Promise<CampaignStep> {
  const { data: step } = await supabase
    .from("campaign_steps")
    .select("campaignId")
    .eq("id", id)
    .single();
  if (!step) throw new Error("Step not found");

  const s = step as any;
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", s.campaignId)
    .eq("user_id", userId)
    .single();
  if (!campaign) throw new Error("Campaign not found or access denied");

  const { data, error } = await supabase
    .from("campaign_steps")
    .update(fields)
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function pauseCampaign(id: string, userId: string): Promise<{ paused: number }> {
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .single();
  if (!campaign) throw new Error("Campaign not found or access denied");

  const { data, error } = await supabase
    .from("schedules")
    .update({ status: "paused" })
    .eq("campaignId", id)
    .eq("status", "active")
    .select();
  if (error) throw new Error(error.message);
  return { paused: (data || []).length };
}

export async function resumeCampaign(id: string, userId: string): Promise<{ resumed: number }> {
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .single();
  if (!campaign) throw new Error("Campaign not found or access denied");

  const { data, error } = await supabase
    .from("schedules")
    .update({ status: "active" })
    .eq("campaignId", id)
    .eq("status", "paused")
    .select();
  if (error) throw new Error(error.message);
  return { resumed: (data || []).length };
}

export async function getStepById(stepId: string, userId: string): Promise<{ subject: string; body: string } | null> {
  const { data: step } = await supabase
    .from("campaign_steps")
    .select("subject, body, campaignId")
    .eq("id", stepId)
    .single();
  if (!step) return null;

  const s = step as any;
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", s.campaignId)
    .eq("user_id", userId)
    .single();
  if (!campaign) return null;

  return { subject: s.subject, body: s.body };
}
