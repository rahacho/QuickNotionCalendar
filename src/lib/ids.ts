const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 20;
/** Largest multiple of 62 that fits in a byte; bytes >= this are rejected to avoid modulo bias. */
const MAX_UNBIASED = 256 - (256 % ALPHABET.length);

/** 20-char Firestore-safe id (same alphabet/length as Firestore auto ids), crypto-random, unbiased. */
export function newId(): string {
  let id = '';
  const buf = new Uint8Array(40);
  while (id.length < ID_LENGTH) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && id.length < ID_LENGTH; i++) {
      const b = buf[i]!;
      if (b < MAX_UNBIASED) id += ALPHABET[b % ALPHABET.length];
    }
  }
  return id;
}
