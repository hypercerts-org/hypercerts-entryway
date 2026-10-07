import type { BrandTokens, TrustedBrandClientIds } from "./branding-types.js";

export const DEFAULT_BRAND: BrandTokens = {
  id: "entryway",
  name: "Entryway",
  page: "#f4f3ef",
  surface: "#ffffff",
  text: "#18332c",
  muted: "#52655c",
  border: "#c8d1cb",
  accent: "#194e3b",
  accentText: "#ffffff",
  focus: "#087a58",
};

const TRUSTED_BRANDS: Readonly<Record<"primary" | "secondary", BrandTokens>> = {
  primary: {
    ...DEFAULT_BRAND,
    id: "hypercerts",
    name: "Hypercerts",
    page: "#f5f6fb",
    text: "#19233d",
    muted: "#59657b",
    accent: "#3757c8",
    focus: "#2844ac",
  },
  secondary: {
    ...DEFAULT_BRAND,
    id: "hypercerts-secondary",
    name: "Hypercerts test client",
    page: "#f1f7f7",
    text: "#193333",
    muted: "#536969",
    accent: "#087e7e",
    focus: "#006767",
  },
};

export function resolveBrand(
  clientId: unknown,
  clients: TrustedBrandClientIds,
): BrandTokens {
  if (typeof clientId !== "string") return DEFAULT_BRAND;
  if (clientId === clients.primary) return TRUSTED_BRANDS.primary;
  if (clientId === clients.secondary) return TRUSTED_BRANDS.secondary;
  return DEFAULT_BRAND;
}
