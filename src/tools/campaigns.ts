import { z } from "zod";
import { supabase } from "../supabase.js";
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

export const ScheduleCampaignSchema = z.object({
  campaignId: z.string(),
  contactIds: z.array(z.string()).min(1),
  startAt: z.string().optional(),
  provider: z.enum(["gmail", "zoho"]).optional().default("gmail"),
});

export async function createCampaign(name: string): Promise<Campaign> {
  const { data, error } = await supabase
    .from("campaigns")
    .insert({ name })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return { ...data, steps: [] };
}

export async function addStep(input: z.infer<typeof AddStepSchema>): Promise<CampaignStep> {
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", input.campaignId)
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

export async function listCampaigns(): Promise<Campaign[]> {
  const { data: campaigns, error } = await supabase
    .from("campaigns")
    .select("*")
    .order("createdAt", { ascending: false });
  if (error) throw new Error(error.message);

  const { data: steps } = await supabase.from("campaign_steps").select("*");
  const stepsByCampaign: Record<string, CampaignStep[]> = {};
  for (const step of steps || []) {
    const cid = (step as any).campaignId;
    if (!stepsByCampaign[cid]) stepsByCampaign[cid] = [];
    stepsByCampaign[cid].push(step);
  }

  return (campaigns || []).map((c) => ({
    ...c,
    steps: stepsByCampaign[c.id] || [],
  }));
}
