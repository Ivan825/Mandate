// Money is stored as integers in each currency's minor unit. Most currencies
// have two decimals; a few have none (yen, won) or three (dinars). Every
// conversion between what a person types and what is stored goes through
// here so a ¥1,000 mandate is 1000, not 100000.

export const CURRENCIES: { code: string; name: string }[] = [
  { code: "USD", name: "US dollar" }, { code: "EUR", name: "Euro" }, { code: "GBP", name: "Pound sterling" }, { code: "INR", name: "Indian rupee" },
  { code: "JPY", name: "Japanese yen" }, { code: "CNY", name: "Chinese yuan" }, { code: "AUD", name: "Australian dollar" }, { code: "CAD", name: "Canadian dollar" },
  { code: "SGD", name: "Singapore dollar" }, { code: "AED", name: "UAE dirham" }, { code: "CHF", name: "Swiss franc" }, { code: "SEK", name: "Swedish krona" },
  { code: "NOK", name: "Norwegian krone" }, { code: "DKK", name: "Danish krone" }, { code: "PLN", name: "Polish złoty" }, { code: "CZK", name: "Czech koruna" },
  { code: "HKD", name: "Hong Kong dollar" }, { code: "NZD", name: "New Zealand dollar" }, { code: "KRW", name: "South Korean won" }, { code: "BRL", name: "Brazilian real" },
  { code: "MXN", name: "Mexican peso" }, { code: "ZAR", name: "South African rand" }, { code: "TRY", name: "Turkish lira" }, { code: "IDR", name: "Indonesian rupiah" },
  { code: "PHP", name: "Philippine peso" }, { code: "MYR", name: "Malaysian ringgit" }, { code: "THB", name: "Thai baht" }, { code: "VND", name: "Vietnamese đồng" },
  { code: "SAR", name: "Saudi riyal" }, { code: "KWD", name: "Kuwaiti dinar" }, { code: "BHD", name: "Bahraini dinar" }, { code: "NGN", name: "Nigerian naira" },
  { code: "KES", name: "Kenyan shilling" }, { code: "ILS", name: "Israeli new shekel" }, { code: "EGP", name: "Egyptian pound" }, { code: "PKR", name: "Pakistani rupee" },
  { code: "BDT", name: "Bangladeshi taka" }, { code: "LKR", name: "Sri Lankan rupee" },
];

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XAF", "XOF", "PYG", "RWF", "GNF", "KMF", "DJF", "BIF", "VUV", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function minorUnits(currency: string): number {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

export function unitFactor(currency: string): number { return 10 ** minorUnits(currency); }

export function toMinor(major: number, currency: string): number { return Math.round(major * unitFactor(currency)); }
export function toMajor(minor: number, currency: string): number { return minor / unitFactor(currency); }

// The step attribute for an amount input: 0.01, 1 or 0.001.
export function inputStep(currency: string): string { const d = minorUnits(currency); return d === 0 ? "1" : (1 / 10 ** d).toFixed(d); }

// Locale by currency so ₹1,00,000 groups the Indian way and ¥ has no decimals.
const LOCALE: Record<string, string> = { INR: "en-IN", GBP: "en-GB", EUR: "de-DE", JPY: "ja-JP", CNY: "zh-CN", KRW: "ko-KR", BRL: "pt-BR", MXN: "es-MX", CHF: "de-CH", SEK: "sv-SE", NOK: "nb-NO", DKK: "da-DK", PLN: "pl-PL", CZK: "cs-CZ", TRY: "tr-TR", IDR: "id-ID", VND: "vi-VN", THB: "th-TH", ZAR: "en-ZA", AUD: "en-AU", CAD: "en-CA", NZD: "en-NZ", SGD: "en-SG", HKD: "en-HK", AED: "en-AE", SAR: "ar-SA", ILS: "he-IL", EGP: "ar-EG", PKR: "en-PK", BDT: "bn-BD", LKR: "si-LK", NGN: "en-NG", KES: "en-KE", KWD: "ar-KW", BHD: "ar-BH", PHP: "en-PH", MYR: "ms-MY" };

export function fmt(minor: number, currency: string): string {
  const d = minorUnits(currency);
  const major = minor / 10 ** d;
  try {
    return new Intl.NumberFormat(LOCALE[currency.toUpperCase()] ?? "en-US", { style: "currency", currency, minimumFractionDigits: d, maximumFractionDigits: d }).format(major);
  } catch {
    return `${currency} ${major.toFixed(d)}`;
  }
}

export function isCurrencyCode(s: string): boolean { return /^[A-Z]{3}$/.test(s); }
