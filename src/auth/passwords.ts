import bcrypt from 'bcryptjs'

// PASSWORDS — HASHED, NEVER STORED, NEVER LOGGED.
//
// bcrypt with a per-password salt and a work factor that costs about a tenth
// of a second. That slowness is the point: it is what makes a stolen table of
// hashes expensive to attack, and a tenth of a second is invisible on a
// sign-in that already crosses a network.
//
// Nothing here returns, logs or compares a plaintext password, except the one
// comparison bcrypt performs itself, in constant time.

const COST = 12

/** What a password must be, in words a person can act on. */
export const PASSWORD_RULE = 'At least 10 characters, including a letter and a number.'

export function passwordProblem(password: string): string | null {
  const p = String(password ?? '')
  if (p.length < 10) return `That password is too short. ${PASSWORD_RULE}`
  if (p.length > 200) return 'That password is too long (200 characters at most).'
  if (!/[a-z]/i.test(p)) return `That password has no letter in it. ${PASSWORD_RULE}`
  if (!/[0-9]/.test(p)) return `That password has no number in it. ${PASSWORD_RULE}`
  return null
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST)
}

/**
 * Checks a password against a stored hash.
 *
 * A null hash means the account has no password — it was created by signing in
 * with Google. That answers false rather than throwing, so the caller says the
 * same thing it says for a wrong password and nothing about the account is
 * revealed by which error came back.
 */
export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  if (!hash) return false
  try {
    return await bcrypt.compare(password, hash)
  } catch {
    return false
  }
}
