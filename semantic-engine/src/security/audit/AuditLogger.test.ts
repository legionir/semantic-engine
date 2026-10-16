import { AuditLogger } from './AuditLogger';

describe('AuditLogger (V2 Immutable Audit Trail)', () => {
  it('appends and links cryptographic hashes of audit events', () => {
    const logger = new AuditLogger();

    const ev1 = logger.record({
      actor: 'user_admin',
      action: 'auth.key.created',
      targetResource: 'key_123',
      status: 'success',
    });

    const ev2 = logger.record({
      actor: 'agent_42',
      action: 'semantic.context',
      targetResource: 'project_alpha',
      status: 'success',
      durationMs: 45,
    });

    expect(ev1.previousHash).toBe('0'.repeat(64));
    expect(ev2.previousHash).toBe(ev1.hash);

    const check = logger.verifyIntegrity();
    expect(check.valid).toBe(true);
  });

  it('queries audit logs with filters', () => {
    const logger = new AuditLogger();
    logger.record({ actor: 'admin', action: 'config.update', status: 'success' });
    logger.record({ actor: 'agent', action: 'semantic.query', status: 'success' });
    logger.record({ actor: 'agent', action: 'semantic.context', status: 'denied' });

    const agentEvents = logger.query({ actor: 'agent' });
    expect(agentEvents.length).toBe(2);

    const denied = logger.query({ status: 'denied' });
    expect(denied.length).toBe(1);
    expect(denied[0]?.actor).toBe('agent');
  });
});
