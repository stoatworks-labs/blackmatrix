import { describe, expect, it } from 'vitest';
import { claimedReason, ownerName } from '../claims';
import type { DeviceView } from '../types';

function deviceWith(locks: Record<string, string | null>): DeviceView {
  return {
    id: 'stage',
    name: 'Stage',
    address: '10.0.0.5',
    model: 'Simulated 1 M/E switcher',
    connection: 'connected',
    videohubPort: null,
    videohubClients: 0,
    matrix: {
      destinations: [{ id: 'aux.0', kind: 'aux', section: 'aux', label: 'Aux 1', short: 'AUX1', address: { unit: 0 } }],
      sources: [],
      routes: {},
      sections: [],
    } as unknown as DeviceView['matrix'],
    locks,
  };
}

describe('claimedReason', () => {
  it('says nothing about an unclaimed destination', () => {
    expect(claimedReason(deviceWith({ 'aux.0': null }), 'aux.0')).toBeNull();
  });

  it('refuses a claim this browser owns, by its label', () => {
    // The one that mattered: the owner is the address this browser is at, so a
    // rule that only stopped other clients would never stop the operator who
    // pressed the button.
    const reason = claimedReason(deviceWith({ 'aux.0': '127.0.0.1' }), 'aux.0');
    expect(reason).toContain('Aux 1');
    expect(reason).toMatch(/release it/i);
  });

  it('names whoever holds a claim made elsewhere', () => {
    expect(claimedReason(deviceWith({ 'aux.0': '10.0.0.44' }), 'aux.0')).toContain('10.0.0.44');
  });

  it('calls this client by name when the claim is its own', () => {
    // "Claimed by 127.0.0.1" is read by the person at 127.0.0.1 more often than
    // by anybody else, and reads like a stranger holding their own row.
    const reason = claimedReason(deviceWith({ 'aux.0': '127.0.0.1' }), 'aux.0', '127.0.0.1');
    expect(reason).toContain('claimed by you');
    expect(reason).not.toContain('127.0.0.1');
  });

  it('leaves the address alone when it does not know its own', () => {
    expect(ownerName('127.0.0.1', null)).toBe('127.0.0.1');
    expect(ownerName('10.0.0.44', '127.0.0.1')).toBe('10.0.0.44');
  });
});
