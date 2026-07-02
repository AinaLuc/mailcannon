import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Contact, Campaign, ScheduleItem, ProviderConfig, SentEmail } from "./types.js";

interface Store {
  contacts: Contact[];
  campaigns: Campaign[];
  schedules: ScheduleItem[];
  providers: ProviderConfig[];
  sentEmails: SentEmail[];
}

const DB_PATH = join(process.cwd(), "data.json");

function load(): Store {
  if (!existsSync(DB_PATH))
    return { contacts: [], campaigns: [], schedules: [], providers: [], sentEmails: [] };
  const store = JSON.parse(readFileSync(DB_PATH, "utf-8"));
  if (!store.sentEmails) {
    store.sentEmails = [];
  }
  return store;
}

function save(store: Store): void {
  writeFileSync(DB_PATH, JSON.stringify(store, null, 2));
}

export const db = {
  load,
  save,
};
