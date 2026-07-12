import { z } from "zod";
import { supabase } from "../supabase.js";
import type { Contact } from "../types.js";

export const AddContactSchema = z.object({
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string().optional(),
  company: z.string().optional(),
  title: z.string().optional(),
});

export const AddContactsSchema = z.object({
  contacts: z.array(AddContactSchema),
});

export const RemoveContactSchema = z.object({
  id: z.string(),
});

export async function addContact(input: z.infer<typeof AddContactSchema>): Promise<Contact> {
  const { data, error } = await supabase
    .from("contacts")
    .insert({
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      company: input.company ?? null,
      title: input.title ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function addContacts(input: z.infer<typeof AddContactsSchema>): Promise<Contact[]> {
  const { data, error } = await supabase
    .from("contacts")
    .insert(input.contacts.map((c) => ({
      email: c.email,
      firstName: c.firstName,
      lastName: c.lastName ?? null,
      company: c.company ?? null,
      title: c.title ?? null,
    })))
    .select();
  if (error) throw new Error(error.message);
  return data || [];
}

export async function listContacts(): Promise<Contact[]> {
  const { data, error } = await supabase.from("contacts").select("*").order("createdAt", { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function removeContact(id: string): Promise<boolean> {
  const { error, count } = await supabase.from("contacts").delete({ count: "exact" }).eq("id", id);
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

export async function unsubscribeContactByEmail(email: string): Promise<boolean> {
  const { error, count } = await supabase
    .from("contacts")
    .update({ unsubscribed: true, unsubscribedAt: new Date().toISOString() })
    .eq("email", email.toLowerCase())
    .gt("unsubscribed", false)
    .select();
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}
