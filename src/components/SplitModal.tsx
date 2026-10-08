import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { CreditCard, QrCode, AlertCircle, Loader2, Zap } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/integrations/firebase/client';
import { CardInstallmentSelector } from '@/components/CardInstallmentSelector';
import {
  toCents,
  formatCents,
  formatBRLInput,
  formatPercentageInput,
  parsePercentage,
  percentToCents,
  centsToPercent,
} from '@/lib/currency-utils';

interface SplitModalProps {
  isOpen: boolean;
  onClose: () => void;
  totalCents: number;
  chargeId: string;
  paymentLinkId?: string;
}

interface PaymentSplit {
  method: 'PIX' | 'CARD';
  amountCents: number;
  percentage: number;
  installments?: number;
}

const paymentMethods = [
  { 
    value: 'PIX', 
    label: 'PIX', 
    icon: QrCode, 
    color: 'bg-primary',
    subtitle: 'Confirmação imediata'
  },
  { 
    value: 'CARD', 
    label: 'Cartão de Crédito', 
    icon: CreditCard, 
    color: 'bg-blue-500',
    subtitle: 'Pagamento no crédito'
  }
];

const isValidUuid = (uuid: string): boolean => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
};

export function SplitModal({ isOpen, onClose, totalCents, chargeId, paymentLinkId }: SplitModalProps) {
  const { toast } = useToast();
  const navigate = useNavigate();
  
  // Initialize with 100% PIX
  const [pixCents, setPixCents] = useState(totalCents);
  const [cardCents, setCardCents] = useState(0);
  const [pixPercent, setPixPercent] = useState('100,00');
  const [cardPercent, setCardPercent] = useState('0,00');
  const [pixValue, setPixValue] = useState(formatBRLInput((totalCents / 100).toFixed(2).replace('.', ',')));
  const [cardValue, setCardValue] = useState('0,00');
  const [cardInstallments, setCardInstallments] = useState(1);
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalAllocated = pixCents + cardCents;
  const remaining = totalCents - totalAllocated;
  const remainingAbs = Math.abs(remaining);
  const isExact = remaining === 0;
  const isOver = remaining < 0;

  // Update PIX from R$ input
  const handlePixValueChange = (value: string) => {
    const formatted = formatBRLInput(value);
    setPixValue(formatted);
    
    const cents = toCents(formatted);
    setPixCents(cents);
    
    const percent = centsToPercent(cents, totalCents);
    setPixPercent(formatPercentageInput(percent.toFixed(2).replace('.', ',')));
  };

  // Update PIX from % input
  const handlePixPercentChange = (value: string) => {
    const formatted = formatPercentageInput(value);
    setPixPercent(formatted);
    
    const percent = parsePercentage(formatted);
    const cents = percentToCents(percent, totalCents);
    setPixCents(cents);
    
    setPixValue(formatBRLInput((cents / 100).toFixed(2).replace('.', ',')));
  };

  // Update CARD from R$ input
  const handleCardValueChange = (value: string) => {
    const formatted = formatBRLInput(value);
    setCardValue(formatted);
    
    const cents = toCents(formatted);
    setCardCents(cents);
    
    const percent = centsToPercent(cents, totalCents);
    setCardPercent(formatPercentageInput(percent.toFixed(2).replace('.', ',')));
  };

  // Update CARD from % input
  const handleCardPercentChange = (value: string) => {
    const formatted = formatPercentageInput(value);
    setCardPercent(formatted);
    
    const percent = parsePercentage(formatted);
    const cents = percentToCents(percent, totalCents);
    setCardCents(cents);
    
    setCardValue(formatBRLInput((cents / 100).toFixed(2).replace('.', ',')));
  };

  // Shortcut presets
  const applyPreset = (pixPercent: number, cardPercent: number) => {
    const pixC = percentToCents(pixPercent, totalCents);
    const cardC = percentToCents(cardPercent, totalCents);
    
    setPixCents(pixC);
    setCardCents(cardC);
    setPixPercent(formatPercentageInput(pixPercent.toFixed(2).replace('.', ',')));
    setCardPercent(formatPercentageInput(cardPercent.toFixed(2).replace('.', ',')));
    setPixValue(formatBRLInput((pixC / 100).toFixed(2).replace('.', ',')));
    setCardValue(formatBRLInput((cardC / 100).toFixed(2).replace('.', ',')));
  };

  // Adjust difference to PIX
  const adjustDifferenceToPix = () => {
    const newPixCents = totalCents - cardCents;
    setPixCents(newPixCents);
    setPixPercent(formatPercentageInput(centsToPercent(newPixCents, totalCents).toFixed(2).replace('.', ',')));
    setPixValue(formatBRLInput((newPixCents / 100).toFixed(2).replace('.', ',')));
  };

  // Validations
  const validateSplits = (): { valid: boolean; errors: string[] } => {
    const errors: string[] = [];
    
    if (totalAllocated !== totalCents) {
      errors.push(`A soma deve ser exatamente ${formatCents(totalCents)}`);
    }
    
    if (pixCents > 0 && pixCents < 100) {
      errors.push('PIX deve ter no mínimo R$ 1,00');
    }
    
    if (cardCents > 0 && cardCents < 100) {
      errors.push('Cartão deve ter no mínimo R$ 1,00');
    }
    
    if (cardCents > 0 && cardInstallments > 1) {
      const installmentValue = Math.floor(cardCents / cardInstallments);
      if (installmentValue < 1000) {
        errors.push('Parcela do cartão deve ser no mínimo R$ 10,00');
      }
    }
    
    return { valid: errors.length === 0, errors };
  };

  const handleConfirmSplits = async () => {
    const validation = validateSplits();
    if (!validation.valid) {
      setError(validation.errors[0]);
      return;
    }

    setLoading(true);
    setError(null);
    
    try {
      const splitsToInsert = [];
      
      if (pixCents > 0) {
        splitsToInsert.push({
          payment_link_id: paymentLinkId || null,
          charge_id: isValidUuid(chargeId) ? chargeId : null,
          method: 'pix',
          amount_cents: pixCents,
          order_index: 1,
          installments: 1,
          status: 'pending'
        });
      }
      
      if (cardCents > 0) {
        splitsToInsert.push({
          payment_link_id: paymentLinkId || null,
          charge_id: isValidUuid(chargeId) ? chargeId : null,
          method: 'credit_card',
          amount_cents: cardCents,
          order_index: 2,
          installments: cardInstallments,
          status: 'pending'
        });
      }

      const { error: dbError } = await db
        .from('payment_splits')
        .insert(splitsToInsert);

      if (dbError) throw dbError;

      // Redirecionar conforme a escolha
      const redirectId = paymentLinkId || chargeId;
      const hasPix = pixCents > 0;
      const hasCard = cardCents > 0;

      if (hasPix && hasCard) {
        navigate(`/payment-pix/${redirectId}?next=card`);
      } else if (hasPix) {
        navigate(`/payment-pix/${redirectId}`);
      } else {
        navigate(`/payment-card/${redirectId}`);
      }

      onClose();
    } catch (err: any) {
      console.error('Error saving splits:', err);
      setError('Não foi possível salvar as formas de pagamento.');
    } finally {
      setLoading(false);
    }
  };

  const validation = validateSplits();
  const progressPercent = Math.min((totalAllocated / totalCents) * 100, 100);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl">Como deseja pagar?</DialogTitle>
          <DialogDescription>
            Escolha combinar PIX + Cartão ou pagar tudo em um único método
          </DialogDescription>
        </DialogHeader>

        {/* Quick Presets */}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => applyPreset(100, 0)}
            className="flex items-center gap-1"
          >
            <Zap className="w-3 h-3" />
            100% PIX
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => applyPreset(0, 100)}
            className="flex items-center gap-1"
          >
            <Zap className="w-3 h-3" />
            100% Cartão
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => applyPreset(50, 50)}
            className="flex items-center gap-1"
          >
            <Zap className="w-3 h-3" />
            50/50
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => applyPreset(80, 20)}
            className="flex items-center gap-1"
          >
            <Zap className="w-3 h-3" />
            80/20
          </Button>
        </div>

        {/* Payment Method Cards */}
        <div className="space-y-4">
          {/* PIX */}
          <Card className="p-4">
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-lg bg-primary">
                <QrCode className="w-6 h-6 text-white" />
              </div>

              <div className="flex-1 space-y-3">
                <div>
                  <Label className="text-base font-semibold">PIX</Label>
                  <p className="text-xs text-muted-foreground">Confirmação imediata</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="pix-value" className="text-sm">
                      Valor (R$)
                    </Label>
                    <Input
                      id="pix-value"
                      value={pixValue}
                      onChange={(e) => handlePixValueChange(e.target.value)}
                      placeholder="0,00"
                      className="mt-1"
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          handlePixValueChange(formatBRLInput(((pixCents + 100) / 100).toFixed(2).replace('.', ',')));
                        } else if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          handlePixValueChange(formatBRLInput((Math.max(0, pixCents - 100) / 100).toFixed(2).replace('.', ',')));
                        }
                      }}
                    />
                  </div>

                  <div>
                    <Label htmlFor="pix-percent" className="text-sm">
                      %
                    </Label>
                    <Input
                      id="pix-percent"
                      value={pixPercent}
                      onChange={(e) => handlePixPercentChange(e.target.value)}
                      placeholder="0,00"
                      className="mt-1"
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          const current = parsePercentage(pixPercent);
                          handlePixPercentChange(formatPercentageInput((current + 0.5).toFixed(2).replace('.', ',')));
                        } else if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          const current = parsePercentage(pixPercent);
                          handlePixPercentChange(formatPercentageInput((Math.max(0, current - 0.5)).toFixed(2).replace('.', ',')));
                        }
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </Card>

          {/* CARD */}
          <Card className="p-4">
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-lg bg-blue-500">
                <CreditCard className="w-6 h-6 text-white" />
              </div>

              <div className="flex-1 space-y-3">
                <div>
                  <Label className="text-base font-semibold">Cartão de Crédito</Label>
                  <p className="text-xs text-muted-foreground">Pagamento no crédito</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="card-value" className="text-sm">
                      Valor (R$)
                    </Label>
                    <Input
                      id="card-value"
                      value={cardValue}
                      onChange={(e) => handleCardValueChange(e.target.value)}
                      placeholder="0,00"
                      className="mt-1"
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          handleCardValueChange(formatBRLInput(((cardCents + 100) / 100).toFixed(2).replace('.', ',')));
                        } else if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          handleCardValueChange(formatBRLInput((Math.max(0, cardCents - 100) / 100).toFixed(2).replace('.', ',')));
                        }
                      }}
                    />
                  </div>

                  <div>
                    <Label htmlFor="card-percent" className="text-sm">
                      %
                    </Label>
                    <Input
                      id="card-percent"
                      value={cardPercent}
                      onChange={(e) => handleCardPercentChange(e.target.value)}
                      placeholder="0,00"
                      className="mt-1"
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          const current = parsePercentage(cardPercent);
                          handleCardPercentChange(formatPercentageInput((current + 0.5).toFixed(2).replace('.', ',')));
                        } else if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          const current = parsePercentage(cardPercent);
                          handleCardPercentChange(formatPercentageInput((Math.max(0, current - 0.5)).toFixed(2).replace('.', ',')));
                        }
                      }}
                    />
                  </div>
                </div>

                {cardCents > 0 && (
                  <div className="mt-4">
                    <CardInstallmentSelector
                      cardAmountCents={cardCents}
                      selectedInstallments={cardInstallments}
                      onInstallmentsChange={setCardInstallments}
                    />
                  </div>
                )}
              </div>
            </div>
          </Card>
        </div>

        {/* Progress Bar & Remaining Indicator */}
        <div className="space-y-2">
          <Progress value={progressPercent} className="h-2" />
          
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              {isExact ? (
                <>
                  <Badge variant="default" className="bg-green-600">✓</Badge>
                  <span className="text-green-600 font-medium">Soma exata</span>
                </>
              ) : isOver ? (
                <>
                  <Badge variant="destructive">!</Badge>
                  <span className="text-destructive font-medium">Excedeu {formatCents(remainingAbs)}</span>
                </>
              ) : (
                <>
                  <Badge variant="secondary" className="bg-yellow-500 text-white">⚠</Badge>
                  <span className="text-yellow-600 font-medium">Faltam {formatCents(remainingAbs)}</span>
                </>
              )}
            </div>
            
            {!isExact && (
              <Button
                variant="ghost"
                size="sm"
                onClick={adjustDifferenceToPix}
                className="h-7 text-xs"
              >
                Ajustar diferença no PIX
              </Button>
            )}
          </div>
        </div>

        {/* Summary */}
        <div className="bg-muted/50 p-4 rounded-lg space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Total da cobrança:</span>
            <span className="font-semibold">{formatCents(totalCents)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Total alocado:</span>
            <span className={`font-semibold ${
              isExact ? 'text-green-600' : isOver ? 'text-destructive' : 'text-yellow-600'
            }`}>
              {formatCents(totalAllocated)}
            </span>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
            <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm text-destructive font-medium">{error}</p>
              <Button
                variant="link"
                size="sm"
                onClick={() => setError(null)}
                className="h-auto p-0 text-xs text-destructive underline"
              >
                Tentar novamente
              </Button>
            </div>
          </div>
        )}

        {/* Validation Errors */}
        {!validation.valid && !error && (
          <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
            <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
            <div className="text-sm text-destructive">
              {validation.errors.map((err, i) => (
                <div key={i}>• {err}</div>
              ))}
            </div>
          </div>
        )}

        {/* Confirm Button */}
        <Button
          onClick={handleConfirmSplits}
          disabled={loading || !validation.valid}
          className="w-full"
          size="lg"
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 w-5 h-5 animate-spin" />
              Salvando...
            </>
          ) : (
            'Continuar para o Pagamento'
          )}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
