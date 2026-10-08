import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { db } from '@/integrations/firebase/client';
import { Loader2, Rocket, Lock } from "lucide-react";
import { z } from "zod";

interface LeadCaptureModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const leadSchema = z.object({
  name: z.string().min(2, "Nome deve ter pelo menos 2 caracteres"),
  email: z.string().email("Email inválido"),
  phone: z.string().optional(),
  company: z.string().optional(),
});

export function LeadCaptureModal({ open, onOpenChange }: LeadCaptureModalProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    company: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const formatPhone = (value: string) => {
    const numbers = value.replace(/\D/g, "");
    if (numbers.length <= 2) return numbers;
    if (numbers.length <= 7) return `(${numbers.slice(0, 2)}) ${numbers.slice(2)}`;
    if (numbers.length <= 11) return `(${numbers.slice(0, 2)}) ${numbers.slice(2, 7)}-${numbers.slice(7)}`;
    return `(${numbers.slice(0, 2)}) ${numbers.slice(2, 7)}-${numbers.slice(7, 11)}`;
  };

  const handleChange = (field: string, value: string) => {
    if (field === "phone") {
      value = formatPhone(value);
    }
    setFormData(prev => ({ ...prev, [field]: value }));
    setErrors(prev => ({ ...prev, [field]: "" }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    const result = leadSchema.safeParse(formData);
    if (!result.success) {
      const fieldErrors: Record<string, string> = {};
      result.error.errors.forEach(err => {
        if (err.path[0]) {
          fieldErrors[err.path[0] as string] = err.message;
        }
      });
      setErrors(fieldErrors);
      return;
    }

    setIsLoading(true);

    try {
      const { error } = await db.from("leads").insert({
        name: formData.name,
        email: formData.email,
        phone: formData.phone || null,
        company: formData.company || null,
        source: "landing_hero",
      });

      if (error) throw error;

      toast({
        title: "Cadastro realizado!",
        description: "Nossa equipe entrará em contato em até 24h.",
      });

      setFormData({ name: "", email: "", phone: "", company: "" });
      onOpenChange(false);
    } catch (error) {
      console.error("Error saving lead:", error);
      toast({
        title: "Erro ao cadastrar",
        description: "Tente novamente em alguns instantes.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px] bg-white rounded-[24px] border-0 shadow-2xl p-0 overflow-hidden">
        <div className="p-8">
          <DialogHeader className="mb-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-full bg-autopay-primary/10 flex items-center justify-center">
                <Rocket className="w-5 h-5 text-autopay-primary" />
              </div>
              <DialogTitle className="text-2xl font-bold text-autopay-text">
                Comece Gratuitamente
              </DialogTitle>
            </div>
            <p className="text-autopay-text-muted text-sm">
              Preencha seus dados e nossa equipe entrará em contato em até 24h.
            </p>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name" className="text-sm font-medium text-autopay-text">
                Seu nome completo *
              </Label>
              <Input
                id="name"
                placeholder="João Silva"
                value={formData.name}
                onChange={e => handleChange("name", e.target.value)}
                className={`h-12 rounded-xl border-autopay-text/10 focus:border-autopay-primary focus:ring-autopay-primary/20 ${errors.name ? "border-red-500" : ""}`}
              />
              {errors.name && <p className="text-xs text-red-500">{errors.name}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium text-autopay-text">
                Seu melhor email *
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="joao@empresa.com.br"
                value={formData.email}
                onChange={e => handleChange("email", e.target.value)}
                className={`h-12 rounded-xl border-autopay-text/10 focus:border-autopay-primary focus:ring-autopay-primary/20 ${errors.email ? "border-red-500" : ""}`}
              />
              {errors.email && <p className="text-xs text-red-500">{errors.email}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone" className="text-sm font-medium text-autopay-text">
                WhatsApp (opcional)
              </Label>
              <Input
                id="phone"
                type="tel"
                placeholder="(11) 99999-9999"
                value={formData.phone}
                onChange={e => handleChange("phone", e.target.value)}
                className="h-12 rounded-xl border-autopay-text/10 focus:border-autopay-primary focus:ring-autopay-primary/20"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="company" className="text-sm font-medium text-autopay-text">
                Nome da empresa (opcional)
              </Label>
              <Input
                id="company"
                placeholder="Empresa LTDA"
                value={formData.company}
                onChange={e => handleChange("company", e.target.value)}
                className="h-12 rounded-xl border-autopay-text/10 focus:border-autopay-primary focus:ring-autopay-primary/20"
              />
            </div>

            <Button
              type="submit"
              disabled={isLoading}
              className="w-full h-12 bg-autopay-primary hover:bg-autopay-primary-strong text-white font-semibold rounded-full shadow-lg hover:shadow-xl transition-all duration-200 mt-6"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Enviando...
                </>
              ) : (
                "Quero Começar"
              )}
            </Button>
          </form>

          <div className="flex items-center justify-center gap-2 mt-6 text-xs text-autopay-text-muted">
            <Lock className="w-3 h-3" />
            <span>Seus dados estão seguros conosco.</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
