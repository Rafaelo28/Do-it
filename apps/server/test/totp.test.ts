import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateRecoveryCodes, totpAt, verifyTotp } from '../src/totp';

describe('TOTP', () => {
  it('stimmt mit den Testwerten aus RFC 6238 überein', () => {
    // RFC 6238 Anhang B, SHA-1, Schlüssel "12345678901234567890"
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpAt(secret, Math.floor(2000000000 / 30))).toBe('279037');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });

  it('akzeptiert ±1 Fenster und verhindert Wiederverwendung', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30000);
    expect(verifyTotp(secret, totpAt(secret, step), null, now)).toBe(step);
    expect(verifyTotp(secret, totpAt(secret, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(secret, step - 2), null, now)).toBeNull();
    expect(verifyTotp(secret, totpAt(secret, step), step, now)).toBeNull();
    expect(verifyTotp(secret, '12345', null, now)).toBeNull();
  });

  it('erzeugt eindeutige Wiederherstellungscodes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    expect(codes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
  });
});
