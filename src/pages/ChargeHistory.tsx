import { useState, useEffect, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/integrations/firebase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ChargeRefundTimeline } from '@/components/ChargeRefundTimeline';
import { ChargeExecutions } from '@/components/ChargeExecutions';
import { CheckoutSuccessModal } from '@/components/CheckoutSuccessModal';
import { Loader2, Eye, RefreshCw, ExternalLink, Copy, Plus, List, Link2, User, Mail, Phone, Calendar as CalendarIcon, CreditCard, FileText, Filter, X, Search, AlertCircle, Info, ArrowLeft, QrCode, Wallet, TrendingUp, Percent, Building2, Download, FileSpreadsheet, Clock } from 'lucide-react';
import { useChargeLinks } from '@/hooks/useChargeLinks';
import { toast } from '@/hooks/use-toast';
import { format, formatDistanceToNow } from 'date-fns';
import { DashboardShell } from '@/components/dashboard/DashboardShell';
import { ptBR } from 'date-fns/locale';

// Intervalo de sincronização automática: 5 minutos
const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar as CalendarComponent } from '@/components/ui/calendar';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';

interface PaymentSplitInfo {
  id: string;
  method: string;
  amount_cents: number;
  display_amount_cents?: number;
  status: string;
  pix_paid_at?: string;
  pre_payment_key?: string;
  transaction_id?: string;
  processed_at?: string;
  order_index: number;
  installments?: number;
}

interface Company {
  id: string;
  name: string;
}

interface Charge {
  id: string;
  payer_name: string;
  payer_email: string;
  payer_phone: string;
  payer_document: string;
  amount: number;
  description: string;
  status: string;
  recurrence_type: string;
  has_boleto_link: boolean;
  created_at: string;
  next_charge_date: string | null;
  checkout_url?: string;
  checkout_link_id?: string;
  payment_method?: string;
  pix_amount?: number;
  card_amount?: number;
  fee_amount?: number;
  fee_percentage?: number;
  pre_payment_key?: string;
  boleto_linha_digitavel?: string;
  boleto_admin_linha_digitavel?: string;
  boleto_pix_cartao_linha_digitavel?: string;
  creditor_document?: string;
  creditor_name?: string;
  company_id?: string;
  company?: Company;
  status_locked_at?: string;
  metadata?: {
    link_boleto_error?: {
      message: string;
      attemptedAt: string;
      httpStatus?: number;
    };
  };
  executions: Array<{
    id: string;
    execution_date: string;
    status: string;
    payment_link_url: string | null;
  }>;
  splits?: PaymentSplitInfo[];
}

// ChargeFilters is now imported from the hook
import { useChargesQuery, DEFAULT_FILTERS, PAGE_SIZE, deduplicateSplits, CHARGES_SELECT } from '@/hooks/useChargesQuery';
import type { ChargeFilters } from '@/hooks/useChargesQuery';

// Helper functions
const getInitials = (name: string) => {
  return name
    .split(' ')
    .slice(0, 2)
    .map(n => n[0])
    .join('')
    .toUpperCase();
};

const formatPhone = (phone: string) => {
  const clean = phone.replace(/\D/g, '');
  if (clean.length === 11) {
    return `(${clean.slice(0,2)}) ${clean.slice(2,7)}-${clean.slice(7)}`;
  }
  return phone;
};

const formatDocument = (doc: string | null | undefined) => {
  if (!doc) return '-';
  const clean = doc.replace(/\D/g, '');
  if (clean.length === 11) {
    return clean.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  } else if (clean.length === 14) {
    return clean.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  }
  return doc;
};

const formatCurrency = (cents: number) => {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
};

// Função para calcular status computado baseado nos splits (para pagamentos combinados)
const getComputedStatus = (charge: Charge): string => {
  // Se o admin travou o status manualmente, respeitar sempre
  if (charge.status_locked_at) {
    return charge.status;
  }
  // Se não for pagamento combinado ou não tem splits, usar status do charge
  if (charge.payment_method !== 'cartao_pix' || !charge.splits || charge.splits.length === 0) {
    return charge.status;
  }

  const pixSplit = charge.splits.find(s => s.method === 'pix');
  const cardSplit = charge.splits.find(s => s.method === 'credit_card');

  // Verificar se cada split está pago - ÚNICA fonte de verdade: status === 'concluded'
  const pixPaid = pixSplit && (pixSplit.status === 'concluded' || pixSplit.pix_paid_at);
  // Para cartão: SOMENTE status === 'concluded' indica pagamento aprovado (não pre_payment_key)
  const cardPaid = cardSplit && cardSplit.status === 'concluded';

  // Ambos pagos → completed
  if (pixPaid && cardPaid) {
    return 'completed';
  }

  // Apenas um pago → partial
  if (pixPaid || cardPaid) {
    return 'partial';
  }

  // Nenhum pago → manter status original
  return charge.status;
};

const getModernStatusBadge = (status: string) => {
  const configs = {
    // Status básicos
    pending: { 
      label: 'Pendente', 
      variant: 'warning' as const
    },
    processing: { 
      label: 'Processando', 
      variant: 'info' as const
    },
    completed: { 
      label: 'Pago', 
      variant: 'success' as const
    },
    failed: { 
      label: 'Falhou', 
      variant: 'destructive' as const
    },
    cancelled: { 
      label: 'Cancelada', 
      variant: 'secondary' as const
    },
    // Status do fluxo Quita+ (StatusCode 1-9)
    pre_authorized: { 
      label: 'Pré-autorizado', 
      variant: 'info' as const
    },
    boleto_linked: { 
      label: 'Boleto Vinculado', 
      variant: 'success' as const
    },
    approved: { 
      label: 'Aprovado', 
      variant: 'success' as const
    },
    awaiting_validation: { 
      label: 'Aguardando PIN', 
      variant: 'warning' as const
    },
    validating: { 
      label: 'Em Análise de Risco', 
      variant: 'info' as const
    },
    payment_denied: { 
      label: 'Negado pelo Risco', 
      variant: 'destructive' as const
    },
    // NOVO: Status parcial para pagamentos combinados
    partial: {
      label: 'Parcialmente Pago',
      variant: 'warning' as const
    },
    // NOVO: StatusCode 50 - CNPJ não cadastrado
    cnpj_nao_cadastrado: {
      label: 'CNPJ não cadastrado',
      variant: 'destructive' as const
    },
    refunded: {
      label: 'Estornado',
      variant: 'destructive' as const
    },
  };
  
  const config = configs[status as keyof typeof configs] || configs.pending;
  return (
    <Badge variant={config.variant}>
      {config.label}
    </Badge>
  );
};

const getPaymentMethodBadge = (method: string) => {
  const configs = {
    cartao: { label: 'Cartão', variant: 'info' as const },
    cartao_pix: { label: 'PIX + Cartão', variant: 'default' as const },
    pix: { label: 'PIX', variant: 'success' as const },
    boleto: { label: 'Boleto', variant: 'warning' as const },
  };
  const config = configs[method as keyof typeof configs] || configs.cartao;
  return <Badge variant={config.variant}>{config.label}</Badge>;
};

