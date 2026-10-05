export type BrandId = "entryway" | "hypercerts" | "hypercerts-secondary";

export interface BrandTokens {
  id: BrandId;
  name: string;
  page: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  accentText: string;
  focus: string;
}

export interface TrustedBrandClientIds {
  primary: string;
  secondary: string;
}

export interface PagePolicy {
  formOrigin?: string;
  scriptNonce?: string;
}
