import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { CITY_IDS, TREATMENT_IDS, type CityId, type TreatmentId } from "@/types/domain";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// Runtime guards shared by the server routes and the client (pure, no IO).

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True for an allowlisted city id (see CITY_IDS). */
export function isCityId(v: unknown): v is CityId {
  return typeof v === "string" && (CITY_IDS as readonly string[]).includes(v);
}

/** True for an allowlisted treatment id (see TREATMENT_IDS). */
export function isTreatmentId(v: unknown): v is TreatmentId {
  return typeof v === "string" && (TREATMENT_IDS as readonly string[]).includes(v);
}
