import { z } from "zod";
import crypto from "node:crypto";
import { db } from "../db.js";
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

export function addContact(input: z.infer<typeof AddContactSchema>): Contact {
  const store = db.load();
  const contact: Contact = {
    id: crypto.randomUUID(),
    ...input,
    createdAt: new Date().toISOString(),
  };
  store.contacts.push(contact);
  db.save(store);
  return contact;
}

export function addContacts(input: z.infer<typeof AddContactsSchema>): Contact[] {
  const store = db.load();
  const contacts: Contact[] = input.contacts.map((c) => ({
    id: crypto.randomUUID(),
    ...c,
    createdAt: new Date().toISOString(),
  }));
  store.contacts.push(...contacts);
  db.save(store);
  return contacts;
}

export function listContacts(): Contact[] {
  return db.load().contacts;
}

export function removeContact(id: string): boolean {
  const store = db.load();
  const len = store.contacts.length;
  store.contacts = store.contacts.filter((c) => c.id !== id);
  db.save(store);
  return store.contacts.length < len;
}
