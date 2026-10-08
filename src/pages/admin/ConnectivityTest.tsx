import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { db } from '@/integrations/firebase/client';
import { Loader2, CheckCircle2, XCircle, Radio, Play, TestTube, Info, CreditCard } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'error';

interface LogEntry {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'error';
}

interface TestResult {
  status: number;
  statusText: string;
  duration: number;
  request?: any;
  response?: any;
  error?: string;
}

export default function ConnectivityTest() {
  const [tokenStatus, setTokenStatus] = useState<ConnectionStatus>('idle');
  const [simulationStatus, setSimulationStatus] = useState<ConnectionStatus>('idle');
  const [prepaymentStatus, setPrepaymentStatus] = useState<ConnectionStatus>('idle');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [tokenResult, setTokenResult] = useState<TestResult | null>(null);
  const [simulationResult, setSimulationResult] = useState<TestResult | null>(null);
  const [prepaymentResult, setPrepaymentResult] = useState<TestResult | null>(null);

  const formatApiResponse = (raw: string | undefined) => {
    if (!raw) return 'Sem resposta';
    try {
      const parsed = JSON.parse(raw);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return raw;
    }
  };
  const { toast } = useToast();

  // Estado do formulário de pré-pagamento (apenas campos necessários)
  const [prepaymentForm, setPrepaymentForm] = useState({
    amount: '100.00',
    installments: '1',
    cardHolderName: 'TESTE USUARIO',
    cardNumber: '4111111111111111',
    cardExpirationDate: '12/30',
    cardCvv: '123',
    payerName: 'Teste Usuário',
    payerDocument: '12345678900',
    payerEmail: 'teste@exemplo.com',
    payerPhoneNumber: '11999999999'
  });

  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    const timestamp = new Date().toLocaleTimeString('pt-BR');
    setLogs(prev => [...prev, { timestamp, message, type }]);
  };

  const maskCredential = (value: string | undefined) => {
    if (!value) return '***';
    if (value.length <= 8) return '***';
    return value.substring(0, 4) + '***' + value.substring(value.length - 4);
  };

  const testToken = async () => {
    setTokenStatus('testing');
    setTokenResult(null);
    addLog('🔄 Iniciando teste de token...', 'info');
    
    const startTime = Date.now();
    
    try {
      addLog('📤 Enviando requisição para quitaplus-token', 'info');
      
      const { data, error } = await db.functions.invoke('quitaplus-token', {
        body: {}
      });
      
      const duration = Date.now() - startTime;
      
      if (error) {
        addLog(`❌ Erro na requisição: ${error.message}`, 'error');
        setTokenResult({
          status: 500,
          statusText: 'Error',
          duration,
          error: error.message,
          response: error
        });
        setTokenStatus('error');
        toast({
          title: 'Erro no teste',
          description: error.message,
          variant: 'destructive'
        });
        return;
      }

      const status = data?.status || (data?.accessToken ? 200 : 403);
      const statusText = data?.accessToken ? 'OK' : (data?.message || 'Forbidden');
      
      addLog(`📥 Resposta recebida: ${status} (${duration}ms)`, status === 200 ? 'success' : 'error');
      
      if (status === 403) {
        addLog('🛡️ Detectado: WAF bloqueando requisição por IP dinâmico', 'error');
        addLog('💡 Solução: Implementar proxy com IP fixo', 'info');
      }
      
      setTokenResult({
        status,
        statusText,
        duration,
        response: data
      });
      
      setTokenStatus(status === 200 ? 'success' : 'error');
      
      if (status === 200) {
        toast({
          title: 'Token obtido com sucesso!',
          description: `Tempo de resposta: ${duration}ms`
        });
      }
    } catch (err: any) {
      const duration = Date.now() - startTime;
      addLog(`💥 Exceção capturada: ${err.message}`, 'error');
      setTokenResult({
        status: 0,
        statusText: 'Network Error',
        duration,
        error: err.message
      });
      setTokenStatus('error');
      toast({
        title: 'Erro inesperado',
        description: err.message,
        variant: 'destructive'
      });
    }
  };

  const testSimulation = async () => {
    setSimulationStatus('testing');
    setSimulationResult(null);
    addLog('🔄 Iniciando teste de simulação...', 'info');
    
    const startTime = Date.now();
    
    try {
      addLog('📤 Enviando requisição para quitaplus-simulation', 'info');
      
      const { data, error } = await db.functions.invoke('quitaplus-simulation', {
        body: { amountInCents: 10000 }
      });
      
      const duration = Date.now() - startTime;
      
      if (error) {
        addLog(`❌ Erro na requisição: ${error.message}`, 'error');
        setSimulationResult({
          status: 500,
          statusText: 'Error',
          duration,
          error: error.message,
          response: error
        });
        setSimulationStatus('error');
        return;
      }

      const status = data?.success ? 200 : 403;
      const statusText = data?.success ? 'OK' : 'Error';
      
      addLog(`📥 Resposta recebida: ${status} (${duration}ms)`, status === 200 ? 'success' : 'error');
      
      if (!data?.success) {
        addLog('🛡️ Simulação falhou - verifique token e configurações', 'error');
      }
      
      setSimulationResult({
        status,
        statusText,
        duration,
        response: data
      });
      
      setSimulationStatus(status === 200 ? 'success' : 'error');
      
      if (status === 200) {
        toast({
          title: 'Simulação executada com sucesso!',
          description: `Tempo de resposta: ${duration}ms`
        });
      }
    } catch (err: any) {
      const duration = Date.now() - startTime;
      addLog(`💥 Exceção capturada: ${err.message}`, 'error');
      setSimulationResult({
        status: 0,
        statusText: 'Network Error',
        duration,
        error: err.message
      });
      setSimulationStatus('error');
    }
  };

  const testPrepayment = async () => {
    setPrepaymentStatus('testing');
    setPrepaymentResult(null);
    addLog('🔄 Iniciando teste de pré-pagamento...', 'info');
    
    const startTime = Date.now();
    
    try {
      const amountInCents = Math.round(parseFloat(prepaymentForm.amount) * 100);
      
      // Gerar IDs automaticamente para o teste
      const chargeId = crypto.randomUUID();
      const paymentLinkId = crypto.randomUUID();
      
      addLog('📤 Enviando requisição para quitaplus-prepayment', 'info');
      addLog(`📋 Payload: valor=${amountInCents} centavos, parcelas=${prepaymentForm.installments}`, 'info');
      
      const { data, error } = await db.functions.invoke('quitaplus-prepayment', {
        body: {
          chargeId,
          paymentLinkId,
          amount: amountInCents,
          installments: parseInt(prepaymentForm.installments),
          card: {
            holderName: prepaymentForm.cardHolderName,
            number: prepaymentForm.cardNumber,
            expirationDate: prepaymentForm.cardExpirationDate,
            cvv: prepaymentForm.cardCvv
          },
          payer: {
            name: prepaymentForm.payerName,
            document: prepaymentForm.payerDocument,
            email: prepaymentForm.payerEmail,
            phoneNumber: prepaymentForm.payerPhoneNumber
          }
        }
      });
      
      const duration = Date.now() - startTime;
      
      if (error) {
        addLog(`❌ Erro na requisição: ${error.message}`, 'error');
        
        setPrepaymentResult({
          status: 500,
          statusText: 'Error',
          duration,
          error: error.message,
          response: { error: error.message }
        });
        setPrepaymentStatus('error');
        toast({
          title: 'Erro no teste',
          description: error.message,
          variant: 'destructive'
        });
        return;
      }

      addLog(`✅ Resposta recebida em ${duration}ms`, 'success');
      
      const result = data as any;
      const httpStatus = result.apiMetadata?.httpStatus || 200;
      
      setPrepaymentResult({
        status: httpStatus >= 200 && httpStatus < 300 ? 200 : 500,
        statusText: httpStatus >= 200 && httpStatus < 300 ? 'OK' : 'Error',
        duration,
        response: result,
        error: httpStatus >= 400 ? result.apiRawResponse : undefined
      });

      if (httpStatus >= 200 && httpStatus < 300) {
        setPrepaymentStatus('success');
        addLog('✅ Pré-pagamento autorizado com sucesso', 'success');
        addLog(`Resposta: ${result.apiRawResponse?.substring(0, 200)}...`, 'info');
        
        // Tentar extrair prePaymentKey
        try {
          const parsed = JSON.parse(result.apiRawResponse);
          if (parsed.prePaymentKey || parsed.pre_payment_key) {
            const key = parsed.prePaymentKey || parsed.pre_payment_key;
            addLog(`✅ PrePaymentKey obtida: ${maskCredential(key)}`, 'success');
          }
        } catch (e) {
          // Não é JSON válido
        }
        
        toast({
          title: 'Pré-pagamento executado com sucesso!',
          description: `Tempo: ${duration}ms`
        });
      } else {
        setPrepaymentStatus('error');
        addLog(`❌ HTTP ${httpStatus}: ${result.apiMetadata?.httpStatusText}`, 'error');
        
        const isWafBlock = result.apiRawResponse?.includes('Access Denied') || 
                          result.apiRawResponse?.includes('Akamai') ||
                          httpStatus === 403;
        
        if (isWafBlock) {
          addLog('🛡️ BLOQUEIO DETECTADO: WAF/Firewall da Cappta', 'error');
        }
      }
    } catch (err: any) {
      const duration = Date.now() - startTime;
      addLog(`💥 Exceção capturada: ${err.message}`, 'error');
      setPrepaymentResult({
        status: 0,
        statusText: 'Network Error',
        duration,
        error: err.message
      });
      setPrepaymentStatus('error');
    }
  };

  const clearLogs = () => {
    setLogs([]);
    addLog('🗑️ Logs limpos', 'info');
  };

  const getStatusIcon = (status: ConnectionStatus) => {
    switch (status) {
      case 'idle':
        return <Radio className="w-5 h-5 text-muted-foreground" />;
      case 'testing':
        return <Loader2 className="w-5 h-5 animate-spin text-primary" />;
      case 'success':
        return <CheckCircle2 className="w-5 h-5 text-green-500" />;
      case 'error':
        return <XCircle className="w-5 h-5 text-destructive" />;
    }
  };

  const getStatusBadge = (status: ConnectionStatus) => {
    const variants: Record<ConnectionStatus, any> = {
      idle: 'secondary',
      testing: 'default',
      success: 'default',
      error: 'destructive'
    };
    const labels = {
      idle: 'Não testado',
      testing: 'Testando...',
      success: 'Conectado',
      error: 'Erro'
    };
    return (
      <Badge variant={variants[status]}>
        {labels[status]}
      </Badge>
    );
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">🔌 Diagnóstico de Conectividade</h1>
          <p className="text-muted-foreground">QuitaPlus / Cappta API - Teste de Pré-Pagamento</p>
        </div>
      </div>

      {/* Status Geral */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Status da Conexão
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              {getStatusIcon(tokenStatus)}
              <span className="font-medium">Token:</span>
              {getStatusBadge(tokenStatus)}
            </div>
            <Separator orientation="vertical" className="h-6 hidden md:block" />
            <div className="flex items-center gap-2">
              {getStatusIcon(simulationStatus)}
              <span className="font-medium">Simulação:</span>
              {getStatusBadge(simulationStatus)}
            </div>
            <Separator orientation="vertical" className="h-6 hidden md:block" />
            <div className="flex items-center gap-2">
              {getStatusIcon(prepaymentStatus)}
              <span className="font-medium">Pré-Pagamento:</span>
              {getStatusBadge(prepaymentStatus)}
            </div>
          </div>
          
          <div className="flex gap-2">
            <Button onClick={testToken} disabled={tokenStatus === 'testing'}>
              {tokenStatus === 'testing' ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Play className="w-4 h-4 mr-2" />
              )}
              Testar Token
            </Button>
            <Button onClick={testSimulation} disabled={simulationStatus === 'testing'} variant="outline">
              {simulationStatus === 'testing' ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <TestTube className="w-4 h-4 mr-2" />
              )}
              Testar Simulação
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Alert de Bloqueio WAF */}
      {prepaymentResult?.response?.isWafBlock && (
        <Alert variant="destructive" className="border-2 border-destructive">
          <AlertDescription className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="text-2xl">🛡️</div>
              <div className="flex-1 space-y-2">
                <h3 className="font-bold text-base">WAF/CDN Akamai Bloqueando Requisições</h3>
                <p className="text-sm">
                  {prepaymentResult?.response?.message}
                </p>
                <div className="bg-destructive/10 p-3 rounded text-xs space-y-2 mt-3">
                  <p className="font-semibold">💡 Soluções Recomendadas:</p>
                  <ol className="list-decimal list-inside space-y-1 ml-2">
                    <li>Solicitar whitelist do IP deste servidor no WAF da Cappta</li>
                    <li>Implementar proxy com IP fixo</li>
                    <li>Contatar suporte da Cappta para liberação</li>
                  </ol>
                </div>
              </div>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Teste de Pré-Pagamento */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="w-5 h-5" />
            Teste de Pré-Pagamento com Cartão
          </CardTitle>
          <CardDescription>
            Preencha os dados para testar a autorização de pré-pagamento
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid md:grid-cols-2 gap-6">
            {/* Coluna 1: Dados do Cartão */}
            <div className="space-y-4">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <CreditCard className="w-4 h-4" />
                Dados do Cartão
              </h3>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="cardNumber">Número do Cartão</Label>
                  <Input
                    id="cardNumber"
                    value={prepaymentForm.cardNumber}
                    onChange={(e) => setPrepaymentForm(prev => ({ ...prev, cardNumber: e.target.value }))}
                    placeholder="4111111111111111"
                    maxLength={16}
                  />
                </div>
                <div>
                  <Label htmlFor="cardHolderName">Nome no Cartão</Label>
                  <Input
                    id="cardHolderName"
                    value={prepaymentForm.cardHolderName}
                    onChange={(e) => setPrepaymentForm(prev => ({ ...prev, cardHolderName: e.target.value }))}
                    placeholder="TESTE USUARIO"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="cardExpirationDate">Validade</Label>
                    <Input
                      id="cardExpirationDate"
                      value={prepaymentForm.cardExpirationDate}
                      onChange={(e) => setPrepaymentForm(prev => ({ ...prev, cardExpirationDate: e.target.value }))}
                      placeholder="MM/AA"
                      maxLength={5}
                    />
                  </div>
                  <div>
                    <Label htmlFor="cardCvv">CVV</Label>
                    <Input
                      id="cardCvv"
                      value={prepaymentForm.cardCvv}
                      onChange={(e) => setPrepaymentForm(prev => ({ ...prev, cardCvv: e.target.value }))}
                      placeholder="123"
                      maxLength={4}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Coluna 2: Dados do Pagador */}
            <div className="space-y-4">
              <h3 className="font-semibold text-sm">Dados do Pagador</h3>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="payerName">Nome</Label>
                  <Input
                    id="payerName"
                    value={prepaymentForm.payerName}
                    onChange={(e) => setPrepaymentForm(prev => ({ ...prev, payerName: e.target.value }))}
                    placeholder="Nome completo"
                  />
                </div>
                <div>
                  <Label htmlFor="payerDocument">CPF/CNPJ</Label>
                  <Input
                    id="payerDocument"
                    value={prepaymentForm.payerDocument}
                    onChange={(e) => setPrepaymentForm(prev => ({ ...prev, payerDocument: e.target.value }))}
                    placeholder="12345678900"
                  />
                </div>
                <div>
                  <Label htmlFor="payerEmail">Email</Label>
                  <Input
                    id="payerEmail"
                    type="email"
                    value={prepaymentForm.payerEmail}
                    onChange={(e) => setPrepaymentForm(prev => ({ ...prev, payerEmail: e.target.value }))}
                    placeholder="teste@exemplo.com"
                  />
                </div>
                <div>
                  <Label htmlFor="payerPhoneNumber">Telefone</Label>
                  <Input
                    id="payerPhoneNumber"
                    value={prepaymentForm.payerPhoneNumber}
                    onChange={(e) => setPrepaymentForm(prev => ({ ...prev, payerPhoneNumber: e.target.value }))}
                    placeholder="11999999999"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Valor e Parcelas */}
          <div className="grid md:grid-cols-2 gap-3 pt-4 border-t">
            <div>
              <Label htmlFor="amount">Valor (R$)</Label>
              <Input
                id="amount"
                type="number"
                step="0.01"
                value={prepaymentForm.amount}
                onChange={(e) => setPrepaymentForm(prev => ({ ...prev, amount: e.target.value }))}
                placeholder="100.00"
              />
            </div>
            <div>
              <Label htmlFor="installments">Parcelas</Label>
              <Input
                id="installments"
                type="number"
                min="1"
                max="12"
                value={prepaymentForm.installments}
                onChange={(e) => setPrepaymentForm(prev => ({ ...prev, installments: e.target.value }))}
                placeholder="1"
              />
            </div>
          </div>

          <Button 
            onClick={testPrepayment} 
            disabled={prepaymentStatus === 'testing'}
            className="w-full"
            size="lg"
          >
            {prepaymentStatus === 'testing' ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Play className="w-4 h-4 mr-2" />
            )}
            Executar Pré-Pagamento
          </Button>
        </CardContent>
      </Card>

      {/* Resultados */}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Token Result */}
        {tokenResult && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Resultado - Token</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="font-medium">Status:</span>
                  <Badge variant={tokenResult.status === 200 ? 'default' : 'destructive'}>
                    {tokenResult.status} {tokenResult.statusText}
                  </Badge>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="font-medium">Tempo:</span>
                  <span>{tokenResult.duration}ms</span>
                </div>
              </div>
              
              {tokenResult.error && (
                <Alert variant="destructive">
                  <AlertDescription>{tokenResult.error}</AlertDescription>
                </Alert>
              )}
              
              <Tabs defaultValue="response" className="w-full mt-4">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="response">Resposta</TabsTrigger>
                  <TabsTrigger value="details">Detalhes</TabsTrigger>
                </TabsList>
                
                <TabsContent value="response" className="mt-2">
                  <ScrollArea className="h-48 w-full rounded border p-3 bg-muted/30">
                    <pre className="text-xs font-mono whitespace-pre-wrap break-words">
                      {JSON.stringify(tokenResult.response, null, 2)}
                    </pre>
                  </ScrollArea>
                </TabsContent>
                
                <TabsContent value="details" className="mt-2 space-y-3">
                  {tokenResult.response?.accessToken && (
                    <div className="space-y-1">
                      <span className="text-sm font-medium">Access Token:</span>
                      <code className="text-xs bg-muted px-2 py-1 rounded block overflow-x-auto">
                        {maskCredential(tokenResult.response.accessToken)}
                      </code>
                    </div>
                  )}
                  {tokenResult.response?.expiresIn && (
                    <div className="flex justify-between text-sm border-b pb-2">
                      <span className="font-medium">Expira em:</span>
                      <span>{tokenResult.response.expiresIn}s</span>
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        )}

        {/* Simulation Result */}
        {simulationResult && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Resultado - Simulação</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="font-medium">Status:</span>
                  <Badge variant={simulationResult.status === 200 ? 'default' : 'destructive'}>
                    {simulationResult.status} {simulationResult.statusText}
                  </Badge>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="font-medium">Tempo:</span>
                  <span>{simulationResult.duration}ms</span>
                </div>
              </div>
              
              <ScrollArea className="h-48 w-full rounded border p-3 bg-muted/30">
                <pre className="text-xs font-mono whitespace-pre-wrap break-words">
                  {JSON.stringify(simulationResult.response, null, 2)}
                </pre>
              </ScrollArea>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Prepayment Result - Full Width */}
      {prepaymentResult && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <CreditCard className="w-5 h-5" />
              Resultado - Pré-Pagamento
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="p-3 rounded-lg border bg-card">
                <div className="text-xs text-muted-foreground mb-1">Status HTTP</div>
                <Badge variant={prepaymentResult.status === 200 ? 'default' : 'destructive'}>
                  {prepaymentResult.response?.apiMetadata?.httpStatus || prepaymentResult.status}
                </Badge>
              </div>
              <div className="p-3 rounded-lg border bg-card">
                <div className="text-xs text-muted-foreground mb-1">Tempo</div>
                <span className="font-mono text-sm">{prepaymentResult.duration}ms</span>
              </div>
              {prepaymentResult.response?.success !== undefined && (
                <div className="p-3 rounded-lg border bg-card">
                  <div className="text-xs text-muted-foreground mb-1">Success</div>
                  <Badge variant={prepaymentResult.response.success ? 'default' : 'destructive'}>
                    {prepaymentResult.response.success ? 'true' : 'false'}
                  </Badge>
                </div>
              )}
              {prepaymentResult.response?.isWafBlock !== undefined && (
                <div className="p-3 rounded-lg border bg-card">
                  <div className="text-xs text-muted-foreground mb-1">WAF Block</div>
                  <Badge variant={prepaymentResult.response.isWafBlock ? 'destructive' : 'default'}>
                    {prepaymentResult.response.isWafBlock ? '🛡️ Bloqueado' : '✅ OK'}
                  </Badge>
                </div>
              )}
            </div>
            
            {prepaymentResult.response?.message && (
              <Alert>
                <AlertDescription className="font-medium">
                  {prepaymentResult.response.message}
                </AlertDescription>
              </Alert>
            )}
            
            <div>
              <div className="font-semibold mb-2 text-sm">Resposta Original da API</div>
              <ScrollArea className="h-64 w-full rounded border bg-muted/30">
                <pre className="p-3 text-xs font-mono whitespace-pre-wrap break-words">
                  {formatApiResponse(prepaymentResult.response?.apiRawResponse)}
                </pre>
              </ScrollArea>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Logs em Tempo Real */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>📋 Logs em Tempo Real</CardTitle>
            <Button variant="outline" size="sm" onClick={clearLogs}>
              Limpar
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-48 w-full rounded border p-4 bg-muted/30">
            {logs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum log ainda. Execute um teste.</p>
            ) : (
              <div className="space-y-1">
                {logs.map((log, idx) => (
                  <div key={idx} className="text-sm font-mono">
                    <span className="text-muted-foreground">[{log.timestamp}]</span>{' '}
                    <span className={
                      log.type === 'error' ? 'text-destructive' :
                      log.type === 'success' ? 'text-green-600' :
                      'text-foreground'
                    }>
                      {log.message}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Informações do Ambiente */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Info className="w-5 h-5" />
            Informações do Ambiente
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 text-sm">
            <div className="flex justify-between">
              <span className="font-medium">API URL:</span>
              <span className="text-muted-foreground">pay-gt.autonegocie.com</span>
            </div>
            <div className="flex justify-between">
              <span className="font-medium">Merchant ID:</span>
              <span className="text-muted-foreground">{maskCredential('54.329.414/0001-98')}</span>
            </div>
            <div className="flex justify-between">
              <span className="font-medium">Edge Function:</span>
              <span className="text-muted-foreground">quitaplus-prepayment</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
