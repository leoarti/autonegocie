import { CheckoutCharge } from './useCheckoutStore';
import { db } from '@/integrations/firebase/client';

// Mock data for charges (fallback only)
const mockCharges: Record<string, CheckoutCharge> = {
  '1': {
    id: '1',
    totalCents: 50000, // R$ 500,00
    title: 'Produto Premium',
    description: 'Licença anual do software Premium'
  },
  '2': {
    id: '2',
    totalCents: 120000, // R$ 1.200,00
    title: 'Consultoria Especializada',
    description: 'Pacote de consultoria de 10 horas'
  },
  '3': {
    id: '3',
    totalCents: 25000, // R$ 250,00
    title: 'Curso Online',
    description: 'Acesso completo ao curso de marketing digital'
  }
};

export const getCheckoutCharge = async (id: string): Promise<CheckoutCharge | null> => {
  // Try to fetch from database first
  try {
    const { data, error } = await db
      .from('charges')
      .select('id, amount, description, payer_name')
      .eq('id', id)
      .single();

    if (!error && data) {
      return {
        id: data.id,
        totalCents: data.amount,
        title: `Cobrança - ${data.payer_name || 'Cliente'}`,
        description: data.description || 'Pagamento de cobrança'
      };
    }
  } catch (error) {
    console.error('Error fetching charge:', error);
  }
  
  // Simulate API delay for mock data
  await new Promise(resolve => setTimeout(resolve, 300));
  
  // Return mock data or fallback
  return mockCharges[id] || {
    id,
    totalCents: 100000, // R$ 1.000,00 - fallback
    title: 'Produto/Serviço',
    description: 'Descrição do produto ou serviço'
  };
};

export const generateMockCheckoutUrl = (chargeId: string): string => {
  // Generate a real URL pointing to the checkout page in the current application
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://checkout.autonegocie';
  return `${baseUrl}/checkout/${chargeId}`;
};