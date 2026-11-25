export function isServiceReady(input: {
  database: boolean;
  production: boolean;
  aiProviderConfigured: boolean;
  webhookSecurityConfigured: boolean;
}): boolean {
  return input.database && (!input.production || (input.aiProviderConfigured && input.webhookSecurityConfigured));
}
