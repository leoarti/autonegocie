import { useState, useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { User, Receipt, Banknote, Calculator, CreditCard, QrCode, AlertCircle, Building2 } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { db } from '@/integrations/firebase/client';
import { useToast } from "@/hooks/use-toast";
import { z } from "zod";
import { CheckoutSuccessModal } from '@/components/CheckoutSuccessModal';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useCompanySettings } from '@/hooks/useCompanySettings';
import { formatPhone, formatDocument, formatCurrencyInput, unformatPhone, unformatDocument, currencyToCents } from '@/lib/input-masks';
import { cn } from '@/lib/utils';
import { SimulatorModal } from '@/components/SimulatorModal';
import { DashboardShell } from '@/components/dashboard/DashboardShell';

interface Company {
  id: string;
  name: string;
}

const formSchema = z.object({
  payer_name: z.string().min(1, "Nome é obrigatório").max(200, "Nome deve ter no máximo 200 caracteres"),
  payer_email: z.string().email("Email inválido"),
  payer_phone: z.string()
    .min(1, "Telefone é obrigatório")
    .refine((val) => {
      const digits = val.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 11;
    }, {
      message: "Telefone deve ter 10 ou 11 dígitos"
    }),
  payer_document: z.string()
    .min(1, "CPF/CNPJ é obrigatório")
    .refine((val) => {
      const digits = val.replace(/\D/g, '');
      return digits.length === 11 || digits.length === 14;
    }, {
      message: "CPF deve ter 11 dígitos ou CNPJ deve ter 14 dígitos"
    }),
  payment_method: z.enum(["pix", "cartao", "cartao_pix"]).default("cartao"),
  amount: z.string().min(1, "Valor é obrigatório"),
  pix_amount: z.string().optional(),
  card_amount: z.string().optional(),
  description: z.string().optional(),
  installments: z.string(),
  mask_fee: z.boolean(),
  has_boleto: z.boolean(),
  boleto_barcode: z.string().optional(),
  boleto_linha_digitavel: z.string().optional(),
}).superRefine((data, ctx) => {
  // Linha digitável obrigatória (47 dígitos) para cartão e cartao_pix
  if (data.payment_method === 'cartao' || data.payment_method === 'cartao_pix') {
    if (!data.boleto_linha_digitavel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Linha digitável é obrigatória para pagamento com cartão",
        path: ["boleto_linha_digitavel"],
      });
    } else {
      const digits = data.boleto_linha_digitavel.replace(/\D/g, '');
      if (digits.length !== 47) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Linha digitável deve ter exatamente 47 dígitos",
          path: ["boleto_linha_digitavel"],
        });
      }
    }
  }
  
  // Validar split de valores para cartao_pix
  if (data.payment_method === 'cartao_pix') {
    if (!data.pix_amount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Valor do PIX é obrigatório",
        path: ["pix_amount"],
      });
    }
    if (!data.card_amount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Valor do Cartão é obrigatório",
        path: ["card_amount"],
      });
    }
    // Validar soma PIX + Cartão = Total
    if (data.pix_amount && data.card_amount && data.amount) {
      const pixCents = currencyToCents(data.pix_amount);
      const cardCents = currencyToCents(data.card_amount);
      const totalCents = currencyToCents(data.amount);
      if (pixCents + cardCents !== totalCents) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Soma PIX (R$ ${(pixCents/100).toFixed(2)}) + Cartão (R$ ${(cardCents/100).toFixed(2)}) deve ser igual ao total (R$ ${(totalCents/100).toFixed(2)})`,
          path: ["card_amount"],
        });
      }
    }
  }
});

interface FormData {
  payer_name: string;
  payer_email: string;
  payer_phone: string;
  payer_document: string;
  payment_method: "pix" | "cartao" | "cartao_pix";
  amount: string;
  pix_amount?: string;
  card_amount?: string;
  description?: string;
  installments: string;
  mask_fee: boolean;
  has_boleto: boolean;
  boleto_barcode?: string;
  boleto_linha_digitavel?: string;
}

export default function NewCharge() {
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState<'creating' | 'generating'>('creating');
  const [error, setError] = useState("");
  const [hasPayoutAccount, setHasPayoutAccount] = useState(false);
  const [checkingPayoutAccount, setCheckingPayoutAccount] = useState(false);
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  const [showSimulatorModal, setShowSimulatorModal] = useState(false);
  
  // Admin: seleção de empresa
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('');
  const [loadingCompanies, setLoadingCompanies] = useState(false);
  
  const { 
    data: creditorSettings, 
    isLoading: settingsLoading, 
    isValid: isSettingsValid 
  } = useCompanySettings();
  const [checkoutData, setCheckoutData] = useState<{
    chargeId: string;
    checkoutUrl: string;
    linkId: string;
    amount: number;
    payerName: string;
    description?: string;
    status: 'PENDENTE' | 'PROCESSANDO' | 'CONCLUIDO' | 'ERRO';
  } | null>(null);
  const { profile, loading: authLoading, isAdmin } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const {
    register,
    handleSubmit,
    watch,
    control,
    setValue,
    getValues,
    formState: { errors }
  } = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      payment_method: "cartao",
      mask_fee: false,
      has_boleto: false,
      installments: "1"
    }
  });

  const watchAmount = watch("amount");
  const watchHasBoleto = watch("has_boleto");
  const watchBoletoLinhaDigitavel = watch("boleto_linha_digitavel");
  const watchPayerName = watch("payer_name");
  const watchPaymentMethod = watch("payment_method");
  const watchPixAmount = watch("pix_amount");
  const watchCardAmount = watch("card_amount");

  // Buscar empresas para admin
  useEffect(() => {
    if (!profile || !isAdmin) return;
    
    const fetchCompanies = async () => {
      setLoadingCompanies(true);
      try {
        const { data, error } = await db
          .from('companies')
          .select('id, name')
          .eq('is_active', true)
          .order('name');
        
        if (error) throw error;
        setCompanies(data || []);
        
        // Setar a empresa do usuário como padrão
        if (profile.company_id) {
          setSelectedCompanyId(profile.company_id);
        }
      } catch (error) {
        console.error('[NewCharge] Erro ao carregar empresas:', error);
      } finally {
        setLoadingCompanies(false);
      }
    };
    
    fetchCompanies();
  }, [profile, isAdmin]);

  useEffect(() => {
    if (!profile) return;
    
    const checkPayoutAccount = async () => {
      setCheckingPayoutAccount(true);
      try {
        const { data: payoutData, error: payoutError } = await db
          .from('payout_accounts')
          .select('id')
          .eq('user_id', profile.id)
          .eq('is_active', true)
          .limit(1);

        if (payoutError) throw payoutError;
        setHasPayoutAccount((payoutData ?? []).length > 0);
      } catch (error) {
        console.error('[NewCharge] ❌ Erro ao verificar conta de pagamento:', error);
      } finally {
        setCheckingPayoutAccount(false);
      }
    };

    checkPayoutAccount();
  }, [profile]);

  const formatAmount = (value: string) => {
    const numericValue = parseFloat(
      value.replace(/[^\d.,]/g, '')
        .replace(/\./g, '')
        .replace(',', '.')
    );
    return Math.round(numericValue * 100);
  };

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(cents / 100);
  };

  const normalizeBoletoLinhaDigitavel = (linha: string) => {
    return linha.replace(/\D/g, '');
  };

  const onValidationError = (errors: any) => {
    const formValues = getValues();
    console.warn('❌ [NewCharge] Validação Zod FALHOU. Campos inválidos:', Object.keys(errors));
    Object.entries(errors).forEach(([field, err]: [string, any]) => {
      console.warn(`  ❌ ${field}:`, {
        mensagem: err?.message,
        tipo: err?.type,
        valor_atual: formValues[field as keyof FormData],
      });
    });
    console.warn('❌ [NewCharge] Estado completo do form:', {
      payment_method: formValues.payment_method,
      amount: formValues.amount,
      pix_amount: formValues.pix_amount,
      card_amount: formValues.card_amount,
      boleto_linha_digitavel: formValues.boleto_linha_digitavel
        ? `${formValues.boleto_linha_digitavel.replace(/\D/g, '').length} dígitos (${formValues.boleto_linha_digitavel.substring(0, 8)}...)`
        : 'vazio/undefined',
      has_boleto: formValues.has_boleto,
    });

    const camposComErro = Object.entries(errors)
      .map(([field, err]: [string, any]) => `• ${field}: ${err?.message}`)
      .join('\n');

    toast({
      title: 'Erro de validação',
      description: `Corrija os campos abaixo:\n${camposComErro}`,
      variant: 'destructive',
    });

    // Scroll até o primeiro campo com erro para visibilidade
    setTimeout(() => {
      const firstErrorField = Object.keys(errors)[0];
      if (firstErrorField) {
        const el = document.getElementById(firstErrorField) 
          || document.querySelector(`[name="${firstErrorField}"]`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          (el as HTMLElement).focus?.();
        }
      }
    }, 100);
  };

  const onSubmit = async (data: FormData) => {
    console.log('✅ Iniciando criação de cobrança:', {
      valor: data.amount,
      pagador: data.payer_name
    });

    // Log detalhado para cobranças combinadas
    if (data.payment_method === 'cartao_pix') {
      const pixCents = formatAmount(data.pix_amount || '0');
      const cardCents = formatAmount(data.card_amount || '0');
      const totalCents = formatAmount(data.amount);
      console.log('🔀 [NewCharge] cartao_pix — diagnóstico split:', {
        pix_amount_raw: data.pix_amount,
        card_amount_raw: data.card_amount,
        amount_raw: data.amount,
        pix_cents: pixCents,
        card_cents: cardCents,
        total_cents: totalCents,
        soma_split: pixCents + cardCents,
        split_bate: (pixCents + cardCents) === totalCents,
        boleto_linha_digitavel: data.boleto_linha_digitavel
          ? `${data.boleto_linha_digitavel.replace(/\D/g, '').length} dígitos`
          : 'vazio/undefined',
      });
    }
    
    if (!profile) return;
    
    setIsLoading(true);
    
    if (!isSettingsValid) {
      toast({
        title: 'Configurações da empresa ausentes',
        description: 'Atualize a página e tente novamente. Se o problema persistir, entre em contato com o suporte.',
        variant: 'destructive'
      });
      setIsLoading(false);
      return;
    }
    
    // Log para debug
    if (data.payment_method === 'cartao' || data.payment_method === 'cartao_pix') {
      console.log('ui.newcharge.cartao.boleto_obrigatorio:', data.boleto_linha_digitavel ? 'preenchido' : 'vazio');
    }
    
    try {
      setLoadingStage('creating');
      setError("");

      let amountInCents = formatAmount(data.amount);
      
      // Validar que o valor é um número válido antes de inserir
      if (isNaN(amountInCents) || amountInCents <= 0) {
        throw new Error('Valor inválido. Verifique o campo de valor e tente novamente.');
      }
      let feeAmount = 0;
      let feePercentage = 0;
      
      if (data.payment_method === 'pix') {
        // Taxa PIX (1.5%) é calculada exclusivamente no checkout (CheckoutPix.tsx)
        // NÃO armazenar fee_amount aqui para evitar dupla subtração no checkout
        feeAmount = 0;
        feePercentage = 0;
      }

      const normalizedLinhaDigitavel = data.boleto_linha_digitavel 
        ? normalizeBoletoLinhaDigitavel(data.boleto_linha_digitavel)
        : null;

      // Linha digitável é obrigatória para cartão e cartao_pix
      const requiresBoleto = data.payment_method === 'cartao' || data.payment_method === 'cartao_pix';
      
      if (requiresBoleto && normalizedLinhaDigitavel) {
        console.log('Backend: boleto_linha_digitavel saved', {
          length: normalizedLinhaDigitavel.length,
          hash_prefix: normalizedLinhaDigitavel.substring(0, 8)
        });
      }

      // Admin pode escolher outra empresa; operador usa sua própria
      const targetCompanyId = isAdmin && selectedCompanyId ? selectedCompanyId : profile.company_id;

      // INSERT direto — sem Promise.race (causa bugs com PostgREST thenables)
      const t0 = performance.now();
      console.log('[NewCharge] ⏳ Iniciando INSERT...', { company_id: targetCompanyId, payment_method: data.payment_method });
      console.log('[NewCharge] 🔑 Verificando sessão antes do INSERT...');
      const { data: sessionCheck } = await db.auth.getSession();
      console.log('[NewCharge] 🔑 Sessão:', sessionCheck?.session ? `válida (uid=${sessionCheck.session.user.id})` : 'NULA — INSERT vai falhar');

      console.log('[NewCharge] 📡 Disparando POST /rest/v1/charges...');
      const { data: charge, error: chargeError } = await db
        .from('charges')
        .insert({
          company_id: targetCompanyId,
          created_by: profile.id,
          payer_name: data.payer_name,
          payer_email: data.payer_email,
          payer_document: unformatDocument(data.payer_document),
          payer_phone: unformatPhone(data.payer_phone),
          amount: amountInCents,
          description: data.description || null,
          payment_method: data.payment_method,
          installments: parseInt(data.installments),
          mask_fee: data.mask_fee,
          has_boleto: data.payment_method === 'cartao' ? !!normalizedLinhaDigitavel : data.has_boleto,
          boleto_barcode: data.boleto_barcode || null,
          has_boleto_link: requiresBoleto,
          boleto_linha_digitavel: data.payment_method === 'cartao' ? normalizedLinhaDigitavel : null,
          boleto_pix_cartao_linha_digitavel: data.payment_method === 'cartao_pix' ? normalizedLinhaDigitavel : null,
          pix_amount: data.payment_method === 'cartao_pix' ? formatAmount(data.pix_amount || '0') : null,
          card_amount: data.payment_method === 'cartao_pix' ? formatAmount(data.card_amount || '0') : null,
          creditor_document: creditorSettings?.creditor_document || null,
          creditor_name: creditorSettings?.creditor_name || null,
          message_template_id: null,
          message_template_snapshot: null,
          recurrence_type: 'pontual',
          recurrence_interval: 1,
          recurrence_end_date: null,
          next_charge_date: null,
          fee_amount: feeAmount,
          fee_percentage: feePercentage,
          metadata: {
            created_via: 'web_interface',
            user_agent: navigator.userAgent,
            original_amount: data.payment_method === 'pix' ? formatAmount(data.amount) : undefined
          }
        })
        .select()
        .single();

      console.log(`[NewCharge] ✅ INSERT concluído em ${(performance.now() - t0).toFixed(0)}ms`);

      if (chargeError) {
        console.error('❌ [NewCharge] Erro no INSERT:', chargeError);
        throw chargeError;
      }

      console.log('[NewCharge] Cobrança criada com sucesso no banco:', charge.id);

      // Log campos combinados salvos no DB
      if (data.payment_method === 'cartao_pix') {
        console.log('🔀 [NewCharge] cartao_pix — campos salvos no DB:', {
          charge_id: charge.id,
          pix_amount: charge.pix_amount,
          card_amount: charge.card_amount,
          boleto_pix_cartao_linha_digitavel: charge.boleto_pix_cartao_linha_digitavel
            ? `${charge.boleto_pix_cartao_linha_digitavel.length} dígitos`
            : 'NULL',
          payment_method: charge.payment_method,
        });
      }

      if (data.payment_method === 'pix') {
        // Sempre usar domínio de produção fixo - NUNCA usar window.location.origin
        const PRODUCTION_DOMAIN = 'https://pay1.autonegocie.com';
        const checkoutUrl = `${PRODUCTION_DOMAIN}/checkout-pix/${charge.id}`;
        
        const fullCheckoutData = {
          chargeId: charge.id,
          checkoutUrl: checkoutUrl,
          linkId: charge.id,
          amount: charge.amount,
          payerName: charge.payer_name,
          description: charge.description || undefined,
          status: 'PENDENTE' as const
        };
        
        toast({
          title: "Cobrança PIX criada!",
          description: "Link de pagamento gerado com sucesso.",
        });
        
        setCheckoutData(fullCheckoutData);
        setShowCheckoutModal(true);
        return;
      }

      if (data.has_boleto) {
        toast({
          title: "Cobrança criada com sucesso!",
          description: "Cobrança com boleto criada. O processamento será realizado quando a integração estiver ativa.",
        });
        navigate('/charges');
        return;
      }

      if (requiresBoleto && normalizedLinhaDigitavel) {
        console.log('[NewCharge] ℹ️ Cobrança com boleto criada:', {
          chargeId: charge.id,
          temLinhaDigitavel: true,
          comprimentoLinha: normalizedLinhaDigitavel.length,
          creditorDocument: creditorSettings?.creditor_document,
          creditorName: creditorSettings?.creditor_name,
          info: 'O boleto será vinculado automaticamente no backend após autorização do cartão (quitaplus-prepayment)'
        });
      }

      // Fire-and-forget: gerar link em background sem bloquear o usuário
      if (!data.has_boleto) {
        console.log('[NewCharge] Disparando geração de link em background...');
        
        // Não usa await — o link será gerado em segundo plano
        db.functions.invoke('charge-links', {
          body: { chargeId: charge.id, action: 'create' }
        }).then(({ data: linkData }) => {
          if (linkData?.link?.url) {
            console.log('[NewCharge] Link gerado em background:', linkData.link.url);
          }
        }).catch(err => {
          console.warn('[NewCharge] Link será gerado depois:', err?.message);
        });

        const PRODUCTION_DOMAIN = 'https://pay1.autonegocie.com';
        const fullCheckoutData = {
          chargeId: charge.id,
          checkoutUrl: `${PRODUCTION_DOMAIN}/checkout/${charge.id}`,
          linkId: charge.id,
          amount: charge.amount,
          payerName: charge.payer_name,
          description: charge.description || undefined,
          status: 'PENDENTE' as const
        };

        toast({
          title: "Cobrança criada com sucesso!",
          description: "Link de checkout sendo gerado em segundo plano.",
        });

        setCheckoutData(fullCheckoutData);
        setShowCheckoutModal(true);
        return;
      }

      toast({
        title: "Cobrança criada",
        description: "Cobrança registrada com sucesso!",
      });
      navigate('/charges');
      
    } catch (error: any) {
      console.error('[NewCharge] Erro ao criar cobrança:', error);
      const msg = error?.message || 'Erro desconhecido';
      const details = error?.details || error?.hint || '';
      const fullMsg = `${msg}${details ? ` (${details})` : ''}`;
      setError(fullMsg);
      toast({
        title: "Erro ao criar cobrança",
        description: fullMsg,
        variant: 'destructive'
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (authLoading) {
    return (
      <DashboardShell>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-bold text-ds-text-strong">Nova Cobrança</h1>
          <p className="text-ds-text-muted">Crie uma nova cobrança para seus clientes</p>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={handleSubmit(onSubmit, onValidationError)} className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Main Form */}
            <div className="lg:col-span-2 space-y-6">
              
              {/* ADMIN: Seletor de Empresa */}
              {isAdmin && companies.length > 0 && (
                <Card className="border-purple-200 dark:border-purple-800 bg-purple-50/30 dark:bg-purple-950/20">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-lg text-purple-800 dark:text-purple-200">
                      <Building2 className="h-5 w-5" />
                      Empresa Responsável
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Select
                      value={selectedCompanyId}
                      onValueChange={setSelectedCompanyId}
                      disabled={loadingCompanies}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Selecione a empresa" />
                      </SelectTrigger>
                      <SelectContent>
                        {companies.map((company) => (
                          <SelectItem key={company.id} value={company.id}>
                            {company.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-purple-600 dark:text-purple-400 mt-2">
                      Como administrador, você pode criar cobranças para qualquer empresa.
                    </p>
                  </CardContent>
                </Card>
              )}
              
              {/* Dados do Pagador */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <User className="h-5 w-5 text-primary" />
                    Dados do Pagador
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="payer_name">Nome Completo *</Label>
                      <Input
                        id="payer_name"
                        {...register("payer_name")}
                        placeholder="Nome do pagador"
                        className={errors.payer_name ? "border-destructive" : ""}
                      />
                      {errors.payer_name && (
                        <p className="text-sm text-destructive">{errors.payer_name.message}</p>
                      )}
                    </div>
                    
                    <div className="space-y-2">
                      <Label htmlFor="payer_email">Email *</Label>
                      <Input
                        id="payer_email"
                        type="email"
                        {...register("payer_email")}
                        placeholder="email@exemplo.com"
                        className={errors.payer_email ? "border-destructive" : ""}
                      />
                      {errors.payer_email && (
                        <p className="text-sm text-destructive">{errors.payer_email.message}</p>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="payer_phone">Telefone *</Label>
                      <Controller
                        name="payer_phone"
                        control={control}
                        render={({ field }) => (
                          <Input
                            {...field}
                            onChange={(e) => field.onChange(formatPhone(e.target.value))}
                            placeholder="(11) 99999-9999"
                            className={errors.payer_phone ? "border-destructive" : ""}
                          />
                        )}
                      />
                      {errors.payer_phone && (
                        <p className="text-sm text-destructive">{errors.payer_phone.message}</p>
                      )}
                    </div>
                    
                    <div className="space-y-2">
                      <Label htmlFor="payer_document">CPF/CNPJ *</Label>
                      <Controller
                        name="payer_document"
                        control={control}
                        render={({ field }) => (
                          <Input
                            {...field}
                            onChange={(e) => field.onChange(formatDocument(e.target.value))}
                            placeholder="000.000.000-00"
                            className={errors.payer_document ? "border-destructive" : ""}
                          />
                        )}
                      />
                      {errors.payer_document && (
                        <p className="text-sm text-destructive">{errors.payer_document.message}</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Dados da Cobrança */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Receipt className="h-5 w-5 text-primary" />
                    Dados da Cobrança
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="amount">Valor *</Label>
                      <Controller
                        name="amount"
                        control={control}
                        render={({ field }) => (
                          <Input
                            id="amount"
                            {...field}
                            onChange={(e) => field.onChange(formatCurrencyInput(e.target.value))}
                            placeholder="0,00"
                            className={errors.amount ? "border-destructive" : ""}
                          />
                        )}
                      />
                      {errors.amount && (
                        <p className="text-sm text-destructive">{errors.amount.message}</p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label>Método de Pagamento *</Label>
                      <Controller
                        name="payment_method"
                        control={control}
                        render={({ field }) => (
                          <RadioGroup
                            value={field.value}
                            onValueChange={field.onChange}
                            className="flex flex-wrap gap-4"
                          >
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem value="cartao" id="cartao" />
                              <Label htmlFor="cartao" className="flex items-center gap-1.5 cursor-pointer">
                                <CreditCard className="h-4 w-4" />
                                Cartão
                              </Label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem value="pix" id="pix" />
                              <Label htmlFor="pix" className="flex items-center gap-1.5 cursor-pointer">
                                <QrCode className="h-4 w-4" />
                                PIX
                              </Label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem value="cartao_pix" id="cartao_pix" />
                              <Label htmlFor="cartao_pix" className="flex items-center gap-1.5 cursor-pointer">
                                <CreditCard className="h-4 w-4" />
                                <span>+</span>
                                <QrCode className="h-4 w-4" />
                                Cartão + PIX
                              </Label>
                            </div>
                          </RadioGroup>
                        )}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="description">Descrição</Label>
                    <Textarea
                      id="description"
                      {...register("description")}
                      placeholder="Descrição da cobrança (opcional)"
                      rows={3}
                    />
                  </div>

                  {(watchPaymentMethod === "cartao" || watchPaymentMethod === "cartao_pix") && (
                    <div className="flex items-center space-x-2">
                      <Controller
                        name="mask_fee"
                        control={control}
                        render={({ field }) => (
                          <Checkbox
                            id="mask_fee"
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        )}
                      />
                      <Label htmlFor="mask_fee" className="text-sm cursor-pointer">
                        Ocultar taxa do pagador
                      </Label>
                    </div>
                  )}

                  {/* Split de valores para Cartão + PIX */}
                  {watchPaymentMethod === "cartao_pix" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg">
                      <div className="space-y-2">
                        <Label htmlFor="pix_amount">Valor PIX *</Label>
                        <Controller
                          name="pix_amount"
                          control={control}
                          render={({ field }) => (
                            <Input
                              id="pix_amount"
                              {...field}
                              onChange={(e) => field.onChange(formatCurrencyInput(e.target.value))}
                              placeholder="0,00"
                              className={errors.pix_amount ? "border-destructive" : ""}
                            />
                          )}
                        />
                        {errors.pix_amount && (
                          <p className="text-sm text-destructive">{errors.pix_amount.message}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="card_amount">Valor Cartão *</Label>
                        <Controller
                          name="card_amount"
                          control={control}
                          render={({ field }) => (
                            <Input
                              id="card_amount"
                              {...field}
                              onChange={(e) => field.onChange(formatCurrencyInput(e.target.value))}
                              placeholder="0,00"
                              className={errors.card_amount ? "border-destructive" : ""}
                            />
                          )}
                        />
                        {errors.card_amount && (
                          <p className="text-sm text-destructive">{errors.card_amount.message}</p>
                        )}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Linha Digitável do Boleto - Obrigatória para Cartão e Cartão+PIX */}
              {(watchPaymentMethod === "cartao" || watchPaymentMethod === "cartao_pix") && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <Banknote className="h-5 w-5 text-primary" />
                      Linha Digitável do Boleto *
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="boleto_linha_digitavel">Linha Digitável (47 dígitos) *</Label>
                      <Input
                        id="boleto_linha_digitavel"
                        {...register("boleto_linha_digitavel")}
                        placeholder="00000.00000 00000.000000 00000.000000 0 00000000000000"
                        className={errors.boleto_linha_digitavel ? "border-destructive" : ""}
                      />
                      {errors.boleto_linha_digitavel && (
                        <p className="text-sm text-destructive">{errors.boleto_linha_digitavel.message}</p>
                      )}
                      <p className="text-xs text-ds-text-muted">
                        A linha digitável será vinculada automaticamente após a autorização do cartão
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Linha Digitável para PIX - Opcional (apenas referência para admin) */}
              {watchPaymentMethod === "pix" && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <Banknote className="h-5 w-5 text-primary" />
                      Linha Digitável (Opcional)
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="boleto_linha_digitavel">Linha Digitável</Label>
                      <Input
                        id="boleto_linha_digitavel"
                        {...register("boleto_linha_digitavel")}
                        placeholder="00000.00000 00000.000000 00000.000000 0 00000000000000"
                      />
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Sidebar - Summary */}
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Calculator className="h-5 w-5 text-primary" />
                    Resumo
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-ds-text-muted">Valor</span>
                      <span className="font-medium">{watchAmount || 'R$ 0,00'}</span>
                    </div>
                    {watchPayerName && (
                      <div className="flex justify-between text-sm">
                        <span className="text-ds-text-muted">Pagador</span>
                        <span className="font-medium truncate ml-2">{watchPayerName}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-sm">
                      <span className="text-ds-text-muted">Método</span>
                      <span className="font-medium">
                        {watchPaymentMethod === 'pix' ? 'PIX' : 
                         watchPaymentMethod === 'cartao_pix' ? 'Cartão + PIX' : 'Cartão'}
                      </span>
                    </div>
                    {watchPaymentMethod === 'cartao_pix' && (
                      <>
                        <div className="flex justify-between text-sm">
                          <span className="text-ds-text-muted">Valor PIX</span>
                          <span className="font-medium">{watchPixAmount || 'R$ 0,00'}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-ds-text-muted">Valor Cartão</span>
                          <span className="font-medium">{watchCardAmount || 'R$ 0,00'}</span>
                        </div>
                      </>
                    )}
                    <div className="flex justify-between text-sm">
                      <span className="text-ds-text-muted">Tipo</span>
                      <span className="font-medium">Pontual</span>
                    </div>
                  </div>

                  <div className="pt-4 border-t space-y-2">
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={isLoading || settingsLoading}
                    >
                      {isLoading ? (loadingStage === 'generating' ? "Gerando link..." : "Criando cobrança...") : "Criar Cobrança"}
                    </Button>
                    
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      onClick={() => setShowSimulatorModal(true)}
                    >
                      <Calculator className="h-4 w-4 mr-2" />
                      Simular Pagamento
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </form>

        {/* Modals */}
        <SimulatorModal
          open={showSimulatorModal}
          onOpenChange={setShowSimulatorModal}
        />

        {showCheckoutModal && checkoutData && (
          <CheckoutSuccessModal
            open={showCheckoutModal}
            onOpenChange={(open) => {
              if (!open) {
                setShowCheckoutModal(false);
                navigate('/charges');
              }
            }}
            checkoutData={{
              chargeId: checkoutData.chargeId,
              checkoutUrl: checkoutData.checkoutUrl,
              amount: checkoutData.amount,
              payerName: checkoutData.payerName,
              description: checkoutData.description,
              status: checkoutData.status
            }}
          />
        )}
      </div>
    </DashboardShell>
  );
}
