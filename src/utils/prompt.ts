export function requireSystemPrompt(name: string, prompt: string | undefined): string {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error(`Config error: ${name} is missing a non-empty "prompt" field`)
  }
  return prompt
}
