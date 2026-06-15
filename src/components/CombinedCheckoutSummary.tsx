import { useState, useEffect, useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { QrCode, CreditCard, CheckCircle2, Shield, Loader2 } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { usePaymentSimulation } from '@/hooks/usePaymentSimulation';
import { Skeleton } from '@/components/ui/skeleton';

const PIX_FEE_PERCENT = 0.015;
const MIN_INSTALLMENT_CENTS = 1000;

interface CombinedCheckoutSummaryProps {
  totalOriginalCents: number;
  initialPixCents: number;
  initialCardCents: number;
  chargeId: string;
  paymentLinkId: string;
  // cardOriginalCents = valor ORIGINAL (para salvar no DB e enviar à API)
  // cardTotalWithInterestCents = valor COM JUROS (apenas para exibição ao cliente)
  onConfirm: (pixTotalCents: number, cardOriginalCents: number, cardTotalWithInterestCents: number, cardInstallments: number, installmentValueCents: number) => void;
}

export function CombinedCheckoutSummary({
  totalOriginalCents,
  initialPixCents,
  initialCardCents,
  chargeId,
  paymentLinkId,
  onConfirm,
}: CombinedCheckoutSummaryProps) {
  const pixBaseCents = initialPixCents;
  const cardCents = initialCardCents;
  const [cardInstallments, setCardInstallments] = useState(1);

  const { data: simulationData, isLoading: isSimulating } = usePaymentSimulation(
    cardCents > 0 ? cardCents : null
  );

  const installmentConditions = useMemo(() => {
    if (!simulationData?.simulation?.conditions) return [];
    return simulationData.simulation.conditions;
  }, [simulationData]);

  const selectedCondition = useMemo(() => {
    return installmentConditions.find(c => c.installments === cardInstallments) || null;
  }, [installmentConditions, cardInstallments]);

  const cardTotalWithInterest = useMemo(() => {
    if (selectedCondition) {
      return selectedCondition.totalAmount;
    }
    return cardCents;
  }, [selectedCondition, cardCents]);

  const pixFeeCents = useMemo(() => Math.round(pixBaseCents * PIX_FEE_PERCENT), [pixBaseCents]);
  const pixTotalCents = useMemo(() => pixBaseCents + pixFeeCents, [pixBaseCents, pixFeeCents]);

  const totalWithFeeCents = useMemo(() => pixTotalCents + cardTotalWithInterest, [pixTotalCents, cardTotalWithInterest]);

  const maxInstallments = useMemo(() => {
    if (installmentConditions.length > 0) {
      return Math.max(...installmentConditions.map(c => c.installments));
    }
    if (cardCents <= 0) return 1;
    const max = Math.floor(cardCents / MIN_INSTALLMENT_CENTS);
    return Math.min(Math.max(max, 1), 12);
  }, [cardCents, installmentConditions]);

  useEffect(() => {
    if (cardInstallments > maxInstallments) {
      setCardInstallments(Math.max(1, maxInstallments));
    }
  }, [maxInstallments, cardInstallments]);

  return (
    <div className="min-h-screen bg-muted flex items-center justify-center p-4">
      <Card className="max-w-2xl w-full p-6 lg:p-8 rounded-2xl shadow-md">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-2xl font-semibold text-foreground">Resumo do Pagamento</h1>
        </div>

        {/* Payment Method Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {/* PIX Card */}
          {pixBaseCents > 0 && (
            <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-2xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                  <QrCode className="w-4 h-4" />
                </div>
                <h3 className="text-sm font-medium text-emerald-800 dark:text-emerald-200">Pagamento via PIX</h3>
              </div>
              
              <div className="flex justify-between items-center pt-2">
                <span className="text-sm text-emerald-700 dark:text-emerald-300">Total PIX</span>
                <span className="font-bold text-emerald-600 text-xl">{formatCurrency(pixTotalCents)}</span>
              </div>
            </div>
          )}

          {/* Card Payment */}
          {cardCents > 0 && (
            <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-2xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-blue-600">
                  <CreditCard className="w-4 h-4" />
                </div>
                <h3 className="text-sm font-medium text-blue-800 dark:text-blue-200">Pagamento via Cartão</h3>
              </div>
              
              <div className="space-y-3">
                <div>
                  <Label className="text-xs text-blue-700 dark:text-blue-300">Parcelas</Label>
                  {isSimulating ? (
                    <Skeleton className="h-10 w-full rounded-xl" />
                  ) : (
                    <Select
                      value={cardInstallments.toString()}
                      onValueChange={(v) => setCardInstallments(parseInt(v))}
                    >
                      <SelectTrigger className="bg-white dark:bg-card border-blue-200 rounded-xl h-10 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {installmentConditions.length > 0 ? (
                          installmentConditions.map((condition) => (
                            <SelectItem key={condition.installments} value={condition.installments.toString()}>
                              {condition.installments}x de {formatCurrency(condition.installmentAmount)}
                              {condition.installments === 1 ? ' (à vista)' : ` (Total: ${formatCurrency(condition.totalAmount)})`}
                            </SelectItem>
                          ))
                        ) : (
                          Array.from({ length: maxInstallments }, (_, i) => i + 1).map((i) => (
                            <SelectItem key={i} value={i.toString()}>
                              {i}x de {formatCurrency(Math.ceil(cardCents / i))}
                              {i === 1 ? ' (à vista)' : ''}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                
                <div className="border-t border-blue-200 dark:border-blue-700 pt-2 flex justify-between">
                  <span className="text-sm text-blue-700 dark:text-blue-300">Total Cartão</span>
                  <span className="font-bold text-blue-600 text-lg">
                    {formatCurrency(cardTotalWithInterest)}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Summary */}
        <div className="bg-muted/50 border border-border rounded-2xl p-4 mb-6">
          <div className="space-y-2">
            {pixBaseCents > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">PIX</span>
                <span className="text-foreground font-medium">{formatCurrency(pixTotalCents)}</span>
              </div>
            )}
            {cardCents > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  Cartão ({cardInstallments}x de {formatCurrency(selectedCondition?.installmentAmount || Math.ceil(cardCents / cardInstallments))})
                </span>
                <span className="text-foreground font-medium">{formatCurrency(cardTotalWithInterest)}</span>
              </div>
            )}
            <div className="border-t border-border pt-2 flex justify-between">
              <span className="font-medium text-foreground">Total a Pagar</span>
              <span className="font-bold text-primary text-xl">{formatCurrency(totalWithFeeCents)}</span>
            </div>
          </div>
        </div>

        {/* Payment Order */}
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-2xl p-4 mb-6">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-800 dark:text-amber-200">
              <p className="font-medium mb-1">Ordem de Pagamento:</p>
              <ol className="list-decimal list-inside space-y-1">
                {pixBaseCents > 0 && <li>Primeiro: Pagar <strong>{formatCurrency(pixTotalCents)}</strong> via PIX</li>}
                {cardCents > 0 && <li>{pixBaseCents > 0 ? 'Depois' : 'Primeiro'}: Pagar <strong>{formatCurrency(cardTotalWithInterest)}</strong> via Cartão ({cardInstallments}x)</li>}
              </ol>
            </div>
          </div>
        </div>

        {/* Confirm Button */}
        <Button
          onClick={() => onConfirm(
            pixTotalCents,
            cardCents,              // Valor ORIGINAL (para salvar no DB e enviar à API)
            cardTotalWithInterest,  // Valor COM JUROS (para exibição)
            cardInstallments,
            selectedCondition?.installmentAmount || Math.ceil(cardTotalWithInterest / cardInstallments)
          )}
          disabled={(pixBaseCents === 0 && cardCents === 0) || isSimulating}
          className="w-full h-11 rounded-full text-sm font-semibold"
          size="lg"
        >
          {isSimulating ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Calculando parcelas...
            </>
          ) : pixBaseCents > 0 ? (
            <>
              <QrCode className="mr-2 h-4 w-4" />
              Continuar para PIX
            </>
          ) : (
            <>
              <CreditCard className="mr-2 h-4 w-4" />
              Continuar para Cartão
            </>
          )}
        </Button>

        {/* Security */}
        <div className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Shield className="w-4 h-4" />
          <span>Pagamento 100% seguro</span>
        </div>
      </Card>
    </div>
  );
}