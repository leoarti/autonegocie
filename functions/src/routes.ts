import type { Handler } from './http';
import { handler as adminLinkBoleto } from './routes/admin-link-boleto';
import { handler as adminReports } from './routes/admin-reports';
import { handler as adminResetPassword } from './routes/admin-reset-password';
import { handler as chargeLinks } from './routes/charge-links';
import { handler as companySettings } from './routes/company-settings';
import { handler as concludeCardPayment } from './routes/conclude-card-payment';
import { handler as createAdminUser } from './routes/create-admin-user';
import { handler as createUserAdmin } from './routes/create-user-admin';
import { handler as exportWorker } from './routes/export-worker';
import { handler as mercadopagoPixCreate } from './routes/mercadopago-pix-create';
import { handler as mercadopagoPixStatus } from './routes/mercadopago-pix-status';
import { handler as mercadopagoWebhook } from './routes/mercadopago-webhook';
import { handler as paymentSplits } from './routes/payment-splits';
import { handler as processCharge } from './routes/process-charge';
import { handler as processPayment } from './routes/process-payment';
import { handler as publicPaymentLink } from './routes/public-payment-link';
import { handler as publicPaymentSplits } from './routes/public-payment-splits';
import { handler as quitamaisAuth } from './routes/quitamais-auth';
import { handler as quitamaisLinkSearch } from './routes/quitamais-link-search';
import { handler as quitamaisPaymentLink } from './routes/quitamais-payment-link';
import { handler as quitaplusLinkBoleto } from './routes/quitaplus-link-boleto';
import { handler as quitaplusPrepayment } from './routes/quitaplus-prepayment';
import { handler as quitaplusPrepaymentStatus } from './routes/quitaplus-prepayment-status';
import { handler as quitaplusPrepaymentTest } from './routes/quitaplus-prepayment-test';
import { handler as quitaplusProxy } from './routes/quitaplus-proxy';
import { handler as quitaplusSimulation } from './routes/quitaplus-simulation';
import { handler as quitaplusToken } from './routes/quitaplus-token';
import { handler as recurrencesManager } from './routes/recurrences-manager';
import { handler as recurringChargesCron } from './routes/recurring-charges-cron';
import { handler as refundsScheduler } from './routes/refunds-scheduler';
import { handler as sendMockMessage } from './routes/send-mock-message';
import { handler as subscriptionManager } from './routes/subscription-manager';
import { handler as subscriptionStatus } from './routes/subscription-status';
import { handler as syncCardStatus } from './routes/sync-card-status';
import { handler as syncMercadopagoStatus } from './routes/sync-mercadopago-status';
import { handler as syncPaymentStatus } from './routes/sync-payment-status';
import { handler as syncTreealStatus } from './routes/sync-treeal-status';
import { handler as thankYouSummary } from './routes/thank-you-summary';
import { handler as treealPixCreate } from './routes/treeal-pix-create';
import { handler as treealPixStatus } from './routes/treeal-pix-status';
import { handler as treealWebhook } from './routes/treeal-webhook';
import { handler as updateCompanySettings } from './routes/update-company-settings';

export const routes: Record<string, Handler> = {
  'admin-link-boleto': adminLinkBoleto,
  'admin-reports': adminReports,
  'admin-reset-password': adminResetPassword,
  'charge-links': chargeLinks,
  'company-settings': companySettings,
  'conclude-card-payment': concludeCardPayment,
  'create-admin-user': createAdminUser,
  'create-user-admin': createUserAdmin,
  'export-worker': exportWorker,
  'mercadopago-pix-create': mercadopagoPixCreate,
  'mercadopago-pix-status': mercadopagoPixStatus,
  'mercadopago-webhook': mercadopagoWebhook,
  'payment-splits': paymentSplits,
  'process-charge': processCharge,
  'process-payment': processPayment,
  'public-payment-link': publicPaymentLink,
  'public-payment-splits': publicPaymentSplits,
  'quitamais-auth': quitamaisAuth,
  'quitamais-link-search': quitamaisLinkSearch,
  'quitamais-payment-link': quitamaisPaymentLink,
  'quitaplus-link-boleto': quitaplusLinkBoleto,
  'quitaplus-prepayment': quitaplusPrepayment,
  'quitaplus-prepayment-status': quitaplusPrepaymentStatus,
  'quitaplus-prepayment-test': quitaplusPrepaymentTest,
  'quitaplus-proxy': quitaplusProxy,
  'quitaplus-simulation': quitaplusSimulation,
  'quitaplus-token': quitaplusToken,
  'recurrences-manager': recurrencesManager,
  'recurring-charges-cron': recurringChargesCron,
  'refunds-scheduler': refundsScheduler,
  'send-mock-message': sendMockMessage,
  'subscription-manager': subscriptionManager,
  'subscription-status': subscriptionStatus,
  'sync-card-status': syncCardStatus,
  'sync-mercadopago-status': syncMercadopagoStatus,
  'sync-payment-status': syncPaymentStatus,
  'sync-treeal-status': syncTreealStatus,
  'thank-you-summary': thankYouSummary,
  'treeal-pix-create': treealPixCreate,
  'treeal-pix-status': treealPixStatus,
  'treeal-webhook': treealWebhook,
  'update-company-settings': updateCompanySettings,
};
