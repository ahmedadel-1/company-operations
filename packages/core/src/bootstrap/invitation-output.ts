import { writeFileSync } from 'node:fs';

export class InvitationOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvitationOutputError';
  }
}

export type InvitationOutput = { readonly kind: 'terminal' } | { readonly kind: 'file'; readonly path: string };

export interface InvitationOutputInput {
  /** `process.stdout.isTTY`: a person is watching the terminal, not a log collector. */
  readonly interactive: boolean;
  /** `CI` is set: output is captured and kept by the CI system. */
  readonly ci: boolean;
  readonly printFlag: boolean;
  readonly file: string | undefined;
}

/**
 * Where the single-use invitation link may go, decided before anything is created. The link is a
 * bearer secret: it is printed only to an interactive terminal or on explicit request outside CI,
 * or written to a new file readable by the owner only. It never goes to a log.
 */
export function chooseInvitationOutput(input: InvitationOutputInput): InvitationOutput {
  if (input.file !== undefined) {
    if (input.file.trim() === '') throw new InvitationOutputError('--invitation-file needs a path.');
    return { kind: 'file', path: input.file };
  }
  if (input.interactive) return { kind: 'terminal' };
  if (input.printFlag && !input.ci) return { kind: 'terminal' };
  throw new InvitationOutputError(
    input.ci
      ? 'CI output is retained, so the invitation link is never printed there. Pass --invitation-file <path>.'
      : 'Standard output is not a terminal, so the invitation link would end up in captured output. Run the command in an interactive terminal, pass --invitation-file <path>, or pass --print-invitation to print it anyway.',
  );
}

/** Writes the link to a file that must not exist yet, readable and writable by the owner only. */
export function writeInvitationFile(path: string, link: string): void {
  writeFileSync(path, `${link}\n`, { mode: 0o600, flag: 'wx' });
}
