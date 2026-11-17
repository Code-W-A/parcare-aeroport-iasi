import {
  isBucharestCounty,
  isValidBucharestSector,
  isValidCounty,
} from "./romaniaLocations";
export type BillingDetails = {
  billingType: "individual" | "company";
  address: string;
  country: string;
  county: string;
  city: string;
  postalCode: string;
  company: string;
  companyVAT: string;
  companyReg: string;
  companyAddress: string;
};
export type CustomerDetails = BillingDetails & {
  firstName: string;
  lastName: string;
  email: string;
  numberOfPersons: number;
  carModel: string;
  carType: string;
  orderNotes: string;
};
export const detailFields = [
  ["firstName", "Prenume", "contact", 100],
  ["lastName", "Nume", "contact", 100],
  ["email", "Email", "contact", 254],
  ["carModel", "Model mașină", "transfer", 100],
  ["carType", "Tip mașină", "transfer", 100],
  ["address", "Adresă", "billing", 300],
  ["country", "Țară", "billing", 100],
  ["county", "Județ", "billing", 100],
  ["city", "Localitate / sector", "billing", 100],
  ["company", "Denumire firmă", "company", 200],
  ["companyVAT", "CUI / CIF", "company", 50],
  ["companyReg", "Registrul Comerțului", "company", 100],
  ["companyAddress", "Adresă firmă", "company", 300],
  ["orderNotes", "Observații", "notes", 1000],
] as const;
export type DetailField = (typeof detailFields)[number][0] | "numberOfPersons";
export function emptyDetails(
  name = "",
  email = "",
  billing?: BillingDetails | null,
): CustomerDetails {
  const [firstName = "", ...rest] = name.trim().split(/\s+/);
  return {
    firstName,
    lastName: rest.join(" "),
    email,
    numberOfPersons: 1,
    carModel: "",
    carType: "",
    billingType: "individual",
    address: "",
    country: "România",
    county: "",
    city: "",
    postalCode: "",
    company: "",
    companyVAT: "",
    companyReg: "",
    companyAddress: "",
    orderNotes: "",
    ...billing,
  };
}
export function detailErrors(
  d: CustomerDetails,
): Partial<Record<DetailField, string>> {
  const errors: Partial<Record<DetailField, string>> = {};
  for (const [key, label, section, max] of detailFields) {
    if (section === "company" && d.billingType !== "company") continue;
    if (key !== "orderNotes" && !d[key]?.trim())
      errors[key] = `Completează ${label.toLowerCase()}.`;
    else if ((d[key]?.length || 0) > max)
      errors[key] = `Maximum ${max} caractere.`;
  }
  if (`${d.firstName} ${d.lastName}`.trim().length > 100)
    errors.firstName = "Numele complet poate avea maximum 100 de caractere.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email))
    errors.email = "Introdu un email valid.";
  if (!Number.isSafeInteger(d.numberOfPersons) || d.numberOfPersons < 1)
    errors.numberOfPersons = "Introdu un număr întreg pozitiv.";
  if (!isValidCounty(d.county)) errors.county = "Selectează un județ valid.";
  if (isBucharestCounty(d.county) && !isValidBucharestSector(d.city))
    errors.city = "Selectează un sector valid din București.";
  return errors;
}
export function cleanDetails(d: CustomerDetails): CustomerDetails {
  const result = { ...d };
  for (const [key] of detailFields) result[key] = d[key].trim();
  result.email = result.email.toLowerCase();
  if (d.billingType !== "company")
    Object.assign(result, {
      company: "",
      companyVAT: "",
      companyReg: "",
      companyAddress: "",
    });
  return result;
}
export function billingOnly(d: CustomerDetails): BillingDetails {
  const {
    billingType,
    address,
    country,
    county,
    city,
    postalCode,
    company,
    companyVAT,
    companyReg,
    companyAddress,
  } = cleanDetails(d);
  return {
    billingType,
    address,
    country,
    county,
    city,
    postalCode,
    company,
    companyVAT,
    companyReg,
    companyAddress,
  };
}