// Componente para exibir os métodos de pagamento (splits) com breakdown de taxas
const PaymentMethodsSummary = ({ charge, isAdmin }: { charge: Charge; isAdmin: boolean }) => {
  const splits = charge.splits || [];
  
  const pixSplit = splits.find(s => s.method === 'pix');
  const cardSplit = splits.find(s => s.method === 'credit_card');

  // ✅ STATUS ÚNICO: usar getComputedStatus como fonte da verdade para exibição
  const displayStatus = getComputedStatus(charge);
  const isTerminalStatus = ['cancelled', 'failed', 'payment_denied'].includes(displayStatus);
  const isCompleted = displayStatus === 'completed';
  const isPartial = displayStatus === 'partial';

  // Cálculos para PIX - sempre calcular 1.5% de taxa
  const PIX_FEE_RATE = 0.015; // 1.5%
  
  // Lógica corrigida para calcular taxa PIX:
  // - Se display_amount_cents existe: display_amount_cents = total com taxa, amount_cents = base
  // - Se apenas amount_cents existe: amount_cents JÁ inclui taxa, reverter para obter base
  // - Se nenhum split: calcular a partir do charge
  let pixBase: number;
  let pixTotal: number;
  let pixFee: number;
  let pixFeePercent: string;
  
  if (pixSplit?.display_amount_cents) {
    // Cenário ideal: ambos campos preenchidos corretamente
    pixTotal = pixSplit.display_amount_cents;
    pixBase = pixSplit.amount_cents;
    pixFee = pixTotal - pixBase;
    pixFeePercent = pixBase > 0 ? ((pixFee / pixBase) * 100).toFixed(1) : '1.5';
  } else if (pixSplit?.amount_cents) {
    // Cenário legado: apenas amount_cents existe e JÁ inclui taxa
    // Reverter: base = total / 1.015
    pixTotal = pixSplit.amount_cents;
    pixBase = Math.round(pixTotal / (1 + PIX_FEE_RATE));
    pixFee = pixTotal - pixBase;
    pixFeePercent = pixBase > 0 ? ((pixFee / pixBase) * 100).toFixed(1) : '1.5';
  } else {
    // Sem split: calcular a partir do charge
    // Para PIX avulso: amount é o valor base (original da dívida), fee_amount é a taxa
    if (charge.payment_method === 'pix' && charge.fee_amount) {
      pixBase = charge.amount;  // Valor original (sem taxa)
      pixFee = charge.fee_amount;
      pixTotal = charge.amount + charge.fee_amount;  // Valor com taxa
      pixFeePercent = charge.fee_percentage?.toFixed(1) || '1.5';
    } else {
      pixBase = charge.pix_amount || (charge.payment_method === 'pix' ? charge.amount : 0);
      pixFee = Math.round(pixBase * PIX_FEE_RATE);
      pixTotal = pixBase + pixFee;
      pixFeePercent = '1.5';
    }
  }

  // Cálculos para Cartão - usar valores do split diretamente
  // amount_cents = valor original sem juros; display_amount_cents = valor com juros
  const cardBase = cardSplit?.amount_cents || 0;
  const cardTotalWithInterest = cardSplit?.display_amount_cents || cardSplit?.amount_cents || 0;
  const cardTotal = cardTotalWithInterest;
  const cardFeeAmount = cardTotalWithInterest - cardBase;
  const cardFee = cardFeeAmount;
  const cardFeePercent = cardBase > 0 && cardFeeAmount > 0 
    ? ((cardFeeAmount / cardBase) * 100).toFixed(1) 
    : '0';

  // ✅ Badge usa o displayStatus computado (igual ao topo) quando terminal
  const getUnifiedStatusBadge = (splitMethod: 'pix' | 'card') => {
    // Se status terminal, mostrar o mesmo badge do topo
    if (isTerminalStatus) {
      if (displayStatus === 'cancelled') return <Badge variant="secondary" className="text-xs">✗ Cancelado</Badge>;
      if (displayStatus === 'failed') return <Badge variant="destructive" className="text-xs">✗ Falhou</Badge>;
      if (displayStatus === 'payment_denied') return <Badge variant="destructive" className="text-xs">✗ Negado</Badge>;
    }
    
    // Se completado, todos os splits estão pagos
    if (isCompleted) {
      return <Badge variant="success" className="text-xs">✓ Pago</Badge>;
    }
    
    // Se parcial, verificar individual do split
    if (isPartial) {
      const split = splitMethod === 'pix' ? pixSplit : cardSplit;
      if (split) {
        const isPaid = split.status === 'concluded' || (splitMethod === 'pix' && split.pix_paid_at);
        if (isPaid) return <Badge variant="success" className="text-xs">✓ Pago</Badge>;
      }
    }
    
    return <Badge variant="warning" className="text-xs">⏳ Pendente</Badge>;
  };

  // Verificar se o split está efetivamente pago (para cálculos de totais)
  const isSplitPaid = (split: PaymentSplitInfo | undefined, isPix: boolean): boolean => {
    // Se terminal, nada está "pago" para fins de exibição
    if (isTerminalStatus) return false;
    if (!split) return false;
    if (isPix) {
      return split.status === 'concluded' || !!split.pix_paid_at;
    }
    return split.status === 'concluded';
  };

  // Se não há splits e não é pagamento combinado nem PIX avulso
  if (splits.length === 0 && charge.payment_method !== 'cartao_pix' && charge.payment_method !== 'pix') {
    return null;
  }

  const hasPix = pixSplit || charge.payment_method === 'pix' || (charge.payment_method === 'cartao_pix' && pixBase > 0);
  const hasCard = cardSplit || (charge.payment_method === 'cartao_pix' && cardBase > 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-ds-text-strong">
        <Wallet className="h-4 w-4" />
        Métodos de Pagamento
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* PIX Card */}
        {hasPix && (
          <div className="p-4 bg-green-500/5 rounded-card border border-green-500/10">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-green-500/10">
                  <QrCode className="h-4 w-4 text-green-600" />
                </div>
                <span className="font-medium text-green-700">PIX</span>
              </div>
              {getUnifiedStatusBadge('pix')}
            </div>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between text-ds-text-muted">
                <span>Valor original:</span>
                <span>{formatCurrency(pixBase)}</span>
              </div>
              {isAdmin && (
                <div className="flex justify-between text-green-600">
                  <span>Taxa PIX ({pixFeePercent}%):</span>
                  <span>{pixFee > 0 ? `+ ${formatCurrency(pixFee)}` : 'R$ 0,00'}</span>
                </div>
              )}
              <div className="border-t border-green-500/10 pt-1.5 mt-1.5">
                <div className={`flex justify-between font-semibold ${isSplitPaid(pixSplit, true) ? 'text-green-700' : 'text-amber-600'}`}>
                  <span>{isSplitPaid(pixSplit, true) ? 'Total pago:' : 'Valor:'}</span>
                  <span>{formatCurrency(pixTotal)}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Card Card */}
        {hasCard && (
          <div className="p-4 bg-blue-500/5 rounded-card border border-blue-500/10">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-blue-500/10">
                  <CreditCard className="h-4 w-4 text-blue-600" />
                </div>
                <span className="font-medium text-blue-700">
                  Cartão {cardSplit?.installments && cardSplit.installments > 1 ? `(${cardSplit.installments}x)` : ''}
                </span>
              </div>
              {getUnifiedStatusBadge('card')}
            </div>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between text-ds-text-muted">
                <span>Valor original:</span>
                <span>{formatCurrency(cardBase)}</span>
              </div>
              {isAdmin && (
                <div className="flex justify-between text-blue-600">
                  <span>Juros {cardSplit?.installments && cardSplit.installments > 1 ? `(${cardSplit.installments}x)` : ''} ({cardFeePercent}%):</span>
                  <span>{cardFee > 0 ? `+ ${formatCurrency(cardFee)}` : 'R$ 0,00'}</span>
                </div>
              )}
              <div className="border-t border-blue-500/10 pt-1.5 mt-1.5">
                <div className={`flex justify-between font-semibold ${isSplitPaid(cardSplit, false) ? 'text-blue-700' : 'text-amber-600'}`}>
                  <span>{isSplitPaid(cardSplit, false) ? 'Total pago:' : 'Valor:'}</span>
                  <span>{formatCurrency(cardTotal)}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Total Geral - só somar o que foi efetivamente pago */}
      {hasPix && hasCard && !isTerminalStatus && (() => {
        const pixPaid = isSplitPaid(pixSplit, true);
        const cardPaid = isSplitPaid(cardSplit, false);
        const totalPaid = (pixPaid ? pixTotal : 0) + (cardPaid ? cardTotal : 0);
        const totalPending = (!pixPaid ? pixTotal : 0) + (!cardPaid ? cardTotal : 0);
        
        return (
          <div className="space-y-2">
            {totalPaid > 0 && (
              <div className="p-3 bg-green-500/5 rounded-card border border-green-500/20 flex justify-between items-center">
                <div className="flex items-center gap-2 text-green-700">
                  <TrendingUp className="h-4 w-4" />
                  <span className="text-sm font-medium">Total pago pelo cliente:</span>
                </div>
                <span className="text-lg font-bold text-green-700">
                  {formatCurrency(totalPaid)}
                </span>
              </div>
            )}
            {totalPending > 0 && (
              <div className="p-3 bg-amber-500/5 rounded-card border border-amber-500/20 flex justify-between items-center">
                <div className="flex items-center gap-2 text-amber-700">
                  <TrendingUp className="h-4 w-4" />
                  <span className="text-sm font-medium">Valor pendente:</span>
                </div>
                <span className="text-lg font-bold text-amber-700">
                  {formatCurrency(totalPending)}
                </span>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
};

// InfoCard Component
interface InfoCardProps {
  icon: React.ElementType;
  label: string;
  value: string;
  subvalue?: string;
  variant?: 'default' | 'primary' | 'success' | 'info';
}

const InfoCard = ({ icon: Icon, label, value, subvalue, variant = 'default' }: InfoCardProps) => {
  const variants = {
    default: 'bg-ds-bg-surface-alt border-ds-border-subtle',
    primary: 'bg-primary/5 border-primary/10',
    success: 'bg-green-500/5 border-green-500/10',
    info: 'bg-blue-500/5 border-blue-500/10',
  };
  
  const iconVariants = {
    default: 'bg-ds-bg-surface text-ds-text-muted',
    primary: 'bg-primary/10 text-primary',
    success: 'bg-green-500/10 text-green-600',
    info: 'bg-blue-500/10 text-blue-600',
  };

  return (
    <div className={cn("flex items-start gap-3 p-4 rounded-card border", variants[variant])}>
      <div className={cn("p-2.5 rounded-lg", iconVariants[variant])}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-ds-text-muted uppercase tracking-wider mb-1">
          {label}
        </p>
        <p className="text-base font-semibold text-ds-text-strong truncate">{value}</p>
        {subvalue && (
          <p className="text-xs text-ds-text-muted mt-0.5">{subvalue}</p>
        )}
      </div>
    </div>
  );
};

// Skeleton Component
// Skeleton para a lista de cobranças (formato tabela)
const ChargeListSkeleton = () => (
  <TableRow>
    <TableCell>
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-9 rounded-full" />
        <div className="space-y-1">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
    </TableCell>
    <TableCell><Skeleton className="h-4 w-28" /></TableCell>
    <TableCell><Skeleton className="h-4 w-20 ml-auto" /></TableCell>
    <TableCell><Skeleton className="h-5 w-20 rounded-full" /></TableCell>
    <TableCell><Skeleton className="h-5 w-16 rounded-full" /></TableCell>
    <TableCell className="hidden lg:table-cell"><Skeleton className="h-4 w-16" /></TableCell>
    <TableCell><Skeleton className="h-8 w-20 ml-auto rounded-full" /></TableCell>
  </TableRow>
);

// Componente de linha da tabela para cada cobrança
interface ChargeListRowProps {
  charge: Charge;
  onViewDetails: () => void;
  isAdmin: boolean;
}

const ChargeListRow = ({ charge, onViewDetails, isAdmin }: ChargeListRowProps) => {
  const computedStatus = getComputedStatus(charge);
  
  return (
    <TableRow 
      className="group hover:bg-ds-bg-surface-alt/50 cursor-pointer transition-colors"
      onClick={onViewDetails}
    >
      {/* Cliente (Avatar + Nome + Empresa para admin) */}
      <TableCell>
        <div className="flex items-center gap-3">
          <Avatar className="h-9 w-9 border border-ds-border-subtle">
            <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
              {getInitials(charge.payer_name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 max-w-[220px]">
            <p className="font-medium text-ds-text-strong whitespace-normal break-words leading-tight">
              {charge.payer_name}
            </p>
            {isAdmin && charge.company && (
              <p className="text-xs text-ds-text-muted whitespace-normal break-words mt-0.5">
                {charge.company.name}
              </p>
            )}
          </div>
        </div>
      </TableCell>
      
      {/* CPF/CNPJ */}
      <TableCell className="text-ds-text-muted text-sm hidden md:table-cell">
        {formatDocument(charge.payer_document)}
      </TableCell>
      
      {/* Valor */}
      <TableCell className="text-right font-semibold text-ds-text-strong">
        {formatCurrency(charge.amount
        )}
      </TableCell>
      
      {/* Tipo de Pagamento */}
      <TableCell className="hidden sm:table-cell">
        {charge.payment_method && getPaymentMethodBadge(charge.payment_method)}
      </TableCell>
      
      {/* Status */}
      <TableCell>
        {getModernStatusBadge(computedStatus)}
      </TableCell>
      
      {/* Data (hidden em telas menores) */}
      <TableCell className="hidden lg:table-cell text-ds-text-muted text-sm">
        {format(new Date(charge.created_at), 'dd/MM/yy', { locale: ptBR })}
      </TableCell>
      
      {/* Ação */}
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onViewDetails();
          }}
          className="opacity-70 group-hover:opacity-100 transition-opacity"
        >
          <Eye className="h-4 w-4" />
          <span className="hidden sm:inline ml-1.5">Detalhes</span>
        </Button>
      </TableCell>
    </TableRow>
  );
};

// Executions Dialog Component
const ExecutionsDialogContent = ({ 
  executionsDialog, 
  setExecutionsDialog, 
  openPaymentLink, 
  copyToClipboard 
}: any) => {
  const { getChargeExecutions } = useChargeLinks();
  const executionsQuery = getChargeExecutions(executionsDialog.chargeId);

  return (
    <Dialog open={executionsDialog.open} onOpenChange={(open) => setExecutionsDialog((prev: any) => ({ ...prev, open }))}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Execuções - {executionsDialog.chargeName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {executionsQuery.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : executionsQuery.data && executionsQuery.data.length > 0 ? (
            <div className="space-y-2">
              {executionsQuery.data.map((execution: any) => (
                <div key={execution.id} className="flex items-center justify-between p-4 border border-ds-border-subtle rounded-card bg-ds-bg-surface">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      {getModernStatusBadge(execution.status)}
                      <span className="font-medium text-ds-text-strong">
                        {execution.scheduled_for ? 
                          format(new Date(execution.scheduled_for), 'dd/MM/yyyy HH:mm', { locale: ptBR }) :
                          format(new Date(execution.execution_date), 'dd/MM/yyyy HH:mm', { locale: ptBR })
                        }
                      </span>
                    </div>
                    {execution.last_error && (
                      <p className="text-sm text-destructive">Erro: {execution.last_error}</p>
                    )}
                  </div>
                  {execution.status === 'READY' && execution.payment_link_id && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const baseUrl = window.location.origin;
                          const url = `${baseUrl}/payment?execution=${execution.id}`;
                          openPaymentLink(url);
                        }}
                      >
                        <ExternalLink className="w-4 h-4 mr-1" />
                        Abrir
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const baseUrl = window.location.origin;
                          const url = `${baseUrl}/payment?execution=${execution.id}`;
                          copyToClipboard(url);
                        }}
                      >
                        <Copy className="w-4 h-4 mr-1" />
                        Copiar
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-ds-text-muted">
              Nenhuma execução encontrada para esta cobrança.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default function ChargeHistory() {
  const { isOperador, isAdmin, profile } = useAuth();
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [selectedCharge, setSelectedCharge] = useState<Charge | null>(null);
  const [executionsDialog, setExecutionsDialog] = useState<{ open: boolean; chargeId: string; chargeName: string }>({
    open: false,
    chargeId: '',
    chargeName: ''
  });
  
  // Companies list for admin filter
  const [companies, setCompanies] = useState<Company[]>([]);
  
  // Estado para vinculação manual de boleto (admin)
  const [adminLinhaDigitavel, setAdminLinhaDigitavel] = useState('');
  const [linkingBoleto, setLinkingBoleto] = useState(false);
  
  // Estado para alteração de empresa (admin)
  const [editingCompany, setEditingCompany] = useState(false);
  const [newCompanyId, setNewCompanyId] = useState('');
  const [changingCompany, setChangingCompany] = useState(false);
   
   // Estado para alteração manual de status (admin)
   const [editingStatus, setEditingStatus] = useState(false);
   const [newManualStatus, setNewManualStatus] = useState('');
   const [savingStatus, setSavingStatus] = useState(false);

   // Estado para alteração de tipo de pagamento (admin)
   const [editingPaymentMethod, setEditingPaymentMethod] = useState(false);
   const [newPaymentMethod, setNewPaymentMethod] = useState('');
   const [savingPaymentMethod, setSavingPaymentMethod] = useState(false);
  
  // Filter state — default = mês corrente
  const [filters, setFilters] = useState<ChargeFilters>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  
  // Pagination
  const [page, setPage] = useState(0);
  
  // React Query
  const { data: queryData, isLoading: loading, isFetching } = useChargesQuery(filters, page);
  const totalCount = queryData?.totalCount ?? 0;
  const hasMore = queryData?.hasMore ?? false;
  
  // Accumulate pages for "load more" pattern
  const [accumulatedCharges, setAccumulatedCharges] = useState<Charge[]>([]);
  
  useEffect(() => {
    if (queryData?.charges) {
      if (page === 0) {
        setAccumulatedCharges(queryData.charges as Charge[]);
      } else {
        setAccumulatedCharges(prev => {
          const existingIds = new Set(prev.map(c => c.id));
          const newCharges = (queryData.charges as Charge[]).filter(c => !existingIds.has(c.id));
          return [...prev, ...newCharges];
        });
      }
    }
  }, [queryData, page]);
  
  // For backward compat: filteredCharges = accumulated charges (filtering is server-side now)
  const charges = accumulatedCharges;
  const filteredCharges = accumulatedCharges;
  
  // Checkout modal state
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  const [checkoutModalData, setCheckoutModalData] = useState<any>(null);
  
  // Estado para última sincronização
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const autoSyncRef = useRef<NodeJS.Timeout | null>(null);
  
  const {
    copyToClipboard,
    openPaymentLink
  } = useChargeLinks();

  const fetchCompanies = async () => {
    if (!isAdmin) return;
    
    try {
      const { data, error } = await db
        .from('companies')
        .select('id, name')
        .eq('is_active', true)
        .order('name');

      if (!error && data) {
        setCompanies(data);
      }
    } catch (error) {
      console.error('Error loading companies:', error);
    }
  };

  // Invalidar cache do React Query (substitui refreshSpecificCharges)
  const invalidateCharges = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['charges'] });
  }, [queryClient]);

  // Função de sincronização com API (manual ou automática) - SEM REFRESH DE TELA
  const syncPaymentStatuses = useCallback(async (isAutoSync = false) => {
    setSyncing(true);
    try {
      // Executar sincronizações em paralelo
      const [paymentResult, pixResult, cardResult] = await Promise.allSettled([
        db.functions.invoke('sync-payment-status'),
        db.functions.invoke('sync-mercadopago-status'), // AbacatePay legado — substituir por sync-treeal-status quando criado
        db.functions.invoke('sync-card-status'),
      ]);

      // Coletar IDs de charges que foram atualizados
      const updatedChargeIds = new Set<string>();

      // Extrair IDs do sync-payment-status
      if (paymentResult.status === 'fulfilled' && paymentResult.value.data?.results) {
        paymentResult.value.data.results.forEach((r: any) => {
          if (r.updated && r.chargeId) updatedChargeIds.add(r.chargeId);
        });
      }

      // Extrair IDs do sync-mercadopago-status (AbacatePay legado)
      if (pixResult.status === 'fulfilled' && pixResult.value.data?.updatedChargeIds) {
        pixResult.value.data.updatedChargeIds.forEach((id: string) => updatedChargeIds.add(id));
      }

      // Extrair IDs do sync-card-status
      if (cardResult.status === 'fulfilled' && cardResult.value.data?.updatedChargeIds) {
        cardResult.value.data.updatedChargeIds.forEach((id: string) => updatedChargeIds.add(id));
      }

      // Se houve atualizações, buscar APENAS esses registros (sem setLoading)
      if (updatedChargeIds.size > 0) {
        invalidateCharges();

        if (!isAutoSync) {
          toast({
            title: "Sincronização concluída",
            description: `${updatedChargeIds.size} cobrança(s) atualizada(s).`,
          });
        }
        // Sincronização automática: sem toast (apenas log no console)
      } else if (!isAutoSync) {
        toast({
          title: "Sincronização concluída",
          description: "Nenhuma atualização necessária.",
        });
      }

      setLastSync(new Date());
      console.log(`[ChargeHistory] Sincronização ${isAutoSync ? 'automática' : 'manual'}: ${updatedChargeIds.size} charges atualizadas`);

    } catch (err) {
      console.error('Erro ao sincronizar:', err);
      if (!isAutoSync) {
        toast({
          title: "Erro",
          description: "Falha na comunicação com o servidor.",
          variant: "destructive",
        });
      }
    } finally {
      setSyncing(false);
      // Invalidação via React Query (sem reload completo)
    }
  }, [invalidateCharges]);

  // Verificar se há cobranças pendentes que precisam de sincronização
  const hasPendingCharges = useCallback(() => {
    const pendingStatuses = ['pending', 'pre_authorized', 'processing', 'validating', 'boleto_linked', 'awaiting_validation'];
    return charges.some(c => pendingStatuses.includes(c.status));
  }, [charges]);

  const clearFilters = () => {
    setFilters(DEFAULT_FILTERS);
    setPage(0);
  };

  const hasActiveFilters = () => {
    return filters.status !== 'all' || 
           filters.payment_method !== 'all' || 
           filters.date_to !== undefined || 
           filters.payer_document !== '' ||
           (isAdmin && filters.company_id !== 'all');
  };

  const processCharge = async (chargeId: string) => {
    try {
      const { data, error } = await db.functions.invoke('process-charge', {
        body: { chargeId, immediate: true }
      });

      if (error) throw error;

      toast({
        title: "✓ Cobrança processada",
        description: "A cobrança foi processada com sucesso",
      });

      invalidateCharges();
    } catch (error: any) {
      toast({
        title: "Erro ao processar cobrança",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleRetryLinkBoleto = async (charge: Charge) => {
    if (!charge.pre_payment_key || !charge.boleto_linha_digitavel) {
      toast({
        title: "Erro",
        description: "Dados insuficientes para vincular boleto.",
        variant: "destructive",
      });
      return;
    }

    try {
      toast({ title: "Verificando status...", description: "Aguarde..." });
      
      // ✅ PRIMEIRO: Verificar status atual na API Cappta
      const { data: statusData } = await db.functions.invoke('quitaplus-prepayment-status', {
        body: { prePaymentKey: charge.pre_payment_key }
      });

      console.log('[ChargeHistory] Status da API Cappta:', statusData);

      // Se já está LINKED, atualizar DB e não tentar vincular novamente
      if (statusData?.success && statusData?.status === 'LINKED') {
        toast({
          title: "✅ Já vinculado!",
          description: "O boleto já foi vinculado com sucesso na API.",
        });
        
        // Atualizar status no banco
        await db.from('charges')
          .update({ 
            status: 'boleto_linked',
            boleto_linked_at: new Date().toISOString(),
            metadata: { ...charge.metadata, link_boleto_error: null }
          })
          .eq('id', charge.id);
          
        invalidateCharges();
        return;
      }

      // Se não está AUTHORIZED, não pode vincular
      if (statusData?.success && statusData?.status !== 'AUTHORIZED') {
        toast({
          title: "Status inválido",
          description: `Status atual: ${statusData?.status}. Não é possível vincular.`,
          variant: "destructive",
        });
        return;
      }

      // ✅ SEGUNDO: Tentar vincular boleto
      toast({ title: "Vinculando boleto...", description: "Aguarde..." });
      
      const { data, error } = await db.functions.invoke('quitaplus-link-boleto', {
        body: {
          prePaymentKey: charge.pre_payment_key,
          paymentLinkId: charge.id,
          boleto: {
            number: charge.boleto_linha_digitavel.replace(/\D/g, ''),
            creditorDocument: charge.creditor_document?.replace(/\D/g, '') || '',
            creditorName: charge.creditor_name || '',
          },
        },
      });

      if (error || data?.error) {
        const errorMessage = error?.message || data?.message || data?.error || 'Erro desconhecido';
        toast({
          title: "Erro ao vincular",
          description: errorMessage,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Sucesso!",
          description: "Boleto vinculado com sucesso.",
        });
        
        // Atualizar status da charge para boleto_linked e limpar erro
        await db.from('charges')
          .update({ 
            status: 'boleto_linked',
            boleto_linked_at: new Date().toISOString(),
            metadata: { ...charge.metadata, link_boleto_error: null }
          })
          .eq('id', charge.id);
          
        invalidateCharges(); // Recarregar lista
      }
    } catch (err) {
      console.error('Erro ao tentar vincular boleto:', err);
      toast({
        title: "Erro inesperado",
        description: "Falha ao vincular boleto. Tente novamente.",
        variant: "destructive",
      });
    }
  };

  const handleViewExecutions = (chargeId: string, chargeName: string) => {
    setExecutionsDialog({ open: true, chargeId, chargeName });
  };

  // Função para admin vincular boleto manualmente
  const handleAdminLinkBoleto = async (charge: Charge) => {
    if (!adminLinhaDigitavel.trim()) {
      toast({
        title: "Erro",
        description: "Informe a linha digitável do boleto.",
        variant: "destructive",
      });
      return;
    }

    const sanitized = adminLinhaDigitavel.replace(/\D/g, '');
    if (sanitized.length < 47 || sanitized.length > 48) {
      toast({
        title: "Linha digitável inválida",
        description: "A linha digitável deve ter 47 ou 48 dígitos.",
        variant: "destructive",
      });
      return;
    }

    setLinkingBoleto(true);
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT')), 20000)
      );

      const invokePromise = db.functions.invoke('admin-link-boleto', {
        body: {
          chargeId: charge.id,
          linhaDigitavel: sanitized,
        },
      });

      const { data, error } = await Promise.race([invokePromise, timeoutPromise]);

      if (error) {
        const errorMsg = error?.message || 'Erro desconhecido';
        toast({
          title: "Erro ao vincular boleto",
          description: errorMsg,
          variant: "destructive",
        });
        return;
      }

      if (data && data.success === false) {
        toast({
          title: data.error || "Erro ao vincular boleto",
          description: data.message || 'Erro desconhecido',
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "✓ Boleto vinculado!",
        description: "O boleto foi vinculado com sucesso ao pagamento.",
      });

      setAdminLinhaDigitavel('');
      setSelectedCharge(null);
      await invalidateCharges();
    } catch (err: any) {
      console.error('Erro ao vincular boleto:', err);
      const isTimeout = err?.message === 'TIMEOUT';
      toast({
        title: isTimeout ? "Tempo esgotado" : "Erro inesperado",
        description: isTimeout
          ? "A operação demorou demais (>20s). Tente novamente em alguns instantes."
          : "Falha ao vincular boleto. Tente novamente.",
        variant: "destructive",
      });
    } finally {
      setLinkingBoleto(false);
    }
  };

  const CheckoutButtons = ({ charge }: { charge: Charge }) => {
    const { generateLink, isGenerating } = useChargeLinks();
    const isCompleted = charge.status === 'completed';
    const hasLink = !!charge.checkout_url;

    const handleGenerateLink = async () => {
      try {
        const newLink = await generateLink(charge.id);
        if (newLink?.url) {
          // Atualizar o charge localmente para refletir o novo link
          invalidateCharges();
          const event = new CustomEvent('openCheckoutModal', {
            detail: {
              checkoutUrl: newLink.url,
              linkId: newLink.linkId,
              chargeId: charge.id,
              amount: charge.amount,
              payerName: charge.payer_name,
              description: charge.description
            }
          });
          window.dispatchEvent(event);
        }
      } catch (error) {
        console.error('Error generating link:', error);
      }
    };

    if (!hasLink) {
      return (
        <div className="space-y-3">
          {isCompleted && (
            <div className="flex items-center gap-2 text-sm text-green-600">
              <Info className="h-4 w-4" />
              <span>Pagamento já concluído</span>
            </div>
          )}
          {!isCompleted && (
            <div className="flex items-center gap-2 text-sm text-ds-text-muted">
              <AlertCircle className="h-4 w-4" />
              <span>Link de pagamento indisponível</span>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button 
              onClick={handleGenerateLink} 
              size="sm"
              disabled={isGenerating || isCompleted}
              className="gap-2"
            >
              {isGenerating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="h-4 w-4" />
              )}
              Gerar Novo Link
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => openPaymentLink(charge.checkout_url!)}
          className="gap-2"
        >
          <ExternalLink className="h-4 w-4" />
          Abrir Link
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => copyToClipboard(charge.checkout_url!)}
          className="gap-2"
        >
          <Copy className="h-4 w-4" />
          Copiar
        </Button>
      </div>
    );
  };

  useEffect(() => {
    fetchCompanies();
    
    const handleOpenCheckoutModal = (event: CustomEvent) => {
      setCheckoutModalData(event.detail);
      setShowCheckoutModal(true);
    };
    
    window.addEventListener('openCheckoutModal', handleOpenCheckoutModal as EventListener);
    return () => window.removeEventListener('openCheckoutModal', handleOpenCheckoutModal as EventListener);
  }, [profile?.company_id]);

  // Polling automático: sincronizar a cada 5 minutos se houver cobranças pendentes
  useEffect(() => {
    // Sincronização inicial ao carregar a página (se houver cobranças pendentes)
    const initialSyncTimeout = setTimeout(() => {
      if (hasPendingCharges() && !syncing) {
        console.log('[ChargeHistory] Sincronização inicial...');
        syncPaymentStatuses(true);
      }
    }, 10000); // Aguardar 10s para a UI estabilizar antes de sincronizar

    // Configurar intervalo de sincronização automática
    autoSyncRef.current = setInterval(() => {
      if (hasPendingCharges() && !syncing) {
        console.log('[ChargeHistory] Sincronização automática (5 min)...');
        syncPaymentStatuses(true);
      }
    }, AUTO_SYNC_INTERVAL_MS);

    return () => {
      clearTimeout(initialSyncTimeout);
      if (autoSyncRef.current) {
        clearInterval(autoSyncRef.current);
      }
    };
  }, [hasPendingCharges, syncing, syncPaymentStatuses]);
  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [filters]);

  // Export helper functions
  const getPaymentMethodLabel = (method: string | undefined) => {
    switch (method) {
      case 'cartao': return 'Cartão';
      case 'pix': return 'PIX';
      case 'cartao_pix': return 'PIX + Cartão';
      default: return method || '-';
    }
  };

  const getStatusLabel = (status: string) => {
    const labels: Record<string, string> = {
      pending: 'Pendente',
      processing: 'Processando',
      completed: 'Concluído',
      failed: 'Falhou',
      cancelled: 'Cancelado',
      pre_authorized: 'Pré-autorizado',
      boleto_linked: 'Boleto Vinculado',
      approved: 'Aprovado',
      awaiting_validation: 'Aguardando Validação',
      validating: 'Validando',
      payment_denied: 'Pagamento Negado'
    };
    return labels[status] || status;
  };

  const downloadFile = (content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const generateExportData = () => {
    const headers = [
      'ID', 'Data Criação', 'Pagador', 'Email', 'Telefone', 'CPF/CNPJ',
      'Valor (R$)', 'Valor Original PIX (R$)', 'Valor Original Cartão (R$)',
      'Descrição', 'Método Pagamento', 'Status', 'Empresa'
    ];

    const rows = filteredCharges.map(charge => {
      const pixSplit = charge.splits?.find((s: any) => s.method === 'pix');
      const cardSplit = charge.splits?.find((s: any) => s.method === 'credit_card');

      return [
        charge.id,
        format(new Date(charge.created_at), 'dd/MM/yyyy HH:mm', { locale: ptBR }),
        charge.payer_name,
        charge.payer_email,
        formatPhone(charge.payer_phone),
        charge.payer_document,
        (charge.amount / 100).toFixed(2).replace('.', ','),
        pixSplit ? (pixSplit.amount_cents / 100).toFixed(2).replace('.', ',') : '-',
        cardSplit ? (cardSplit.amount_cents / 100).toFixed(2).replace('.', ',') : '-',
        charge.description || '',
        getPaymentMethodLabel(charge.payment_method),
        getStatusLabel(charge.status),
        charge.company?.name || ''
      ];
    });

    return { headers, rows };
  };

  const exportToCSV = () => {
    const { headers, rows } = generateExportData();
    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(';'))
      .join('\n');
    
    const timestamp = format(new Date(), 'yyyy-MM-dd_HH-mm');
    downloadFile('\uFEFF' + csvContent, `cobrancas_${timestamp}.csv`, 'text/csv;charset=utf-8');
    toast({ title: 'Exportação concluída', description: `${filteredCharges.length} cobranças exportadas para CSV` });
  };

  const exportToExcel = () => {
    const { headers, rows } = generateExportData();
    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join('\t'))
      .join('\n');
    
    const timestamp = format(new Date(), 'yyyy-MM-dd_HH-mm');
    downloadFile('\uFEFF' + csvContent, `cobrancas_${timestamp}.xls`, 'application/vnd.ms-excel;charset=utf-8');
    toast({ title: 'Exportação concluída', description: `${filteredCharges.length} cobranças exportadas para Excel` });
  };

  return (
    <DashboardShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-ds-text-strong">Histórico de Cobranças</h1>
              <div className="flex items-center gap-3">
                <p className="text-ds-text-muted">Gerencie e acompanhe todas as suas cobranças</p>
                {lastSync && (
                  <span className="text-xs text-ds-text-muted flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Última sync: {formatDistanceToNow(lastSync, { locale: ptBR, addSuffix: true })}
                  </span>
                )}
              </div>
            </div>
            {isAdmin && (
              <Badge variant="info" className="gap-1.5">
                <Building2 className="h-3.5 w-3.5" />
                Todas as Empresas
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setShowFilters(!showFilters)}>
              <Filter className="w-4 h-4 mr-2" />
              Filtros
              {hasActiveFilters() && (
                <Badge variant="default" className="ml-2">!</Badge>
              )}
            </Button>
            <Button 
              variant="outline" 
              onClick={exportToCSV}
              disabled={filteredCharges.length === 0}
            >
              <Download className="w-4 h-4 mr-2" />
              CSV
            </Button>
            <Button 
              variant="outline" 
              onClick={exportToExcel}
              disabled={filteredCharges.length === 0}
            >
              <FileSpreadsheet className="w-4 h-4 mr-2" />
              Excel
            </Button>
            <Button onClick={() => syncPaymentStatuses(false)} variant="outline" disabled={loading || syncing}>
              <RefreshCw className={`w-4 h-4 mr-2 ${(loading || syncing) ? 'animate-spin' : ''}`} />
              {syncing ? 'Sincronizando...' : 'Atualizar'}
            </Button>
            <Button asChild>
              <Link to="/new-charge">
                <Plus className="w-4 h-4 mr-2" />
                Nova Cobrança
              </Link>
            </Button>
          </div>
        </div>

        {/* Filters */}
        {showFilters && (
          <Card>
            <CardContent className="pt-6">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
                {/* Company filter - Admin only */}
                {isAdmin && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-ds-text-muted">Empresa</label>
                    <Select value={filters.company_id} onValueChange={(value) => setFilters(prev => ({ ...prev, company_id: value }))}>
                      <SelectTrigger>
                        <SelectValue placeholder="Todas as empresas" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Todas as empresas</SelectItem>
                        {companies.map(company => (
                          <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-ds-text-muted">Status</label>
                  <Select value={filters.status} onValueChange={(value) => setFilters(prev => ({ ...prev, status: value }))}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos</SelectItem>
                      <SelectItem value="pending">Pendente</SelectItem>
                      <SelectItem value="processing">Processando</SelectItem>
                      <SelectItem value="completed">Concluída</SelectItem>
                      <SelectItem value="failed">Falhou</SelectItem>
                      <SelectItem value="cancelled">Cancelada</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-ds-text-muted">Tipo de Pagamento</label>
                  <Select value={filters.payment_method} onValueChange={(value) => setFilters(prev => ({ ...prev, payment_method: value }))}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos</SelectItem>
                      <SelectItem value="cartao">Cartão</SelectItem>
                      <SelectItem value="pix">PIX</SelectItem>
                      <SelectItem value="cartao_pix">PIX + Cartão</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-ds-text-muted">Data Inicial</label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="w-full justify-start text-left font-normal">
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {filters.date_from ? format(filters.date_from, 'dd/MM/yyyy') : 'Selecionar'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0">
                      <CalendarComponent
                        mode="single"
                        selected={filters.date_from}
                        onSelect={(date) => setFilters(prev => ({ ...prev, date_from: date }))}
                        locale={ptBR}
                      />
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-ds-text-muted">Data Final</label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="w-full justify-start text-left font-normal">
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {filters.date_to ? format(filters.date_to, 'dd/MM/yyyy') : 'Selecionar'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0">
                      <CalendarComponent
                        mode="single"
                        selected={filters.date_to}
                        onSelect={(date) => setFilters(prev => ({ ...prev, date_to: date }))}
                        locale={ptBR}
                      />
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-ds-text-muted">CPF/CNPJ</label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Buscar por documento"
                      value={filters.payer_document}
                      onChange={(e) => setFilters(prev => ({ ...prev, payer_document: e.target.value }))}
                    />
                    {hasActiveFilters() && (
                      <Button variant="ghost" size="icon" onClick={clearFilters}>
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Results count */}
        <div className="text-sm text-ds-text-muted flex items-center gap-2">
          {loading ? 'Carregando...' : (
            <>
              {`${filteredCharges.length} cobrança(s) exibida(s)`}
              {totalCount > 0 && ` de ${totalCount} no total`}
              {isFetching && !loading && (
                <Loader2 className="h-3 w-3 animate-spin inline" />
              )}
            </>
          )}
        </div>

        {/* Charges List */}
        {loading ? (
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-ds-bg-surface-alt hover:bg-ds-bg-surface-alt">
                  <TableHead className="font-semibold">Cliente</TableHead>
                  <TableHead className="font-semibold hidden md:table-cell">CPF/CNPJ</TableHead>
                  <TableHead className="font-semibold text-right">Valor</TableHead>
                  <TableHead className="font-semibold hidden sm:table-cell">Pagamento</TableHead>
                  <TableHead className="font-semibold">Status</TableHead>
                  <TableHead className="font-semibold hidden lg:table-cell">Data</TableHead>
                  <TableHead className="font-semibold text-right">Ação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <ChargeListSkeleton />
                <ChargeListSkeleton />
                <ChargeListSkeleton />
                <ChargeListSkeleton />
                <ChargeListSkeleton />
              </TableBody>
            </Table>
          </Card>
        ) : filteredCharges.length === 0 ? (
          <Card>
            <CardContent className="py-12">
              <div className="text-center">
                <FileText className="w-12 h-12 mx-auto text-ds-text-muted mb-4" />
                <h3 className="text-lg font-medium text-ds-text-strong mb-2">Nenhuma cobrança encontrada</h3>
                <p className="text-ds-text-muted mb-4">
                  {hasActiveFilters() ? 'Tente ajustar os filtros' : 'Comece criando sua primeira cobrança'}
                </p>
                {!hasActiveFilters() && (
                  <Button asChild>
                    <Link to="/new-charge">
                      <Plus className="w-4 h-4 mr-2" />
                      Nova Cobrança
                    </Link>
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-ds-bg-surface-alt hover:bg-ds-bg-surface-alt">
                    <TableHead className="font-semibold">Cliente</TableHead>
                    <TableHead className="font-semibold hidden md:table-cell">CPF/CNPJ</TableHead>
                    <TableHead className="font-semibold text-right">Valor</TableHead>
                    <TableHead className="font-semibold hidden sm:table-cell">Pagamento</TableHead>
                    <TableHead className="font-semibold">Status</TableHead>
                    <TableHead className="font-semibold hidden lg:table-cell">Data</TableHead>
                    <TableHead className="font-semibold text-right">Ação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCharges.map((charge) => (
                    <ChargeListRow 
                      key={charge.id} 
                      charge={charge} 
                      onViewDetails={() => { setSelectedCharge(charge); setEditingStatus(false); setEditingPaymentMethod(false); }}
                      isAdmin={isAdmin}
                    />
                  ))}
                  {isFetching && !loading && (
                    <>
                      <ChargeListSkeleton />
                      <ChargeListSkeleton />
                      <ChargeListSkeleton />
                    </>
                  )}
                </TableBody>
              </Table>
            </Card>
            
            {/* Carregar mais */}
            {hasMore && !isFetching && (
              <div className="flex justify-center pt-4">
                <Button 
                  variant="outline" 
                  onClick={() => setPage(p => p + 1)}
                  className="gap-2"
                >
                  Carregar mais
                </Button>
              </div>
            )}
          </>
        )}

        {/* Charge Details Sheet */}
        <Sheet open={!!selectedCharge} onOpenChange={() => setSelectedCharge(null)}>
          <SheetContent className="sm:max-w-xl overflow-y-auto">
            {selectedCharge && (
              <>
                <SheetHeader>
                  <SheetTitle>Detalhes da Cobrança</SheetTitle>
                  <SheetDescription>
                    ID: {selectedCharge.id.slice(0, 8)}...
                  </SheetDescription>
                </SheetHeader>
                <div className="space-y-6 py-6">
                  <div className="grid grid-cols-2 gap-4">
                    <InfoCard icon={User} label="Pagador" value={selectedCharge.payer_name} />
                    <InfoCard icon={Mail} label="Email" value={selectedCharge.payer_email} />
                    <InfoCard icon={Phone} label="Telefone" value={formatPhone(selectedCharge.payer_phone)} />
                    <InfoCard icon={FileText} label="CPF/CNPJ" value={formatDocument(selectedCharge.payer_document)} />
                    <InfoCard icon={CreditCard} label="Valor" value={formatCurrency(
                      selectedCharge.amount
                    )} variant="primary" />
                  </div>
                  
                  {/* Link de Pagamento */}
                  <div className="space-y-3 p-4 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-200 dark:border-blue-800">
                    <h4 className="font-medium text-blue-800 dark:text-blue-200 flex items-center gap-2">
                      <Link2 className="h-4 w-4" />
                      Link de Pagamento
                    </h4>
                    <CheckoutButtons charge={selectedCharge} />
                  </div>
                  
                  {/* ADMIN: Alterar Empresa da Cobrança */}
                  {isAdmin && (
                    <div className="space-y-3 p-4 bg-purple-50 dark:bg-purple-950/30 rounded-lg border border-purple-200 dark:border-purple-800">
                      <h4 className="font-medium text-purple-800 dark:text-purple-200 flex items-center gap-2">
                        <Building2 className="h-4 w-4" />
                        Empresa da Cobrança
                      </h4>
                      
                      {!editingCompany ? (
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-sm">
                            {selectedCharge.company?.name || 'Não definida'}
                          </Badge>
                          <Button 
                            variant="ghost" 
                            size="sm"
                            onClick={() => {
                              setEditingCompany(true);
                              setNewCompanyId(selectedCharge.company_id || '');
                            }}
                          >
                            Alterar
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <Select
                            value={newCompanyId}
                            onValueChange={setNewCompanyId}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Selecione a nova empresa" />
                            </SelectTrigger>
                            <SelectContent>
                              {companies.map((company) => (
                                <SelectItem key={company.id} value={company.id}>
                                  {company.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          
                          <div className="flex gap-2">
                            <Button 
                              size="sm"
                              onClick={async () => {
                                if (!selectedCharge || !newCompanyId) return;
                                
                                setChangingCompany(true);
                                try {
                                  const { error } = await db
                                    .from('charges')
                                    .update({ company_id: newCompanyId })
                                    .eq('id', selectedCharge.id);
                                  
                                  if (error) throw error;
                                  
                                  const newCompany = companies.find(c => c.id === newCompanyId);
                                  
                                  // Atualizar estado local
                                   invalidateCharges();
                                  
                                  // Atualizar o charge selecionado
                                  setSelectedCharge(prev => prev ? { ...prev, company_id: newCompanyId, company: newCompany } : null);
                                  
                                  toast({ title: 'Empresa alterada com sucesso!' });
                                  setEditingCompany(false);
                                  setNewCompanyId('');
                                } catch (error: any) {
                                  toast({ 
                                    title: 'Erro ao alterar empresa', 
                                    description: error.message,
                                    variant: 'destructive'
                                  });
                                } finally {
                                  setChangingCompany(false);
                                }
                              }}
                              disabled={!newCompanyId || newCompanyId === selectedCharge.company_id || changingCompany}
                            >
                              {changingCompany ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Salvar'}
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => {
                                setEditingCompany(false);
                                setNewCompanyId('');
                              }}
                            >
                              Cancelar
                            </Button>
                          </div>
                        </div>
                      )}
                      
                      <p className="text-xs text-purple-600 dark:text-purple-400">
                        Altere a empresa responsável por esta cobrança.
                      </p>
                    </div>
                  )}
                  
                  <div className="space-y-2">
                    <h4 className="font-medium text-ds-text-strong">Status</h4>
                    <div className="flex gap-2 items-center">
                      {getModernStatusBadge(getComputedStatus(selectedCharge))}
                      <Badge variant="outline">{selectedCharge.recurrence_type}</Badge>
                      {selectedCharge.payment_method && getPaymentMethodBadge(selectedCharge.payment_method)}
                      {selectedCharge.status_locked_at && (
                        <Badge variant="warning" className="text-[10px]">🔒 Status manual</Badge>
                      )}
                    </div>
                    
                    {/* Admin: Manual status override */}
                    {isAdmin && !editingStatus && (
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="mt-2"
                        onClick={() => { setEditingStatus(true); setNewManualStatus(selectedCharge.status); }}
                      >
                        Alterar Status
                      </Button>
                    )}
                    {isAdmin && editingStatus && (
                      <div className="mt-2 space-y-2 p-3 rounded-lg border border-ds-border-subtle bg-ds-bg-surface-alt">
                        <Select value={newManualStatus} onValueChange={setNewManualStatus}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {[
                              { value: 'pending', label: 'Pendente' },
                              { value: 'processing', label: 'Processando' },
                              { value: 'completed', label: 'Pago' },
                              { value: 'failed', label: 'Falhou' },
                              { value: 'cancelled', label: 'Cancelado' },
                              { value: 'pre_authorized', label: 'Pré-autorizado' },
                              { value: 'boleto_linked', label: 'Boleto vinculado' },
                              { value: 'approved', label: 'Aprovado' },
                              { value: 'awaiting_validation', label: 'Aguardando validação' },
                              { value: 'validating', label: 'Validando' },
                              { value: 'payment_denied', label: 'Pagamento negado' },
                              { value: 'refunded', label: 'Estornado' },
                            ].map(s => (
                              <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <div className="flex gap-2">
                          <Button size="sm" onClick={async () => {
                            setSavingStatus(true);
                            try {
                              const { error } = await db
                                .from('charges')
                                .update({ 
                                  status: newManualStatus as any,
                                  status_locked_at: new Date().toISOString()
                                })
                                .eq('id', selectedCharge.id);
                              if (error) throw error;
                              const lockedAt = new Date().toISOString();
                              setSelectedCharge({ ...selectedCharge, status: newManualStatus, status_locked_at: lockedAt });
                              invalidateCharges();
                              setEditingStatus(false);
                              toast({ title: 'Status atualizado', description: 'Status alterado manualmente com sucesso.' });
                            } catch (err: any) {
                              toast({ title: 'Erro', description: err.message, variant: 'destructive' });
                            } finally {
                              setSavingStatus(false);
                            }
                          }} disabled={savingStatus || newManualStatus === selectedCharge.status}>
                            {savingStatus ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                            Confirmar
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setEditingStatus(false)} disabled={savingStatus}>
                            Cancelar
                          </Button>
                        </div>
                        <p className="text-[11px] text-muted-foreground">⚠️ O status manual não será sobrescrito por sincronizações automáticas.</p>
                      </div>
                     )}

                     {/* Admin: Payment method override */}
                     {isAdmin && !editingPaymentMethod && (
                       <Button 
                         variant="outline" 
                         size="sm" 
                         className="mt-2"
                         onClick={() => { setEditingPaymentMethod(true); setNewPaymentMethod(selectedCharge.payment_method || 'cartao'); }}
                       >
                         Alterar Tipo de Pagamento
                       </Button>
                     )}
                     {isAdmin && editingPaymentMethod && (() => {
                       const currentMethod = selectedCharge.payment_method || 'cartao';
                       const isChanged = newPaymentMethod !== currentMethod;
                       
                       // Calculate preview amount
                       let previewAmount = selectedCharge.amount;
                       let previewNote = '';
                       if (currentMethod === 'cartao_pix' && newPaymentMethod === 'pix') {
                         previewAmount = selectedCharge.pix_amount ?? selectedCharge.amount;
                         previewNote = `Novo total: R$ ${(previewAmount / 100).toFixed(2)} (valor PIX)`;
                       } else if (currentMethod === 'cartao_pix' && newPaymentMethod === 'cartao') {
                         previewAmount = selectedCharge.card_amount ?? selectedCharge.amount;
                         previewNote = `Novo total: R$ ${(previewAmount / 100).toFixed(2)} (valor Cartão)`;
                       } else if (newPaymentMethod === 'cartao_pix' && currentMethod !== 'cartao_pix') {
                         previewNote = 'Valor mantido. Configure o split (PIX + Cartão) posteriormente.';
                       } else if (isChanged) {
                         previewNote = `Valor mantido: R$ ${(previewAmount / 100).toFixed(2)}`;
                       }

                       return (
                       <div className="mt-2 space-y-2 p-3 rounded-lg border border-ds-border-subtle bg-ds-bg-surface-alt">
                         <Select value={newPaymentMethod} onValueChange={setNewPaymentMethod}>
                           <SelectTrigger className="h-8 text-xs">
                             <SelectValue />
                           </SelectTrigger>
                           <SelectContent>
                             <SelectItem value="cartao">Cartão</SelectItem>
                             <SelectItem value="pix">PIX</SelectItem>
                             <SelectItem value="cartao_pix">Cartão + PIX</SelectItem>
                           </SelectContent>
                         </Select>
                         {previewNote && (
                           <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                             <Info className="w-3 h-3" /> {previewNote}
                           </p>
                         )}
                         <div className="flex gap-2">
                           <Button size="sm" onClick={async () => {
                             setSavingPaymentMethod(true);
                             try {
                               // Calculate new amount
                               let newAmount = selectedCharge.amount;
                               let newPixAmount: number | null = selectedCharge.pix_amount ?? null;
                               let newCardAmount: number | null = selectedCharge.card_amount ?? null;

                               if (currentMethod === 'cartao_pix' && newPaymentMethod === 'pix') {
                                 newAmount = selectedCharge.pix_amount ?? selectedCharge.amount;
                                 newCardAmount = null;
                               } else if (currentMethod === 'cartao_pix' && newPaymentMethod === 'cartao') {
                                 newAmount = selectedCharge.card_amount ?? selectedCharge.amount;
                                 newPixAmount = null;
                               } else if (newPaymentMethod === 'pix') {
                                 newPixAmount = newAmount;
                                 newCardAmount = null;
                               } else if (newPaymentMethod === 'cartao') {
                                 newCardAmount = newAmount;
                                 newPixAmount = null;
                               }

                               // Update charge
                               const { error } = await db
                                 .from('charges')
                                 .update({
                                   payment_method: newPaymentMethod,
                                   amount: newAmount,
                                   pix_amount: newPixAmount,
                                   card_amount: newCardAmount,
                                 })
                                 .eq('id', selectedCharge.id);
                               if (error) throw error;

                               // Delete pending splits for removed method
                               if (currentMethod === 'cartao_pix' && newPaymentMethod !== 'cartao_pix') {
                                 const removedMethod = newPaymentMethod === 'pix' ? 'CARD' : 'PIX';
                                 await db
                                   .from('payment_splits')
                                   .delete()
                                   .eq('charge_id', selectedCharge.id)
                                   .eq('status', 'pending')
                                   .eq('method', removedMethod);
                               }

                               // Update local state
                               const updated = { 
                                 ...selectedCharge, 
                                 payment_method: newPaymentMethod, 
                                 amount: newAmount,
                                 pix_amount: newPixAmount,
                                 card_amount: newCardAmount,
                               };
                               setSelectedCharge(updated);
                               invalidateCharges();
                               setEditingPaymentMethod(false);
                               toast({ title: 'Tipo de pagamento atualizado', description: `Método alterado para ${newPaymentMethod === 'cartao' ? 'Cartão' : newPaymentMethod === 'pix' ? 'PIX' : 'Cartão + PIX'}.` });
                             } catch (err: any) {
                               toast({ title: 'Erro', description: err.message, variant: 'destructive' });
                             } finally {
                               setSavingPaymentMethod(false);
                             }
                           }} disabled={savingPaymentMethod || !isChanged}>
                             {savingPaymentMethod ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                             Confirmar
                           </Button>
                           <Button size="sm" variant="outline" onClick={() => setEditingPaymentMethod(false)} disabled={savingPaymentMethod}>
                             Cancelar
                           </Button>
                         </div>
                         <p className="text-[11px] text-muted-foreground">⚠️ Splits pendentes do método removido serão excluídos.</p>
                       </div>
                       );
                     })()}
                   </div>

                  {/* Métodos de Pagamento Detalhados */}
                  {(selectedCharge.payment_method === 'cartao_pix' || selectedCharge.payment_method === 'pix' || (selectedCharge.splits && selectedCharge.splits.length > 0)) && (
                    <div className="space-y-2">
                      <h4 className="font-medium text-ds-text-strong">Métodos de Pagamento</h4>
                      <PaymentMethodsSummary charge={selectedCharge} isAdmin={isAdmin} />
                      
                      {/* Detalhes individuais dos splits */}
                      {selectedCharge.splits && selectedCharge.splits.length > 0 && (() => {
                        // ✅ STATUS ÚNICO: usar getComputedStatus como fonte da verdade (igual ao topo)
                        const displayStatus = getComputedStatus(selectedCharge);
                        const isTerminalStatus = ['cancelled', 'failed', 'payment_denied'].includes(displayStatus);
                        const isCompleted = displayStatus === 'completed';
                        const isPartial = displayStatus === 'partial';
                        
                        return (
                        <div className="space-y-2 mt-3">
                            {selectedCharge.splits.map((split) => {
                              // ✅ Badge unificado: usa o displayStatus (getComputedStatus) como o topo
                              const getSplitBadgeConfig = () => {
                                // Se status terminal, TODOS os cards mostram o mesmo status do topo
                                if (isTerminalStatus) {
                                  if (displayStatus === 'cancelled') return { variant: 'secondary' as const, label: '✗ Cancelado' };
                                  if (displayStatus === 'failed') return { variant: 'destructive' as const, label: '✗ Falhou' };
                                  if (displayStatus === 'payment_denied') return { variant: 'destructive' as const, label: '✗ Negado' };
                                }
                                
                                // Se completado, todos os splits estão pagos
                                if (isCompleted) {
                                  return { variant: 'success' as const, label: '✓ Pago' };
                                }
                                
                                // Se parcial, verificar individual do split
                                if (isPartial) {
                                  const isPaid = split.status === 'concluded' || (split.method === 'pix' && split.pix_paid_at);
                                  if (isPaid) return { variant: 'success' as const, label: '✓ Pago' };
                                }
                                
                                // Status normal do split
                                if (split.status === 'failed') return { variant: 'destructive' as const, label: '✗ Recusado' };
                                if (split.status === 'cancelled') return { variant: 'secondary' as const, label: '✗ Cancelado' };
                                
                                // Se o split de cartão está em 'analyzing' (pré-pagamento autorizado)
                                if (split.method === 'credit_card' && split.status === 'analyzing') {
                                  return { variant: 'info' as const, label: 'Pré pagamento autorizado' };
                                }
                                
                                return { variant: 'warning' as const, label: '⏳ Pendente' };
                              };
                              
                              const badgeConfig = getSplitBadgeConfig();
                              
                              return (
                              <div key={split.id} className="p-3 bg-ds-bg-surface-alt rounded-lg border border-ds-border-subtle">
                                <div className="flex items-center justify-between mb-2">
                                  <span className="font-medium text-sm">
                                    {split.method === 'pix' ? '💳 PIX' : '💳 Cartão de Crédito'}
                                  </span>
                                  <div className="flex flex-col items-end gap-0.5">
                                    <Badge variant={badgeConfig.variant}>
                                      {badgeConfig.label}
                                    </Badge>
                                    {isAdmin && split.method === 'credit_card' && split.status === 'analyzing' && (
                                      <span className="text-xs text-blue-600 dark:text-blue-400">
                                        {selectedCharge?.has_boleto_link
                                          ? 'Boleto vinculado - Aguardando conclusão'
                                          : 'Aguardando o vínculo do boleto'}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              <div className="grid grid-cols-2 gap-2 text-xs text-ds-text-muted">
                                <div>
                                  <span className="font-medium">Valor:</span> {formatCurrency(split.amount_cents)}
                                </div>
                                {split.installments && split.installments > 1 && (
                                  <div>
                                    <span className="font-medium">Parcelas:</span> {split.installments}x
                                  </div>
                                )}
                                {split.pre_payment_key && (
                                  <div className="col-span-2">
                                    <span className="font-medium">PreAuth:</span> {split.pre_payment_key.slice(0, 8)}...
                                  </div>
                                )}
                                {!isTerminalStatus && split.pix_paid_at && (
                                  <div className="col-span-2">
                                    <span className="font-medium">Pago em:</span> {format(new Date(split.pix_paid_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}
                                  </div>
                                )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        );
                      })()}
                    </div>
                  )}

                  {/* ADMIN: Exibir linha digitável cadastrada pelo operador */}
                  {(() => {
                    if (!isAdmin) return null;
                    const linhaCadastro = selectedCharge.payment_method === 'cartao_pix'
                      ? selectedCharge.boleto_pix_cartao_linha_digitavel
                      : selectedCharge.boleto_linha_digitavel;
                    if (!linhaCadastro) return null;
                    const adminJaVinculou = !!selectedCharge.boleto_admin_linha_digitavel;
                    return (
                      <div className="space-y-2">
                        <h4 className="font-medium text-ds-text-strong flex items-center gap-2">
                          <FileText className="h-4 w-4" />
                          Linha Digitável {selectedCharge.payment_method === 'cartao_pix' ? '(Cadastro)' : ''}
                        </h4>
                        <div className="p-3 bg-amber-50 dark:bg-amber-950/30 rounded-lg border border-amber-200 dark:border-amber-800">
                          <div className="flex items-center justify-between gap-2">
                            <code className="text-xs break-all text-amber-800 dark:text-amber-200 flex-1">
                              {linhaCadastro}
                            </code>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => copyToClipboard(linhaCadastro)}
                              className="shrink-0"
                            >
                              <Copy className="h-4 w-4" />
                            </Button>
                          </div>
                          <p className="text-xs text-amber-600 dark:text-amber-300 mt-1 flex items-center gap-1">
                            <Info className="h-3 w-3" />
                            {adminJaVinculou
                              ? 'Esta é a linha digitável cadastrada pelo usuário no momento da cobrança — NÃO é a linha vinculada agora pelo admin.'
                              : selectedCharge.payment_method === 'cartao_pix'
                              ? 'Linha cadastrada pelo usuário no momento da cobrança'
                              : selectedCharge.payment_method === 'cartao'
                              ? 'Boleto original utilizado para o pagamento com cartão'
                              : selectedCharge.payment_method === 'pix'
                              ? 'Apenas para referência - sem vinculação automática'
                              : selectedCharge.payment_method === 'boleto'
                              ? 'Boleto emitido para pagamento'
                              : 'Linha digitável do boleto'}
                          </p>
                        </div>
                      </div>
                    );
                  })()}

                  {/* ADMIN: Campo para vincular boleto manualmente (pagamentos combinados) */}
                  {isAdmin && 
                   selectedCharge.payment_method === 'cartao_pix' &&
                   selectedCharge.pre_payment_key &&
                   !selectedCharge.boleto_admin_linha_digitavel &&
                   selectedCharge.splits?.some((s: any) => s.method === 'credit_card' && s.status === 'analyzing') && (
                    <div className="space-y-3 p-4 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-200 dark:border-blue-800">
                      <h4 className="font-medium text-blue-800 dark:text-blue-200 flex items-center gap-2">
                        <Link2 className="h-4 w-4" />
                        Vincular Boleto Manualmente
                      </h4>
                      <p className="text-xs text-blue-600 dark:text-blue-300">
                        Informe a linha digitável do boleto que será vinculado ao pagamento do cartão.
                      </p>
                      <Input
                        placeholder="Digite a linha digitável (47 ou 48 dígitos)"
                        value={adminLinhaDigitavel}
                        onChange={(e) => setAdminLinhaDigitavel(e.target.value)}
                        className="font-mono text-sm"
                      />
                      <Button 
                        onClick={() => handleAdminLinkBoleto(selectedCharge)}
                        disabled={adminLinhaDigitavel.replace(/\D/g, '').length < 47 || linkingBoleto}
                        className="w-full gap-2"
                      >
                        {linkingBoleto ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Link2 className="h-4 w-4" />
                        )}
                        {linkingBoleto ? 'Vinculando...' : 'Vincular Boleto'}
                      </Button>
                    </div>
                  )}

                  {/* Status do vínculo manual (visível para todos) */}
                  {selectedCharge.payment_method === 'cartao_pix' && selectedCharge.boleto_admin_linha_digitavel && (
                    <div className="space-y-2">
                      <h4 className="font-medium text-ds-text-strong flex items-center gap-2">
                        <Link2 className="h-4 w-4" />
                        Boleto Vinculado (Admin)
                      </h4>
                      <div className="p-3 bg-green-50 dark:bg-green-950/30 rounded-lg border border-green-200 dark:border-green-800">
                        <div className="flex items-center gap-2 mb-2">
                          <Badge variant="success">✓ Vinculado</Badge>
                        </div>
                        {isAdmin && (
                          <code className="text-xs break-all text-green-800 dark:text-green-200">{selectedCharge.boleto_admin_linha_digitavel}</code>
                        )}
                      </div>
                    </div>
                  )}

                  {selectedCharge.description && (
                    <div className="space-y-2">
                      <h4 className="font-medium text-ds-text-strong">Descrição</h4>
                      <p className="text-sm text-ds-text-muted">{selectedCharge.description}</p>
                    </div>
                  )}

                  <ChargeRefundTimeline chargeId={selectedCharge.id} hasBoletoLink={selectedCharge.has_boleto_link} />
                  <ChargeExecutions chargeId={selectedCharge.id} />
                </div>
                <SheetFooter>
                  <Button variant="outline" onClick={() => setSelectedCharge(null)}>
                    Fechar
                  </Button>
                </SheetFooter>
              </>
            )}
          </SheetContent>
        </Sheet>

        {/* Executions Dialog */}
        <ExecutionsDialogContent 
          executionsDialog={executionsDialog}
          setExecutionsDialog={setExecutionsDialog}
          openPaymentLink={openPaymentLink}
          copyToClipboard={copyToClipboard}
        />

        {/* Checkout Success Modal */}
        {showCheckoutModal && checkoutModalData && (
          <CheckoutSuccessModal
            open={showCheckoutModal}
            onOpenChange={(open) => {
              setShowCheckoutModal(open);
              if (!open) setCheckoutModalData(null);
            }}
            checkoutData={{
              chargeId: checkoutModalData.chargeId,
              checkoutUrl: checkoutModalData.checkoutUrl,
              amount: checkoutModalData.amount,
              payerName: checkoutModalData.payerName,
              description: checkoutModalData.description,
              status: 'PENDENTE'
            }}
          />
        )}
      </div>
    </DashboardShell>
  );
}
