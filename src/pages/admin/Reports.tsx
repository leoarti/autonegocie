import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { db } from '@/integrations/firebase/client';
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  LineChart,
  Line,
} from "recharts";
import {
  Download,
  RefreshCw,
  Filter,
  BarChart3,
  DollarSign,
  QrCode,
  CreditCard,
  Wallet,
  TrendingUp,
  AlertTriangle,
  FileSpreadsheet
} from "lucide-react";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { StatCard } from "@/components/dashboard/StatCard";

interface KPIs {
  totalBruto: number;
  totalEstornos: number;
  totalTaxas: number;
  totalLiquido: number;
  conversao: number;
  inadimplencia: number;
}

interface Filters {
  from: string;
  to: string;
  tipo?: string;
  metodo?: string;
  status?: string;
}

interface ExportJob {
  id: string;
  format: string;
  scope: string;
  status: string;
  rows_count?: number;
  created_at: string;
  finished_at?: string;
  download_url?: string;
}

export default function Reports() {
  const { toast } = useToast();
  const [filters, setFilters] = useState<Filters>({
    from: format(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), 'yyyy-MM-dd'),
    to: format(new Date(), 'yyyy-MM-dd')
  });
  
  const [kpis, setKpis] = useState<KPIs>({
    totalBruto: 0,
    totalEstornos: 0,
    totalTaxas: 0,
    totalLiquido: 0,
    conversao: 0,
    inadimplencia: 0
  });
  
  const [chartData, setChartData] = useState({
    daily: [],
    methods: [],
    status: []
  });
  
  const [tableData, setTableData] = useState<any[]>([]);
  const [currentTable, setCurrentTable] = useState('transactions');
  const [loading, setLoading] = useState(false);
  const [exportJobs, setExportJobs] = useState<ExportJob[]>([]);

  const loadSummary = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params.append(key, value);
      });

      const { data, error } = await db.functions.invoke(`admin-reports/summary?${params.toString()}`, {
        method: 'GET',
      });

      if (error) throw error;

      if (data?.kpis) setKpis(data.kpis);
      if (data?.charts) setChartData(data.charts);
    } catch (error) {
      console.error('Error loading summary:', error);
      toast({
        title: "Erro",
        description: "Erro ao carregar resumo dos relatórios",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  const loadTableData = async (entity: string) => {
    try {
      const params = new URLSearchParams();
      params.append('entity', entity);
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params.append(key, value);
      });

      const { data, error } = await db.functions.invoke(`admin-reports/table?${params.toString()}`, {
        method: 'GET',
      });

      if (error) throw error;

      setTableData(data?.data || []);
    } catch (error) {
      console.error('Error loading table data:', error);
      toast({
        title: "Erro",
        description: "Erro ao carregar dados da tabela",
        variant: "destructive"
      });
    }
  };

  const exportData = async (entity: string, format: 'CSV' | 'XLSX') => {
    try {
      const { data, error } = await db.functions.invoke('admin-reports/export', {
        body: {
          entity,
          format,
          filters
        }
      });

      if (error) throw error;

      toast({
        title: "Exportação iniciada",
        description: `Exportação ${format} de ${entity} foi criada. Verifique a seção de exportações.`
      });

      loadExportJobs();
    } catch (error) {
      console.error('Error creating export:', error);
      toast({
        title: "Erro",
        description: "Erro ao criar exportação",
        variant: "destructive"
      });
    }
  };

  const loadExportJobs = async () => {
    try {
      const { data, error } = await db
        .from('export_jobs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) throw error;

      // Para cada job DONE, buscar URL de download
      const jobsWithUrls = await Promise.all(
        (data || []).map(async (job) => {
          if (job.status === 'DONE') {
            try {
              const { data: jobData } = await db.functions.invoke(`admin-reports/export/${job.id}`);
              return { ...job, download_url: jobData?.download_url };
            } catch {
              return job;
            }
          }
          return job;
        })
      );

      setExportJobs(jobsWithUrls);
    } catch (error) {
      console.error('Error loading export jobs:', error);
    }
  };

  const runExportWorker = async () => {
    try {
      const { data, error } = await db.functions.invoke('export-worker', {
        body: {}
      });

      if (error) throw error;

      toast({
        title: "Worker executado",
        description: data.message || "Worker de exportação executado com sucesso"
      });

      setTimeout(loadExportJobs, 2000);
    } catch (error) {
      console.error('Error running export worker:', error);
      toast({
        title: "Erro",
        description: "Erro ao executar worker de exportação",
        variant: "destructive"
      });
    }
  };

  useEffect(() => {
    loadSummary();
    loadExportJobs();
  }, [filters]);

  useEffect(() => {
    if (currentTable) {
      loadTableData(currentTable);
    }
  }, [currentTable, filters]);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(value);
  };

  const getStatusBadgeVariant = (status: string) => {
    switch (status.toLowerCase()) {
      case 'done':
      case 'concluded':
      case 'paid':
      case 'success':
        return 'success';
      case 'failed':
      case 'error':
        return 'destructive';
      case 'pending':
      case 'processing':
        return 'warning';
      default:
        return 'secondary';
    }
  };

  return (
    <DashboardShell>
      <div className="space-y-6">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <BarChart3 className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-ds-text-strong">Relatórios</h1>
              <p className="text-sm text-ds-text-muted">Análise completa de receitas e transações</p>
            </div>
          </div>
          <Button onClick={runExportWorker} variant="outline" className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Processar Exportações
          </Button>
        </div>

        {/* Filtros */}
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Filter className="w-5 h-5 text-primary" />
              <CardTitle className="text-lg">Filtros</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-ds-text-muted">De</label>
                <Input
                  type="date"
                  value={filters.from}
                  onChange={(e) => setFilters(prev => ({ ...prev, from: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-ds-text-muted">Até</label>
                <Input
                  type="date"
                  value={filters.to}
                  onChange={(e) => setFilters(prev => ({ ...prev, to: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-ds-text-muted">Tipo</label>
                <Select value={filters.tipo || 'all'} onValueChange={(value) => setFilters(prev => ({ ...prev, tipo: value === 'all' ? undefined : value }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Todos" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos</SelectItem>
                    <SelectItem value="pontual">Pontual</SelectItem>
                    <SelectItem value="recorrente">Recorrente</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-ds-text-muted">Método</label>
                <Select value={filters.metodo || 'all'} onValueChange={(value) => setFilters(prev => ({ ...prev, metodo: value === 'all' ? undefined : value }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Todos" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos</SelectItem>
                    <SelectItem value="PIX">PIX</SelectItem>
                    <SelectItem value="CARD">Cartão</SelectItem>
                    <SelectItem value="QUITA">Quita+</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-ds-text-muted">Status</label>
                <Select value={filters.status || 'all'} onValueChange={(value) => setFilters(prev => ({ ...prev, status: value === 'all' ? undefined : value }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Todos" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos</SelectItem>
                    <SelectItem value="paid">Pago</SelectItem>
                    <SelectItem value="pending">Pendente</SelectItem>
                    <SelectItem value="failed">Falhou</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* KPIs with StatCard */}
        {(() => {
          const methods = chartData.methods as { method: string; value: number }[];
          const pixBruto = methods.find(m => m.method === 'PIX')?.value || 0;
          const cardBruto = methods.find(m => m.method === 'CARD')?.value || 0;
          const receitaPix = pixBruto * 0.015;
          const receitaCartao = cardBruto * 0.012;
          return (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
              <StatCard
                icon={DollarSign}
                label="Recebido Bruto"
                value={formatCurrency(kpis.totalBruto)}
                variant="highlight"
              />
              <StatCard
                icon={QrCode}
                label="Receita PIX (1,5%)"
                value={formatCurrency(receitaPix)}
              />
              <StatCard
                icon={CreditCard}
                label="Receita Cartão (1,2%)"
                value={formatCurrency(receitaCartao)}
              />
              <StatCard
                icon={Wallet}
                label="Recebido Líquido"
                value={formatCurrency(kpis.totalLiquido)}
              />
              <StatCard
                icon={TrendingUp}
                label="Conversão"
                value={`${kpis.conversao.toFixed(1)}%`}
              />
              <StatCard
                icon={AlertTriangle}
                label="Inadimplência Rec."
                value={`${kpis.inadimplencia.toFixed(1)}%`}
              />
            </div>
          );
        })()}

        {/* Gráficos */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader className="pb-4">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-primary" />
                <CardTitle className="text-lg">Receita Diária</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData.daily}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                  <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <Tooltip 
                    formatter={(value: any) => formatCurrency(value)}
                    contentStyle={{
                      backgroundColor: 'hsl(var(--background))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                    }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="value" 
                    stroke="hsl(var(--primary))" 
                    strokeWidth={2}
                    dot={{ fill: 'hsl(var(--primary))', strokeWidth: 2 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-primary" />
                <CardTitle className="text-lg">Receita por Método</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={chartData.methods}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                  <XAxis dataKey="method" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <Tooltip 
                    formatter={(value: any) => formatCurrency(value)}
                    contentStyle={{
                      backgroundColor: 'hsl(var(--background))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                    }}
                  />
                  <Bar 
                    dataKey="value" 
                    fill="hsl(var(--primary))" 
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        {/* Tabelas */}
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-primary" />
              <CardTitle className="text-lg">Dados Detalhados</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <Tabs value={currentTable} onValueChange={setCurrentTable}>
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
                <TabsList className="bg-ds-bg-surface-alt">
                  <TabsTrigger value="transactions">Transações</TabsTrigger>
                  <TabsTrigger value="charges">Cobranças</TabsTrigger>
                  <TabsTrigger value="executions">Execuções</TabsTrigger>
                  <TabsTrigger value="splits">Splits</TabsTrigger>
                </TabsList>
                
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => exportData(currentTable, 'CSV')}
                    className="gap-2"
                  >
                    <Download className="h-4 w-4" />
                    CSV
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => exportData(currentTable, 'XLSX')}
                    className="gap-2"
                  >
                    <Download className="h-4 w-4" />
                    XLSX
                  </Button>
                </div>
              </div>

              <TabsContent value="transactions">
                <div className="rounded-lg border border-ds-border-subtle overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-ds-bg-surface-alt hover:bg-ds-bg-surface-alt">
                        <TableHead className="text-ds-text-muted font-medium">ID</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Pagador</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Valor</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Status</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Data</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tableData.map((item) => (
                        <TableRow key={item.id} className="hover:bg-ds-bg-surface-alt/50">
                          <TableCell className="font-mono text-xs text-ds-text-muted">{item.id.slice(0, 8)}...</TableCell>
                          <TableCell className="text-ds-text-default">{item.payer_name}</TableCell>
                          <TableCell className="font-semibold text-ds-text-strong">{formatCurrency((item.amount_in_cents || 0) / 100)}</TableCell>
                          <TableCell>
                            <Badge variant={getStatusBadgeVariant(item.status)}>
                              {item.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-ds-text-muted">{format(new Date(item.created_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>

              <TabsContent value="charges">
                <div className="rounded-lg border border-ds-border-subtle overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-ds-bg-surface-alt hover:bg-ds-bg-surface-alt">
                        <TableHead className="text-ds-text-muted font-medium">ID</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Pagador</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Valor</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Tipo</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Status</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Data</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tableData.map((item) => (
                        <TableRow key={item.id} className="hover:bg-ds-bg-surface-alt/50">
                          <TableCell className="font-mono text-xs text-ds-text-muted">{item.id.slice(0, 8)}...</TableCell>
                          <TableCell className="text-ds-text-default">{item.payer_name}</TableCell>
                          <TableCell className="font-semibold text-ds-text-strong">{formatCurrency((item.amount || 0) / 100)}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{item.recurrence_type}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant={getStatusBadgeVariant(item.status)}>
                              {item.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-ds-text-muted">{format(new Date(item.created_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>

              <TabsContent value="executions">
                <div className="rounded-lg border border-ds-border-subtle overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-ds-bg-surface-alt hover:bg-ds-bg-surface-alt">
                        <TableHead className="text-ds-text-muted font-medium">ID</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Cobrança</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Status</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Agendado Para</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Tentativas</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Data</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tableData.map((item) => (
                        <TableRow key={item.id} className="hover:bg-ds-bg-surface-alt/50">
                          <TableCell className="font-mono text-xs text-ds-text-muted">{item.id.slice(0, 8)}...</TableCell>
                          <TableCell className="font-mono text-xs text-ds-text-muted">{item.charge_id?.slice(0, 8)}...</TableCell>
                          <TableCell>
                            <Badge variant={getStatusBadgeVariant(item.status)}>
                              {item.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-ds-text-muted">
                            {item.scheduled_for ? format(new Date(item.scheduled_for), 'dd/MM/yyyy HH:mm', { locale: ptBR }) : '-'}
                          </TableCell>
                          <TableCell className="text-ds-text-default">{item.attempts || 0}</TableCell>
                          <TableCell className="text-ds-text-muted">{format(new Date(item.created_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>

              <TabsContent value="splits">
                <div className="rounded-lg border border-ds-border-subtle overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-ds-bg-surface-alt hover:bg-ds-bg-surface-alt">
                        <TableHead className="text-ds-text-muted font-medium">ID</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Método</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Valor</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Status</TableHead>
                        <TableHead className="text-ds-text-muted font-medium">Data</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tableData.map((item) => (
                        <TableRow key={item.id} className="hover:bg-ds-bg-surface-alt/50">
                          <TableCell className="font-mono text-xs text-ds-text-muted">{item.id.slice(0, 8)}...</TableCell>
                          <TableCell>
                            <Badge variant="info">{item.method}</Badge>
                          </TableCell>
                          <TableCell className="font-semibold text-ds-text-strong">{formatCurrency((item.amount_cents || 0) / 100)}</TableCell>
                          <TableCell>
                            <Badge variant={getStatusBadgeVariant(item.status)}>
                              {item.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-ds-text-muted">{format(new Date(item.created_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {/* Exportações */}
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Download className="w-5 h-5 text-primary" />
              <div>
                <CardTitle className="text-lg">Histórico de Exportações</CardTitle>
                <CardDescription>Últimas 20 exportações criadas</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border border-ds-border-subtle overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-ds-bg-surface-alt hover:bg-ds-bg-surface-alt">
                    <TableHead className="text-ds-text-muted font-medium">Escopo</TableHead>
                    <TableHead className="text-ds-text-muted font-medium">Formato</TableHead>
                    <TableHead className="text-ds-text-muted font-medium">Status</TableHead>
                    <TableHead className="text-ds-text-muted font-medium">Registros</TableHead>
                    <TableHead className="text-ds-text-muted font-medium">Criado em</TableHead>
                    <TableHead className="text-ds-text-muted font-medium">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exportJobs.map((job) => (
                    <TableRow key={job.id} className="hover:bg-ds-bg-surface-alt/50">
                      <TableCell>
                        <Badge variant="outline">{job.scope}</Badge>
                      </TableCell>
                      <TableCell className="text-ds-text-default font-medium">{job.format}</TableCell>
                      <TableCell>
                        <Badge variant={getStatusBadgeVariant(job.status)}>
                          {job.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-ds-text-muted">{job.rows_count || '-'}</TableCell>
                      <TableCell className="text-ds-text-muted">
                        {format(new Date(job.created_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}
                      </TableCell>
                      <TableCell>
                        {job.status === 'DONE' && job.download_url && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => window.open(job.download_url, '_blank')}
                            className="gap-2"
                          >
                            <Download className="h-4 w-4" />
                            Baixar
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}
