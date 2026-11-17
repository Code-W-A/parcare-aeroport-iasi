export const BUCHAREST_COUNTY = 'București';

export const ROMANIAN_COUNTIES = [
  'Alba',
  'Arad',
  'Argeș',
  'Bacău',
  'Bihor',
  'Bistrița-Năsud',
  'Botoșani',
  'Brăila',
  'Brașov',
  BUCHAREST_COUNTY,
  'Buzău',
  'Caraș-Severin',
  'Călărași',
  'Cluj',
  'Constanța',
  'Covasna',
  'Dâmbovița',
  'Dolj',
  'Galați',
  'Giurgiu',
  'Gorj',
  'Harghita',
  'Hunedoara',
  'Ialomița',
  'Iași',
  'Ilfov',
  'Maramureș',
  'Mehedinți',
  'Mureș',
  'Neamț',
  'Olt',
  'Prahova',
  'Satu Mare',
  'Sălaj',
  'Sibiu',
  'Suceava',
  'Teleorman',
  'Timiș',
  'Tulcea',
  'Vaslui',
  'Vâlcea',
  'Vrancea',
] as const;

export const BUCHAREST_SECTORS = [
  'Sector 1',
  'Sector 2',
  'Sector 3',
  'Sector 4',
  'Sector 5',
  'Sector 6',
] as const;

export type RomanianCounty = (typeof ROMANIAN_COUNTIES)[number];
export type BucharestSector = (typeof BUCHAREST_SECTORS)[number];

function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '');
}

export function normalizeLocationKey(value: string): string {
  return stripDiacritics(value.trim().toLowerCase()).replace(/\s+/g, ' ');
}

export function isBucharestCounty(county: string): boolean {
  const key = normalizeLocationKey(county);
  return (
    key === 'bucuresti' ||
    key === 'municipiul bucuresti' ||
    key === 'bucuresti sector' ||
    key.startsWith('bucuresti ')
  );
}

export function normalizeCounty(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (isBucharestCounty(trimmed)) {
    return BUCHAREST_COUNTY;
  }

  const key = normalizeLocationKey(trimmed);
  const match = ROMANIAN_COUNTIES.find(
    (county) => normalizeLocationKey(county) === key
  );
  return match ?? null;
}

export function isValidCounty(value: string): boolean {
  return normalizeCounty(value) !== null;
}

export function isValidBucharestSector(value: string): boolean {
  const key = normalizeLocationKey(value);
  return BUCHAREST_SECTORS.some((sector) => normalizeLocationKey(sector) === key);
}

export function normalizeBucharestSector(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const key = normalizeLocationKey(trimmed);
  const match = BUCHAREST_SECTORS.find(
    (sector) => normalizeLocationKey(sector) === key
  );
  return match ?? null;
}

export function countyOptions() {
  return ROMANIAN_COUNTIES.map((county) => ({
    id: county,
    label: county,
  }));
}

export function sectorOptions() {
  return BUCHAREST_SECTORS.map((sector) => ({
    id: sector,
    label: sector,
  }));
}
