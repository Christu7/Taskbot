declare module "mammoth" {
  function extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
}
