import { describe, expect, it } from 'vitest';
import { updateProfileSchema, updateSettingsSchema, usernameSchema } from '../src/index.js';

describe('usernameSchema', () => {
  it('normalizes case and whitespace', () => {
    expect(usernameSchema.parse('  Alice.Smith_9 ')).toBe('alice.smith_9');
  });

  it.each([
    ['ab', 'too short'],
    ['a'.repeat(31), 'too long'],
    ['hello world', 'space'],
    ['héllo', 'non-ascii'],
    ['.alice', 'leading dot'],
    ['alice.', 'trailing dot'],
    ['al..ice', 'consecutive dots'],
    ['settings', 'reserved route'],
    ['Admin', 'reserved, any case'],
  ])('rejects %j (%s)', (value) => {
    expect(usernameSchema.safeParse(value).success).toBe(false);
  });
});

describe('updateProfileSchema', () => {
  it('accepts partial updates and clearing the website', () => {
    expect(updateProfileSchema.parse({ bio: 'hi', website: '' })).toEqual({
      bio: 'hi',
      website: '',
    });
  });

  it.each([
    [{}, 'empty update'],
    [{ website: 'javascript:alert(1)' }, 'non-http URL'],
    [{ isAdmin: true }, 'unknown field'],
    [{ bio: 'x'.repeat(161) }, 'bio too long'],
  ] as [unknown, string][])('rejects %j (%s)', (value) => {
    expect(updateProfileSchema.safeParse(value).success).toBe(false);
  });
});

describe('updateSettingsSchema', () => {
  it('rejects unknown policies and non-boolean privacy', () => {
    expect(updateSettingsSchema.safeParse({ messagePolicy: 'nobody' }).success).toBe(false);
    expect(updateSettingsSchema.safeParse({ isPrivate: 'true' }).success).toBe(false);
  });
});
