import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Shield, Check, X } from "lucide-react";
import { db } from '@/integrations/firebase/client';
import { useToast } from "@/hooks/use-toast";
import { Link, useNavigate } from "react-router-dom";

export default function CreateAdmin() {
  const [isCreating, setIsCreating] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");
  const { toast } = useToast();
  const navigate = useNavigate();

  const createAdminUser = async () => {
    setIsCreating(true);
    setError("");
    
    try {
      const { data, error } = await db.functions.invoke('create-admin-user');
      
      if (error) throw error;
      
      if (data.success) {
        setSuccess(true);
        toast({
          title: "Administrador criado!",
          description: "Conta de administrador criada com sucesso. Você já pode fazer login.",
        });
        
        // Redirecionar para login após 2 segundos
        setTimeout(() => {
          navigate('/login');
        }, 2000);
      } else {
        throw new Error(data.error || 'Erro desconhecido');
      }
    } catch (error: any) {
      console.error('Error creating admin:', error);
      setError(error.message || 'Erro ao criar administrador');
      toast({
        title: "Erro",
        description: "Erro ao criar conta de administrador. Tente novamente.",
        variant: "destructive"
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
            <Shield className="w-6 h-6 text-primary" />
          </div>
          <CardTitle className="text-2xl">Criar Administrador</CardTitle>
          <p className="text-muted-foreground">
            Criar conta de administrador do sistema
          </p>
        </CardHeader>
        
        <CardContent className="space-y-4">
          {!success ? (
            <>
              <Alert>
                <Shield className="w-4 h-4" />
                <AlertDescription>
                  Esta ação criará uma conta de administrador com acesso total ao sistema.
                </AlertDescription>
              </Alert>

              <div className="space-y-2">
                <div className="text-sm">
                  <strong>Email:</strong> admin@sistema.com
                </div>
                <div className="text-sm">
                  <strong>Senha:</strong> Auto2025@
                </div>
                <div className="text-sm">
                  <strong>Perfil:</strong> Administrador
                </div>
              </div>

              {error && (
                <Alert variant="destructive">
                  <X className="w-4 h-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Button
                onClick={createAdminUser}
                disabled={isCreating}
                className="w-full"
              >
                {isCreating ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Criando...
                  </>
                ) : (
                  <>
                    <Shield className="w-4 h-4 mr-2" />
                    Criar Administrador
                  </>
                )}
              </Button>
            </>
          ) : (
            <div className="text-center space-y-4">
              <div className="mx-auto w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
                <Check className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <h3 className="text-lg font-medium text-green-600 mb-2">
                  Administrador criado com sucesso!
                </h3>
                <p className="text-sm text-muted-foreground">
                  Redirecionando para o login...
                </p>
              </div>
            </div>
          )}

          <div className="text-center pt-4">
            <Link to="/login" className="text-sm text-primary hover:underline">
              Voltar ao Login
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}