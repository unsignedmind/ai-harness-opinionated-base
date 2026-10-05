// Types of devices.js for the spec-ui dev server (TypeScript), which shares the device store.
export const CODE_TTL_MS: number;
export const PENDING_TTL_MS: number;
export const IDLE_MS: number;

export type Device = {
  id: string;
  name: string;
  status: 'pending' | 'active';
  approved: boolean;
  confirm?: string;
  ip: string | null;
  createdAt: number;
  lastSeen: number | null;
};

export type Claim =
  | { status: 'gone' }
  | { status: 'pending'; confirm: string; name: string }
  | { status: 'approved'; cookie: string; id: string; name: string };

export type DeviceStore = {
  file: string;
  createCode(ttlMs?: number): { code: string; expiresAt: number };
  redeem(code: string, info?: { userAgent?: string; ip?: string | null }): { id: string; poll: string; confirm: string } | null;
  claim(id: string, poll: string): Claim;
  verify(cookie: string | null | undefined): Device | null;
  list(): Device[];
  approve(id: string): boolean;
  revoke(id: string): boolean;
  revokeAll(): number;
  rename(id: string, name: string): boolean;
};

export function deviceName(userAgent?: string): string;
export function createDeviceStore(opts: { dir: string; now?: () => number }): DeviceStore;
export function audit(dir: string, entry: { device?: string; action: string; key?: string; detail?: string }): void;
