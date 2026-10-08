import { useState, useEffect } from 'react';
import { Layout } from '@/components/Layout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { db } from '@/integrations/firebase/client';
import { useToast } from '@/hooks/use-toast';
import { Save, Eye, EyeOff, AlertCircle, CheckCircle } from 'lucide-react';
import { useCompanySettings } from '@/hooks/useCompanySettings';

export default function CompanySettings() {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [showValues, setShowValues] = useState({
    creditor_document: false,
    merchant_id: false,
  });

  // Use stable hook for company settings
  const { data: settings, isLoading: loading } = useCompanySettings();

  const [formData, setFormData] = useState({
    creditor_document: '',
    creditor_name: '',
    merchant_id: '',
  });

  // Update formData when settings are loaded
  useEffect(() => {
    if (settings) {
      setFormData(settings);
    }
  }, [settings]);

  const censorValue = (value: string, show: boolean) => {
    if (!value) return '';
    if (show) return value;
    
    const length = value.length;
    if (length <= 4) return '***';
    return '***' + value.slice(-4);
  };

  const handleInputChange = (field: keyof typeof formData, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const toggleShowValue = (field: 'creditor_document' | 'merchant_id') => {
    setShowValues(prev => ({ ...prev, [field]: !prev[field] }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const { data, error } = await db.functions.invoke('update-company-settings', {
        body: formData,
      });

      if (error) {
        console.error('Error updating settings:', error);
        toast({
          title: 'Erro ao salvar',
          description: error.message || 'Não foi possível atualizar as configurações.',
          variant: 'destructive',
        });
        return;
      }

      toast({
        title: 'Configurações salvas',
        description: data?.message || 'As configurações foram atualizadas com sucesso.',
      });

      // Recarregar configurações (will refetch automatically via React Query)
      setFormData(settings || { creditor_document: '', creditor_name: '', merchant_id: '' });
    } catch (error) {
      console.error('Error saving settings:', error);
      toast({
        title: 'Erro',
        description: 'Erro ao salvar configurações.',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = () => {
    if (!settings) return false;
    return (
      formData.creditor_document !== settings.creditor_document ||
      formData.creditor_name !== settings.creditor_name ||
      formData.merchant_id !== settings.merchant_id
    );
  };

  if (loading) {
    return (
      <Layout>
        <div className="container mx-auto p-6 max-w-4xl">
          <Skeleton className="h-8 w-64 mb-6" />
          <Card>
            <CardHeader>
              <Skeleton className="h-6 w-48 mb-2" />
              <Skeleton className="h-4 w-96" />
            </CardHeader>
            <CardContent className="space-y-4">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </CardContent>
          </Card>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="container mx-auto p-6 max-w-4xl">
        <div className="mb-6">
          <h1 className="text-3xl font-bold">Configurações da Empresa</h1>
          <p className="text-muted-foreground">
            Gerencie as credenciais de integração com a Quita+
          </p>
        </div>

        <Alert className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <strong>Atenção:</strong> Estas configurações são críticas para o funcionamento dos pagamentos.
            Certifique-se de inserir os valores corretos fornecidos pela Quita+.
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle>Credenciais Quita+</CardTitle>
            <CardDescription>
              Configure as credenciais de autenticação e identificação do credor
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Creditor Document */}
            <div className="space-y-2">
              <Label htmlFor="creditor_document">
                CNPJ do Credor <span className="text-destructive">*</span>
              </Label>
              <div className="flex gap-2">
                <Input
                  id="creditor_document"
                  type={showValues.creditor_document ? 'text' : 'password'}
                  value={formData.creditor_document}
                  onChange={(e) => handleInputChange('creditor_document', e.target.value)}
                  placeholder="00.000.000/0000-00"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => toggleShowValue('creditor_document')}
                >
                  {showValues.creditor_document ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Valor atual: {censorValue(settings.creditor_document, false)}
              </p>
            </div>

            {/* Creditor Name */}
            <div className="space-y-2">
              <Label htmlFor="creditor_name">
                Nome do Credor <span className="text-destructive">*</span>
              </Label>
              <Input
                id="creditor_name"
                type="text"
                value={formData.creditor_name}
                onChange={(e) => handleInputChange('creditor_name', e.target.value)}
                placeholder="Nome da empresa"
              />
              <p className="text-xs text-muted-foreground">
                Valor atual: {settings.creditor_name || '(não configurado)'}
              </p>
            </div>

            {/* Merchant ID */}
            <div className="space-y-2">
              <Label htmlFor="merchant_id">
                Merchant ID <span className="text-destructive">*</span>
              </Label>
              <div className="flex gap-2">
                <Input
                  id="merchant_id"
                  type={showValues.merchant_id ? 'text' : 'password'}
                  value={formData.merchant_id}
                  onChange={(e) => handleInputChange('merchant_id', e.target.value)}
                  placeholder="ID do comerciante"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => toggleShowValue('merchant_id')}
                >
                  {showValues.merchant_id ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Valor atual: {censorValue(settings.merchant_id, false)}
              </p>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between pt-4 border-t">
              <div className="flex items-center gap-2">
                {hasChanges() && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <AlertCircle className="h-4 w-4 text-orange-500" />
                    <span>Alterações não salvas</span>
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setFormData(settings || { creditor_document: '', creditor_name: '', merchant_id: '' })}
                  disabled={saving || !hasChanges()}
                >
                  Cancelar
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={saving || !hasChanges()}
                >
                  {saving ? (
                    <>Salvando...</>
                  ) : (
                    <>
                      <Save className="h-4 w-4 mr-2" />
                      Salvar Alterações
                    </>
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Info Card */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-500" />
              Como obter as credenciais
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              <strong>1. CNPJ do Credor:</strong> É o CNPJ da sua empresa cadastrada na Quita+
            </p>
            <p>
              <strong>2. Nome do Credor:</strong> Razão social ou nome fantasia da empresa
            </p>
            <p>
              <strong>3. Merchant ID:</strong> Identificador único fornecido pela Quita+ no momento da contratação
            </p>
            <p className="pt-2 border-t mt-4">
              <strong>Dúvidas?</strong> Entre em contato com o suporte da Quita+ para obter suas credenciais.
            </p>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
