// Homebase vault: encrypts private text (the journal) on this device before it is saved online.
// The passphrase never leaves the device; without it the saved entries cannot be read, by anyone.
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const newSalt = () => b64(crypto.getRandomValues(new Uint8Array(16)));

// Turns a passphrase into a key (PBKDF2, SHA-256, 250,000 rounds) and returns it as text to keep on this device.
export async function keyFromPassphrase(passphrase, salt) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: bytes(salt), iterations: 250000, hash: "SHA-256" }, base, 256);
  return b64(bits);
}
const aes = (keyText) => crypto.subtle.importKey("raw", bytes(keyText), "AES-GCM", false, ["encrypt", "decrypt"]);
export async function seal(keyText, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aes(keyText), enc.encode(JSON.stringify(value)));
  return { iv: b64(iv), data: b64(data) };
}
// Throws if the key is wrong or the data was altered.
export async function open(keyText, box) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(box.iv) }, await aes(keyText), bytes(box.data));
  return JSON.parse(dec.decode(plain));
}
