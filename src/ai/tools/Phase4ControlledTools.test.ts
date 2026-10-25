import { Phase4ProviderStatusTool } from './Phase4ControlledTools';

describe('Phase 4 tools', () => {
  test('provider_status returns explicit availability and is deterministic', async () => {
    const tool = new Phase4ProviderStatusTool();
    const result = await tool.execute({ languages: ['rust', 'python', 'typescript'] });
    expect(result.success).toBe(true);
    expect(result.items.map(item => item.name)).toEqual(['python', 'rust', 'typescript']);
    expect(result.items.find(item => item.name === 'rust')?.metadata).toMatchObject({ status: 'unavailable' });
  });

  test('provider_status rejects empty input', async () => {
    const result = await new Phase4ProviderStatusTool().execute({ languages: [] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('languages');
  });
});
