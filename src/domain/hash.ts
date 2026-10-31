import { sha256 } from '@noble/hashes/sha256';
import { canonicalJson } from './canonical';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function sha256Hex(input: string): string {
  return toHex(sha256(new TextEncoder().encode(input)));
}

export function sha256Json(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
