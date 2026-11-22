import { getSecret, setSecret } from "../secrets/store";
import { LINE_SERVICE } from "./config";

/**
 * The user profile used as Open WebUI template variables in every LINE reply.
 * Stored encrypted for the bot owner (service "line", name "user_profile") and entered through
 * the line_set_user_profile form, so the values never pass through the model.
 */

export const PROFILE_NAME = "user_profile";
export const DEFAULT_TIMEZONE = "Asia/Taipei";
const NOT_PROVIDED = "Not provided";

export type UserProfile = {
  timezone: string;
  language: string;
  bio: string;
  gender: string;
  birthDate: string;
  location: string;
  groups: string;
};

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validates form input and returns a clean profile. Throws a readable error on bad input. */
export function parseProfile(input: Record<string, unknown>): UserProfile {
  const text = (key: string, max: number): string => {
    const value = input[key];
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw new Error(`"${key}" must be text`);
    const trimmed = value.trim();
    if (trimmed.length > max) throw new Error(`"${key}" must be at most ${max} characters`);
    return trimmed;
  };

  const timezone = text("timezone", 64) || DEFAULT_TIMEZONE;
  if (!isValidTimezone(timezone)) throw new Error('"timezone" must be an IANA name such as Asia/Taipei');

  const birthDate = text("birth_date", 10);
  if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) throw new Error('"birth_date" must be YYYY-MM-DD');
  if (birthDate && Number.isNaN(Date.parse(birthDate))) throw new Error('"birth_date" is not a real date');

  return {
    timezone,
    language: text("language", 35),
    bio: text("bio", 500),
    gender: text("gender", 40),
    birthDate,
    location: text("location", 100),
    groups: text("groups", 200),
  };
}

export async function readUserProfile(owner: string): Promise<UserProfile | null> {
  const raw = await getSecret(owner, LINE_SERVICE, PROFILE_NAME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserProfile;
  } catch {
    return null;
  }
}

export function writeUserProfile(owner: string, profile: UserProfile): Promise<void> {
  return setSecret(owner, LINE_SERVICE, PROFILE_NAME, JSON.stringify(profile));
}

type DateParts = { year: number; month: number; day: number; hh: string; mm: string; ss: string; weekday: string };

function partsIn(timeZone: string, date: Date): DateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "long",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hh: get("hour"),
    mm: get("minute"),
    ss: get("second"),
    weekday: get("weekday"),
  };
}

/** Whole years between the birth date and the given calendar day. */
function ageOn(birthDate: string, today: { year: number; month: number; day: number }): number {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  let age = today.year - by;
  if (today.month < bm || (today.month === bm && today.day < bd)) age -= 1;
  return age;
}

/**
 * Template variables for Open WebUI. Missing profile fields become "Not provided".
 * Date and time are the current moment in the profile's timezone.
 */
export function buildVariables(profile: UserProfile | null, now: Date = new Date()): Record<string, string> {
  const timezone = profile?.timezone || DEFAULT_TIMEZONE;
  const p = partsIn(timezone, now);
  const month = String(p.month).padStart(2, "0");
  const day = String(p.day).padStart(2, "0");
  const or = (value?: string) => (value && value.trim() ? value : NOT_PROVIDED);

  return {
    "{{CURRENT_TIMEZONE}}": timezone,
    "{{USER_BIO}}": or(profile?.bio),
    "{{USER_GENDER}}": or(profile?.gender),
    "{{USER_BIRTH_DATE}}": or(profile?.birthDate),
    "{{USER_AGE}}": profile?.birthDate ? String(ageOn(profile.birthDate, p)) : NOT_PROVIDED,
    "{{USER_LANGUAGE}}": or(profile?.language),
    "{{USER_LOCATION}}": or(profile?.location),
    "{{USER_GROUPS}}": or(profile?.groups),
    "{{CURRENT_DATETIME}}": `${p.year}-${month}-${day} ${p.hh}:${p.mm}:${p.ss}`,
    "{{CURRENT_WEEKDAY}}": p.weekday,
  };
}
