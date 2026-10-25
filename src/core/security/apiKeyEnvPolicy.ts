/**
 * Which environment variables a remote caller may name as "the API key".
 *
 * `embedding.apiKeyEnvVar` / `chat.apiKeyEnvVar` make the server read
 * `process.env[name]` and send it as a bearer key to a configured endpoint. If
 * any variable could be named, a client with config-write access could point
 * that at a host it controls and read `AWS_SECRET_ACCESS_KEY` or similar. Names
 * are therefore limited to provider-style prefixes; operators extend the list
 * with `SEMANTIC_ENGINE_API_KEY_ENV_PREFIXES` (comma separated).
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const DEFAULT_API_KEY_ENV_PREFIXES: readonly string[] = [
  'SEMANTIC_ENGINE_',
  'OPENAI_',
  'AZURE_OPENAI_',
  'ANTHROPIC_',
  'OLLAMA_',
  'OPENROUTER_',
  'GROQ_',
  'MISTRAL_',
  'COHERE_',
  'TOGETHER_',
  'GEMINI_',
  'VOYAGE_',
  'HF_',
];

function prefixes(env: NodeJS.ProcessEnv): readonly string[] {
  const extra = (env['SEMANTIC_ENGINE_API_KEY_ENV_PREFIXES'] ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
  return [...DEFAULT_API_KEY_ENV_PREFIXES, ...extra];
}

/** Returns an error message, or null when `name` is acceptable. */
export function apiKeyEnvVarProblem(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!NAME.test(name)) return 'must be an environment variable name';
  const upper = name.toUpperCase();
  if (!prefixes(env).some(prefix => upper.startsWith(prefix.toUpperCase()))) {
    return (
      `"${name}" is not an allowed API-key variable (allowed prefixes: ${prefixes(env).join(', ')}; ` +
      'extend with SEMANTIC_ENGINE_API_KEY_ENV_PREFIXES)'
    );
  }
  return null;
}
