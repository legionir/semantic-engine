/**
 * AuditLogger — Tamper-resistant append-only audit trail for sensitive platform actions.
 */

import * as crypto from 'crypto';

export interface AuditEvent {
  readonly id: string;
  readonly timestamp: number;
  readonly actor: string;
  readonly role?: string;
  readonly action: string;
  readonly targetResource?: string;
  readonly status: 'success' | 'denied' | 'error';
  readonly durationMs?: number;
  readonly ip?: string;
  readonly details?: Record<string, unknown>;
  readonly previousHash: string;
  readonly hash: string;
}

export class AuditLogger {
  private readonly events: AuditEvent[] = [];
  private lastHash: string = '0'.repeat(64);

  record(eventInput: {
    actor: string;
    role?: string;
    action: string;
    targetResource?: string;
    status: 'success' | 'denied' | 'error';
    durationMs?: number;
    ip?: string;
    details?: Record<string, unknown>;
  }): AuditEvent {
    const timestamp = Date.now();
    const id = `audit_${timestamp}_${crypto.randomBytes(4).toString('hex')}`;
    const previousHash = this.lastHash;

    const payloadToHash = JSON.stringify({
      id,
      timestamp,
      actor: eventInput.actor,
      action: eventInput.action,
      targetResource: eventInput.targetResource,
      status: eventInput.status,
      previousHash,
    });

    const hash = crypto.createHash('sha256').update(payloadToHash).digest('hex');
    this.lastHash = hash;

    const fullEvent: AuditEvent = {
      id,
      timestamp,
      actor: eventInput.actor,
      role: eventInput.role,
      action: eventInput.action,
      targetResource: eventInput.targetResource,
      status: eventInput.status,
      durationMs: eventInput.durationMs,
      ip: eventInput.ip,
      details: eventInput.details,
      previousHash,
      hash,
    };

    this.events.push(fullEvent);
    return fullEvent;
  }

  query(filter?: {
    actor?: string;
    action?: string;
    targetResource?: string;
    status?: 'success' | 'denied' | 'error';
    limit?: number;
  }): readonly AuditEvent[] {
    let result = this.events;

    if (filter?.actor) {
      result = result.filter(e => e.actor === filter.actor);
    }
    if (filter?.action) {
      result = result.filter(e => e.action.startsWith(filter.action!));
    }
    if (filter?.targetResource) {
      result = result.filter(e => e.targetResource === filter.targetResource);
    }
    if (filter?.status) {
      result = result.filter(e => e.status === filter.status);
    }

    const limit = filter?.limit || 100;
    return result.slice(-limit).reverse();
  }

  verifyIntegrity(): { valid: boolean; brokenAt?: number } {
    let prev = '0'.repeat(64);
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i]!;
      if (e.previousHash !== prev) {
        return { valid: false, brokenAt: i };
      }
      const payloadToHash = JSON.stringify({
        id: e.id,
        timestamp: e.timestamp,
        actor: e.actor,
        action: e.action,
        targetResource: e.targetResource,
        status: e.status,
        previousHash: e.previousHash,
      });
      const expected = crypto.createHash('sha256').update(payloadToHash).digest('hex');
      if (e.hash !== expected) {
        return { valid: false, brokenAt: i };
      }
      prev = e.hash;
    }
    return { valid: true };
  }
}
