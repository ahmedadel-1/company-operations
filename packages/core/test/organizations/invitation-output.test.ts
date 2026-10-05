import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  chooseInvitationOutput,
  InvitationOutputError,
  writeInvitationFile,
} from '../../src/bootstrap/invitation-output.js';

const base = { interactive: false, ci: false, printFlag: false, file: undefined };

describe('bootstrap invitation output', () => {
  it('prints to an interactive terminal', () => {
    expect(chooseInvitationOutput({ ...base, interactive: true })).toEqual({ kind: 'terminal' });
  });

  it('refuses captured output unless the operator asks for it, and never prints in CI', () => {
    expect(() => chooseInvitationOutput(base)).toThrow(InvitationOutputError);
    expect(chooseInvitationOutput({ ...base, printFlag: true })).toEqual({ kind: 'terminal' });
    expect(() => chooseInvitationOutput({ ...base, ci: true, printFlag: true })).toThrow(/CI output is retained/);
  });

  it('writes a new owner-only file and never overwrites one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-invite-'));
    try {
      const path = join(dir, 'invite.txt');
      expect(chooseInvitationOutput({ ...base, ci: true, file: path })).toEqual({ kind: 'file', path });
      writeInvitationFile(path, 'https://ops.example.com/api/v1/auth/login?invitation=t');
      expect(readFileSync(path, 'utf8')).toBe('https://ops.example.com/api/v1/auth/login?invitation=t\n');
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
      expect(() => {
        writeInvitationFile(path, 'other');
      }).toThrow();
      expect(() => chooseInvitationOutput({ ...base, file: ' ' })).toThrow(InvitationOutputError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
