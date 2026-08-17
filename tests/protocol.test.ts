import { describe, expect, it } from 'vitest';
import {
  MACHINE_WALLET_PROGRAM_ADDRESS,
  MACHINE_WALLET_VAULT_SEED,
  MAX_SLOT_WINDOW,
  SOLANA_SLOT_MS,
  ADD_AUTHORITY_CEREMONY_SLOT_WINDOW,
} from '../src/protocol';

describe('protocol constants', () => {
  it('pins the machine-wallet program id', () => {
    expect(MACHINE_WALLET_PROGRAM_ADDRESS).toBe('SouLi11jcPZGRS1yBfJDxcrDAWHNvJeSwph8pxZWzYw');
  });
  it('pins the vault PDA seed', () => {
    expect(MACHINE_WALLET_VAULT_SEED).toBe('machine_vault');
  });
  it('pins the execute slot window at 150 slots', () => {
    expect(MAX_SLOT_WINDOW).toBe(150n);
  });
  it('pins nominal slot time at 400ms', () => {
    expect(SOLANA_SLOT_MS).toBe(400);
  });
  it('pins the add-authority ceremony window at 1500 slots (Swift AuthorityCeremony.challengeWindowSlots mirror)', () => {
    expect(ADD_AUTHORITY_CEREMONY_SLOT_WINDOW).toBe(1_500n);
  });
});
