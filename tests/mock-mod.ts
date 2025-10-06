export function createOpenAI(_opts: any) {
  return (modelName: string) => `mock:${modelName}`;
}

export default { createOpenAI };
