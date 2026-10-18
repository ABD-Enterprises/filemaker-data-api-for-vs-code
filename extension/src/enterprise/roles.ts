/** The enterprise roles from least to most privileged. A workspace may only move down this order. */
export const ROLE_RANK: Record<'viewer' | 'developer' | 'admin', number> = { viewer: 0, developer: 1, admin: 2 };

export function isRoleName(value: unknown): value is keyof typeof ROLE_RANK {
  return value === 'viewer' || value === 'developer' || value === 'admin';
}
