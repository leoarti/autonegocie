import { useState } from "react";
import { CreditCard, User, Mail, Phone, Calendar, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { db } from '@/integrations/firebase/client';
import { useToast } from "@/hooks/use-toast";
import type { PaymentFormData, PaymentState } from "@/types/payment";

interface PaymentFormProps {
  amount: number;            // Valor ORIGINAL em reais (será enviado à API Quita+)
  amountDisplay?: number;    // Valor COM JUROS em reais (para exibição ao cliente, se diferente de amount)
  installments: number;
  productName: string;
  chargeId?: string;
  paymentLinkId?: string;
  hasBoleto?: boolean;
  boletoLinhaDigitavel?: string;
  creditorDocument?: string;
  creditorName?: string;
  onSuccess?: (transactionId: string) => void;
  onCancel?: () => void;
  skipSplitCheck?: boolean;
  disableSubmit?: boolean;
  initialPayerData?: {
    name?: string;
    email?: string;
    document?: string;
    phone?: string;
  };
}

export function PaymentForm({
  amount,
  amountDisplay,
  installments,
  productName,
  chargeId,
  paymentLinkId,
  hasBoleto = false,
  boletoLinhaDigitavel,
  creditorDocument,
  creditorName,
  onSuccess,
  onCancel,
  skipSplitCheck = false,
  disableSubmit = false,
  initialPayerData,
}: PaymentFormProps) {
  // Valor para enviar à API = amount (original)
  // Valor para exibir ao cliente = amountDisplay || amount
  const { toast } = useToast();
  
  const [paymentState, setPaymentState] = useState<PaymentState>({
    isProcessing: false,
    isSuccess: false,
    error: null,
    transactionId: null,
  });
  
  const [formData, setFormData] = useState<PaymentFormData>({
    payerName: initialPayerData?.name || "",
    payerDocument: initialPayerData?.document || "",
    payerEmail: initialPayerData?.email || "",
    payerPhoneNumber: initialPayerData?.phone || "",
    cardHolderName: "",
    cardNumber: "",
    cardExpirationDate: "",
    cardCvv: "",
  });

  const [errors, setErrors] = useState<Partial<PaymentFormData>>({});

  const formatCardNumber = (value: string) => {
    return value
      .replace(/\s/g, '')
      .replace(/(\d{4})/g, '$1 ')
      .trim()
      .slice(0, 19);
  };

  const formatDocument = (value: string) => {
    const numbers = value.replace(/\D/g, '');
    if (numbers.length <= 11) {
      return numbers.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    }
    return numbers.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  };

  const formatPhone = (value: string) => {
    const numbers = value.replace(/\D/g, '');
    return numbers.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  };

  const formatExpirationDate = (value: string) => {
    const numbers = value.replace(/\D/g, '');
    if (numbers.length >= 2) {
      return numbers.slice(0, 2) + '/' + numbers.slice(2, 4);
    }
    return numbers;
  };

  const handleInputChange = (field: keyof PaymentFormData, value: string) => {
    let formattedValue = value;

    switch (field) {
      case 'cardNumber':
        formattedValue = formatCardNumber(value);
        break;
      case 'payerDocument':
        formattedValue = formatDocument(value);
        break;
      case 'payerPhoneNumber':
        formattedValue = formatPhone(value);
        break;
      case 'cardExpirationDate':
        formattedValue = formatExpirationDate(value);
        break;
      case 'cardCvv':
        formattedValue = value.replace(/\D/g, '').slice(0, 4);
        break;
    }

    setFormData(prev => ({ ...prev, [field]: formattedValue }));
    
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: undefined }));
    }
  };

  const validateForm = (): boolean => {
    const newErrors: Partial<PaymentFormData> = {};

    if (!formData.payerName.trim()) newErrors.payerName = "Nome é obrigatório";
    if (!formData.payerDocument.trim()) newErrors.payerDocument = "CPF/CNPJ é obrigatório";
    if (!formData.payerEmail.trim()) newErrors.payerEmail = "E-mail é obrigatório";
    if (!formData.payerPhoneNumber.trim()) newErrors.payerPhoneNumber = "Telefone é obrigatório";
    if (!formData.cardHolderName.trim()) newErrors.cardHolderName = "Nome no cartão é obrigatório";
    if (!formData.cardNumber.trim()) newErrors.cardNumber = "Número do cartão é obrigatório";
    if (!formData.cardExpirationDate.trim()) newErrors.cardExpirationDate = "Data de validade é obrigatória";
    if (!formData.cardCvv.trim()) newErrors.cardCvv = "CVV é obrigatório";

    if (formData.payerEmail && !/\S+@\S+\.\S+/.test(formData.payerEmail)) {
      newErrors.payerEmail = "E-mail inválido";
    }

    if (formData.payerDocument) {
      const numbers = formData.payerDocument.replace(/\D/g, '');
      if (numbers.length !== 11 && numbers.length !== 14) {
        newErrors.payerDocument = "CPF deve ter 11 dígitos ou CNPJ deve ter 14 dígitos";
      }
    }

    if (formData.payerPhoneNumber) {
      const numbers = formData.payerPhoneNumber.replace(/\D/g, '');
      if (numbers.length < 10 || numbers.length > 11) {
        newErrors.payerPhoneNumber = "Telefone deve ter 10 ou 11 dígitos";
      }
    }

    if (formData.cardNumber && formData.cardNumber.replace(/\s/g, '').length < 16) {
      newErrors.cardNumber = "Número do cartão deve ter 16 dígitos";
    }

    if (formData.cardExpirationDate && !/^\d{2}\/\d{2}$/.test(formData.cardExpirationDate)) {
      newErrors.cardExpirationDate = "Formato inválido (MM/AA)";
    }

    if (formData.cardCvv && (formData.cardCvv.length < 3 || formData.cardCvv.length > 4)) {
      newErrors.cardCvv = "CVV deve ter 3 ou 4 dígitos";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) return;

    if (!chargeId || !paymentLinkId) {
      toast({
        title: "Erro",
        description: "Dados do pagamento incompletos. Por favor, tente novamente.",
        variant: "destructive",
      });
      return;
    }

    setPaymentState({
      isProcessing: true,
      isSuccess: false,
      error: null,
      transactionId: null,
    });

    try {
      console.log('[PaymentForm] Iniciando pré-pagamento Quita+...');

      const { data: prePaymentData, error: prePaymentError } = await db.functions.invoke(
        'quitaplus-prepayment',
        {
          body: {
            chargeId,
            paymentLinkId,
            amount: Math.round(amount * 100),
            installments,
            card: {
              holderName: formData.cardHolderName,
              number: formData.cardNumber.replace(/\s/g, ''),
              expirationDate: formData.cardExpirationDate.replace('/', ''),
              cvv: formData.cardCvv,
            },
            payer: {
              name: formData.payerName,
              document: formData.payerDocument.replace(/\D/g, ''),
              email: formData.payerEmail,
              phoneNumber: formData.payerPhoneNumber.replace(/\D/g, ''),
            },
          },
        }
      );

      if (prePaymentError) {
        console.error('[PaymentForm] Erro no pré-pagamento:', prePaymentError);
        throw new Error(prePaymentError.message || 'Falha ao autorizar cartão');
      }

      if (prePaymentData?.error || prePaymentData?.success === false) {
        // Priorizar userMessage (mensagem da API) sobre error (código interno)
        const errorMessage = prePaymentData.userMessage || 'Não foi possível processar o pagamento';
        
        console.error('[PaymentForm] Pagamento não autorizado:', {
          internalError: prePaymentData.error,
          userMessage: errorMessage,
          apiResponse: prePaymentData.apiRawResponse?.substring(0, 200)
        });
        
        toast({
          title: "Pagamento não autorizado",
          description: errorMessage,
          variant: "destructive",
        });
        setPaymentState({
          isProcessing: false,
          isSuccess: false,
          error: errorMessage,
          transactionId: null,
        });
        return;
      }

      const prePaymentKey = prePaymentData?.prePaymentKey;
      if (!prePaymentKey) {
        throw new Error('Chave de pré-pagamento não retornada pela API');
      }

      console.log('[PaymentForm] Cartão autorizado! PrePaymentKey:', prePaymentKey);

      if (hasBoleto && boletoLinhaDigitavel && creditorDocument && creditorName) {
        console.log('[PaymentForm] ✅ Vinculando boleto ao pré-pagamento...');

        try {
          const { data: linkData, error: linkError } = await db.functions.invoke(
            'quitaplus-link-boleto',
            {
              body: {
                prePaymentKey,
                paymentLinkId,
                boleto: {
                  number: boletoLinhaDigitavel.replace(/\D/g, ''),
                  creditorDocument: creditorDocument.replace(/\D/g, ''),
                  creditorName,
                },
              },
            }
          );

          if (linkError || linkData?.error) {
            const errorMessage = linkError?.message || linkData?.message || linkData?.error || 'Erro desconhecido';
            console.error('[PaymentForm] ❌ Erro ao vincular boleto (silencioso):', errorMessage);
            
            if (chargeId) {
              await db.from('charges')
                .update({ 
                  metadata: { 
                    link_boleto_error: { 
                      message: errorMessage, 
                      attemptedAt: new Date().toISOString(),
                      httpStatus: linkData?.httpStatus || null
                    }
                  }
                })
                .eq('id', chargeId);
            }
          } else {
            console.log('[PaymentForm] ✅ Boleto vinculado com sucesso!');
          }
        } catch (linkErr) {
          console.error('[PaymentForm] ❌ Erro inesperado no vínculo (silencioso):', linkErr);
        }
      }

      const transactionId = prePaymentData?.transactionId || prePaymentKey;
      
      setPaymentState({
        isProcessing: false,
        isSuccess: true,
        error: null,
        transactionId,
      });

      toast({
        title: "Pagamento autorizado!",
        description: hasBoleto 
          ? `Cartão autorizado e boleto vinculado com sucesso!`
          : `Transação processada com sucesso em ${installments}x.`,
      });

      onSuccess?.(transactionId);

    } catch (error) {
      console.error('[PaymentForm] Erro fatal:', error);
      const errorMessage = error instanceof Error ? error.message : 'Erro ao processar pagamento';
      
      toast({
        title: "Erro no pagamento",
        description: errorMessage,
        variant: "destructive",
      });

      setPaymentState({
        isProcessing: false,
        isSuccess: false,
        error: errorMessage,
        transactionId: null,
      });
    }
  };

  if (paymentState.isSuccess) {
    return (
      <Card className="p-8 text-center rounded-2xl shadow-md">
        <div className="w-16 h-16 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-4">
          <CreditCard className="w-8 h-8 text-emerald-600" />
        </div>
        <h3 className="text-xl font-semibold text-foreground mb-2">
          Pagamento Autorizado!
        </h3>
        <p className="text-muted-foreground mb-4">
          Sua transação foi processada com sucesso.
        </p>
        <p className="text-sm text-muted-foreground">
          ID da transação: {paymentState.transactionId}
        </p>
      </Card>
    );
  }

  return (
    <Card className="rounded-2xl border bg-card/80 shadow-md overflow-hidden">
      {/* Header */}
      <div className="p-5 lg:p-6 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-primary">
            <span className="h-2 w-2 rounded-full bg-primary" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              Dados para Pagamento
            </h3>
            <p className="text-xs text-muted-foreground">
              Preencha os dados abaixo para concluir o pagamento.
            </p>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="px-5 lg:px-6 pb-5 lg:pb-6 space-y-5">
        {/* Dados Pessoais */}
        <div className="space-y-1">
          <h4 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-primary">
              <User className="h-3.5 w-3.5" />
            </span>
            Dados Pessoais
          </h4>
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="payerName" className="text-xs font-medium">
              Nome Completo
            </Label>
            <Input
              id="payerName"
              value={formData.payerName}
              onChange={(e) => handleInputChange('payerName', e.target.value)}
              placeholder="Seu nome completo"
              className={`h-10 rounded-xl text-sm ${errors.payerName ? "border-destructive" : ""}`}
            />
            {errors.payerName && (
              <p className="text-xs text-destructive">{errors.payerName}</p>
            )}
          </div>
          
          <div className="space-y-1.5">
            <Label htmlFor="payerDocument" className="text-xs font-medium">
              CPF/CNPJ
            </Label>
            <Input
              id="payerDocument"
              value={formData.payerDocument}
              onChange={(e) => handleInputChange('payerDocument', e.target.value)}
              placeholder="000.000.000-00"
              className={`h-10 rounded-xl text-sm ${errors.payerDocument ? "border-destructive" : ""}`}
            />
            {errors.payerDocument && (
              <p className="text-xs text-destructive">{errors.payerDocument}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="payerEmail" className="text-xs font-medium">
              E-mail
            </Label>
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-xs text-muted-foreground">
                @
              </span>
              <Input
                id="payerEmail"
                type="email"
                value={formData.payerEmail}
                onChange={(e) => handleInputChange('payerEmail', e.target.value)}
                placeholder="seu@email.com"
                className={`h-10 rounded-xl bg-background pl-8 text-sm ${errors.payerEmail ? "border-destructive" : ""}`}
              />
            </div>
            {errors.payerEmail && (
              <p className="text-xs text-destructive">{errors.payerEmail}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="payerPhoneNumber" className="text-xs font-medium">
              Telefone
            </Label>
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-xs text-muted-foreground">
                +55
              </span>
              <Input
                id="payerPhoneNumber"
                value={formData.payerPhoneNumber}
                onChange={(e) => handleInputChange('payerPhoneNumber', e.target.value)}
                placeholder="(11) 99999-9999"
                className={`h-10 rounded-xl pl-10 text-sm ${errors.payerPhoneNumber ? "border-destructive" : ""}`}
              />
            </div>
            {errors.payerPhoneNumber && (
              <p className="text-xs text-destructive">{errors.payerPhoneNumber}</p>
            )}
          </div>
        </div>

        {/* Dados do Cartão */}
        <div className="space-y-1 pt-2">
          <h4 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-primary">
              <CreditCard className="h-3.5 w-3.5" />
            </span>
            Dados do Cartão
          </h4>
        </div>
        
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cardHolderName" className="text-xs font-medium">
              Nome no Cartão
            </Label>
            <Input
              id="cardHolderName"
              value={formData.cardHolderName}
              onChange={(e) => handleInputChange('cardHolderName', e.target.value)}
              placeholder="Nome como está no cartão"
              className={`h-10 rounded-xl text-sm ${errors.cardHolderName ? "border-destructive" : ""}`}
            />
            {errors.cardHolderName && (
              <p className="text-xs text-destructive">{errors.cardHolderName}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cardNumber" className="text-xs font-medium">
              Número do Cartão
            </Label>
            <Input
              id="cardNumber"
              value={formData.cardNumber}
              onChange={(e) => handleInputChange('cardNumber', e.target.value)}
              placeholder="0000 0000 0000 0000"
              maxLength={19}
              className={`h-10 rounded-xl text-sm ${errors.cardNumber ? "border-destructive" : ""}`}
            />
            {errors.cardNumber && (
              <p className="text-xs text-destructive">{errors.cardNumber}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cardExpirationDate" className="text-xs font-medium">
                Validade
              </Label>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="cardExpirationDate"
                  value={formData.cardExpirationDate}
                  onChange={(e) => handleInputChange('cardExpirationDate', e.target.value)}
                  placeholder="MM/AA"
                  maxLength={5}
                  className={`h-10 rounded-xl pl-10 text-sm ${errors.cardExpirationDate ? "border-destructive" : ""}`}
                />
              </div>
              {errors.cardExpirationDate && (
                <p className="text-xs text-destructive">{errors.cardExpirationDate}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cardCvv" className="text-xs font-medium">
                CVV
              </Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="cardCvv"
                  value={formData.cardCvv}
                  onChange={(e) => handleInputChange('cardCvv', e.target.value)}
                  placeholder="123"
                  maxLength={4}
                  className={`h-10 rounded-xl pl-10 text-sm ${errors.cardCvv ? "border-destructive" : ""}`}
                />
              </div>
              {errors.cardCvv && (
                <p className="text-xs text-destructive">{errors.cardCvv}</p>
              )}
            </div>
          </div>
        </div>

        {/* Resumo e Ações */}
        <div className="space-y-4 pt-2">
          <div className="bg-muted/50 border border-border/50 p-4 rounded-xl">
            <h5 className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">
              Resumo do Pagamento
            </h5>
            <div className="space-y-2">
            {(() => {
                // Valor para exibição = amountDisplay (com juros) ou amount (fallback)
                // CORREÇÃO: usar !== undefined para não tratar 0 como falsy
                const displayValue = (amountDisplay !== undefined && amountDisplay > 0) ? amountDisplay : amount;
                const installmentValue = installments > 0 ? displayValue / installments : displayValue;
                
                return (
                  <>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-muted-foreground truncate pr-2">{productName}</span>
                      <span className="font-medium text-foreground">R$ {displayValue.toFixed(2)}</span>
                    </div>
                    {installments > 0 && (
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-muted-foreground">Parcelamento</span>
                        <span className="font-medium text-foreground">
                          {installments}x de R$ {installmentValue.toFixed(2)}
                        </span>
                      </div>
                    )}
                    <Separator className="my-2" />
                    <div className="flex justify-between items-center pt-1">
                      <span className="font-medium text-foreground">Total</span>
                      <span className="font-bold text-lg text-primary">
                        R$ {displayValue.toFixed(2)}
                      </span>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            {onCancel && (
              <Button
                type="button"
                variant="outline"
                onClick={onCancel}
                disabled={paymentState.isProcessing}
                className="flex-1 h-11 rounded-full"
              >
                Cancelar
              </Button>
            )}
            
            <Button
              type="submit"
              disabled={paymentState.isProcessing || disableSubmit}
              className="flex-1 h-11 rounded-full text-sm font-semibold"
            >
              {paymentState.isProcessing ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-background border-t-transparent mr-2" />
                  Processando...
                </>
              ) : disableSubmit ? (
                "Selecione uma opção de pagamento"
              ) : (
                "Pagar Agora"
              )}
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}