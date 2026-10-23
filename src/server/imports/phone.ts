import { getCountries, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";

const supportedCountries = new Set<string>(getCountries());

export type PhoneNormalization =
  | { ok: true; e164: string }
  | { ok: false; code: "missing_phone" | "country_code_required" | "invalid_phone"; message: string };

/** No country is inferred. A national number needs an explicitly selected country. */
export function normalizeContactPhone(raw: string, defaultCountry?: string): PhoneNormalization {
  const value = raw.normalize("NFKC").trim();
  if (!value) return { ok: false, code: "missing_phone", message: "Phone number is empty." };
  if (value.length > 100) return { ok: false, code: "invalid_phone", message: "Phone number is too long." };

  const country = defaultCountry?.trim().toUpperCase();
  if (country && !supportedCountries.has(country)) {
    return { ok: false, code: "invalid_phone", message: "The selected default country is invalid." };
  }
  if (!value.startsWith("+") && !country) {
    return {
      ok: false,
      code: "country_code_required",
      message: "Include a + country code or explicitly select a default country.",
    };
  }

  const parsed = parsePhoneNumberFromString(value, {
    ...(country ? { defaultCountry: country as CountryCode } : {}),
    extract: false,
  });
  if (!parsed || !parsed.isValid() || parsed.ext || !/^\+[1-9]\d{7,14}$/.test(parsed.number)) {
    return { ok: false, code: "invalid_phone", message: "Phone number is not valid for its country." };
  }
  return { ok: true, e164: parsed.number };
}
