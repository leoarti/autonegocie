import { useState, useEffect } from 'react';
import { 
  CreditCard, 
  TrendingUp, 
  Plus,
  BarChart3,
  Calculator,
  Users,
  CheckCircle,
  Building2,
  Wallet,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/integrations/firebase/client';
import { SimulatorModal } from '@/components/SimulatorModal';
import { 
  DashboardShell, 
  StatCard, 
  QuickActionCard 
} from '@/components/dashboard';
import { Badge } from '@/components/ui/badge';

interface DashboardStats {
  totalCharges: number;
  activeCharges: number;
  completedCharges: number;
  totalAmount: number;
  completedAmount: number;
  combinedPendingCount: number;
  combinedPaidAmount: number;
}

interface Company {
  id: string;
  name: string;
}

export default function Dashboard() {
  const { profile, isAdmin } = useAuth();
  const [stats, setStats] = useState<DashboardStats>({
    totalCharges: 0,
    activeCharges: 0,
    completedCharges: 0,
    totalAmount: 0,
    completedAmount: 0,
    combinedPendingCount: 0,
    combinedPaidAmount: 0,
  });
  const [loading, setLoading] = useState(true);
  const [showSimulatorModal, setShowSimulatorModal] = useState(false);
  const [company, setCompany] = useState<Company | null>(null);

  const now = new Date();
  const monthTitle = now.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
    .replace(/^./, (c) => c.toUpperCase());

  useEffect(() => {
    if (!profile?.company_id) return;

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString();

    const loadAll = async () => {
      try {
        const [chargesRes, splitsRes, companyRes] = await Promise.all([
          db
            .from('charges')
            .select('id, status, amount, created_at')
            .gte('created_at', startOfMonth)
            .lte('created_at', endOfMonth),
          db
            .from('payment_splits')
            .select('charge_id, method, status, amount_cents')
            .not('charge_id', 'is', null)
            .gte('created_at', startOfMonth)
            .lte('created_at', endOfMonth),
          db
            .from('companies')
            .select('id, name')
            .eq('id', profile.company_id)
            .single(),
        ]);

        if (chargesRes.error) {
          console.error('Error loading charges:', chargesRes.error);
        }
        if (splitsRes.error) {
          console.error('Error loading splits:', splitsRes.error);
        }

        const charges = chargesRes.data || [];
        const splits = splitsRes.data || [];

        if (!companyRes.error && companyRes.data) {
          setCompany(companyRes.data);
        }

        const totalCharges = charges.length;
        const activeCharges = charges.filter(c => c.status === 'pending' || c.status === 'processing').length;
        const completedCharges = charges.filter(c => c.status === 'completed').length;
        const totalAmount = charges.reduce((sum, c) => sum + c.amount, 0);
        const completedAmount = charges
          .filter(c => c.status === 'completed')
          .reduce((sum, c) => sum + c.amount, 0);

        const chargeGroups: Record<string, any[]> = splits.reduce((acc, split) => {
          const chargeId = split.charge_id;
          if (!chargeId) return acc;
          if (!acc[chargeId]) acc[chargeId] = [];
          acc[chargeId].push(split);
          return acc;
        }, {} as Record<string, any[]>);

        const combinedPending = Object.values(chargeGroups).filter(splitGroup => {
          if (!splitGroup || splitGroup.length <= 1) return false;
          const hasConcluded = splitGroup.some(s => s.status === 'concluded');
          const hasPending = splitGroup.some(s => s.status === 'pending');
          return hasConcluded && hasPending;
        });

        const combinedPendingCount = combinedPending.length;
        const combinedPaidAmount = combinedPending
          .flatMap(splitGroup => (splitGroup || []).filter(s => s.status === 'concluded'))
          .reduce((sum, s) => sum + (s.amount_cents || 0), 0);

        setStats({
          totalCharges,
          activeCharges,
          completedCharges,
          totalAmount,
          completedAmount,
          combinedPendingCount,
          combinedPaidAmount,
        });
      } catch (error) {
        console.error('Error loading dashboard:', error);
      } finally {
        setLoading(false);
      }
    };

    loadAll();
  }, [profile?.company_id]);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value / 100);
  };

  return (
    <DashboardShell>
      <div className="space-y-8">
        {/* Welcome Message */}
        <section>
          <h1 className="text-2xl font-semibold text-ds-text-strong">
            Bem-vindo ao Sistema de Cobrança
          </h1>
          <p className="text-ds-text-muted mt-1">
            Gerencie suas cobranças pontuais e recorrentes integradas com o Quita+.
          </p>
        </section>

        {/* Admin/Company Indicator */}
        <section className="flex items-center gap-3">
          {isAdmin ? (
            <Badge variant="info" className="gap-1.5 px-3 py-1.5">
              <Building2 className="h-3.5 w-3.5" />
              Visão Consolidada - Todas as Empresas
            </Badge>
          ) : company && (
            <Badge variant="outline" className="gap-1.5 px-3 py-1.5">
              <Building2 className="h-3.5 w-3.5" />
              {company.name}
            </Badge>
          )}
        </section>

        {/* Quick Actions */}
        <section>
          <h2 className="text-sm font-medium text-ds-text-muted uppercase tracking-wide mb-4">
            Ações Rápidas
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <QuickActionCard
              icon={Plus}
              title="Nova Cobrança"
              description="Criar cobrança pontual ou recorrente"
              href="/new-charge"
              variant="primary"
            />
            <QuickActionCard
              icon={BarChart3}
              title="Histórico"
              description="Ver todas as cobranças"
              href="/charges"
            />
            <QuickActionCard
              icon={Calculator}
              title="Simulador"
              description="Simular parcelamento"
              onClick={() => setShowSimulatorModal(true)}
            />
            {isAdmin && (
              <QuickActionCard
                icon={Users}
                title="Gestão de Usuários"
                description="Administrar equipe"
                href="/admin/users"
              />
            )}
          </div>
        </section>

        {/* Stats Grid */}
        <section>
          <h2 className="text-sm font-medium text-ds-text-muted uppercase tracking-wide mb-4">
            Resumo — {monthTitle}
          </h2>
          <div className="grid grid-cols-6 gap-3 lg:gap-4">
            <StatCard
              icon={CreditCard}
              label="Total de Cobranças"
              value={stats.totalCharges}
              description="Todas as cobranças do período"
            />
            <StatCard
              icon={TrendingUp}
              label="Cobranças Ativas"
              value={stats.activeCharges}
              description="Pendentes ou processando"
              delta={stats.activeCharges > 0 ? { value: 12, type: 'increase' } : undefined}
            />
            <StatCard
              icon={CheckCircle}
              label="Concluídas"
              value={stats.completedCharges}
              description="Pagas com sucesso"
            />
            <StatCard
              icon={TrendingUp}
              label="Valor Total"
              value={formatCurrency(stats.totalAmount)}
              description="Soma de todas as cobranças"
              variant="highlight"
            />
            <StatCard
              icon={Wallet}
              label="Pagamentos Concluídos"
              value={formatCurrency(stats.completedAmount)}
              description="Total de valores pagos"
              variant="highlight"
            />
            <StatCard
              icon={CreditCard}
              label="Combinados Pendentes"
              value={stats.combinedPendingCount}
              description="PIX ou cartão pago, outro pendente"
            />
          </div>
        </section>

        {/* Simulator Modal */}
        <SimulatorModal
          open={showSimulatorModal}
          onOpenChange={setShowSimulatorModal}
        />
      </div>
    </DashboardShell>
  );
}
