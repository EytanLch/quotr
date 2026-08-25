// src/crypto.ts
// AES-256-GCM encryption for seller API keys.
// The encryption key lives ONLY in env vars — never in the database.
// Even a full DB dump is useless without ENCRYPTION_KEY.

const ALGORITHM = 'AES-GCM'
const KEY_LENGTH = 256

/**
 * Derive a CryptoKey from the ENCRYPTION_KEY environment variable.
 * The env var should be a 64-character hex string (32 bytes).
 * Generate one with: openssl rand -hex 32
 */
async function getEncryptionKey(): Promise<CryptoKey> {
  const hexKey = process.env.ENCRYPTION_KEY
  if (!hexKey || hexKey.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-char hex string. Generate: openssl rand -hex 32')
  }

  const keyBytes = new Uint8Array(
    hexKey.match(/.{2}/g)!.map(b => parseInt(b, 16))
  )

  return crypto.subtle.importKey(
    'raw', keyBytes,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Encrypt a plaintext string (e.g. Anthropic API key).
 * Returns a single string: base64(iv):base64(authTag):base64(ciphertext)
 * Store this string in the database.
 */
export async function encryptKey(plaintext: string): Promise<string> {
  const key  = await getEncryptionKey()
  const iv   = crypto.getRandomValues(new Uint8Array(12))  // 96-bit IV for GCM
  const data = new TextEncoder().encode(plaintext)

  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    data
  )

  // GCM appends the 16-byte auth tag to the ciphertext
  const ciphertext = new Uint8Array(encrypted, 0, encrypted.byteLength - 16)
  const authTag    = new Uint8Array(encrypted, encrypted.byteLength - 16)

  const toB64 = (buf: Uint8Array) => btoa(String.fromCharCode(...buf))

  return `${toB64(iv)}:${toB64(authTag)}:${toB64(ciphertext)}`
}

/**
 * Decrypt a stored encrypted key string back to plaintext.
 */
export async function decryptKey(stored: string): Promise<string> {
  const key = await getEncryptionKey()

  const parts = stored.split(':')
  if (parts.length !== 3) throw new Error('Invalid encrypted key format')

  const fromB64 = (b64: string) =>
    new Uint8Array(atob(b64).split('').map(c => c.charCodeAt(0)))

  const iv         = fromB64(parts[0])
  const authTag    = fromB64(parts[1])
  const ciphertext = fromB64(parts[2])

  // GCM expects ciphertext + authTag concatenated
  const combined = new Uint8Array(ciphertext.length + authTag.length)
  combined.set(ciphertext)
  combined.set(authTag, ciphertext.length)

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    key,
    combined
  )

  return new TextDecoder().decode(decrypted)
}

/**
 * Generate a display hint from a key (last 4 chars).
 * Safe to store in plaintext — reveals nothing useful.
 */
export function keyHint(rawKey: string): string {
  return '...' + rawKey.slice(-4)
}
