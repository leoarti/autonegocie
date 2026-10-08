export const GROUPS = {
  api: [
    'admin-reports',
    'admin-reset-password',
    'charge-links',
    'company-settings',
    'create-admin-user',
    'create-user-admin',
    'export-worker',
    'payment-splits',
    'public-payment-link',
    'public-payment-splits',
    'send-mock-message',
    'subscription-manager',
    'subscription-status',
    'thank-you-summary',
    'update-company-settings',
  ],
  payments: [
    'admin-link-boleto',
    'conclude-card-payment',
    'process-charge',
    'process-payment',
    'quitamais-auth',
    'quitamais-link-search',
    'quitamais-payment-link',
    'quitaplus-link-boleto',
    'quitaplus-prepayment',
    'quitaplus-prepayment-status',
    'quitaplus-prepayment-test',
    'quitaplus-proxy',
    'quitaplus-simulation',
    'quitaplus-token',
  ],
  webhooks: [
    'mercadopago-pix-create',
    'mercadopago-pix-status',
    'mercadopago-webhook',
    'treeal-pix-create',
    'treeal-pix-status',
    'treeal-webhook',
  ],
  jobs: [
    'recurrences-manager',
    'recurring-charges-cron',
    'refunds-scheduler',
    'sync-card-status',
    'sync-mercadopago-status',
    'sync-payment-status',
    'sync-treeal-status',
  ],
} as const;

export type GroupName = keyof typeof GROUPS;

export const GROUP_NAMES = new Set<string>(Object.keys(GROUPS));

const routeGroup = new Map<string, GroupName>();
for (const [group, names] of Object.entries(GROUPS) as [GroupName, readonly string[]][]) {
  for (const name of names) routeGroup.set(name, group);
}
routeGroup.set('export-file', 'api');

export function groupOf(route: string): GroupName | undefined {
  return routeGroup.get(route.split('/')[0]);
}
