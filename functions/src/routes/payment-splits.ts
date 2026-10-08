import { createClient, functionUrl } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export async function handler(req: Request): Promise<Response> {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL ?? '',
      process.env.SUPABASE_ANON_KEY ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        }
      }
    );

    const url = new URL(req.url);
    const body = req.method !== 'GET' ? await req.json() : null;
    
    // GET /charges/:id/splits
    if (req.method === 'POST' && body?.method === 'GET' && body?.path?.includes('/charges/') && body?.path?.includes('/splits')) {
      const chargeId = body.chargeId;
      
      const { data: splits, error } = await supabase
        .from('payment_splits')
        .select('*')
        .eq('charge_id', chargeId)
        .order('created_at', { ascending: true });

      if (error) throw error;

      return new Response(JSON.stringify({ splits }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // POST /charges/:id/splits - Create/Replace splits
    if (req.method === 'POST' && body?.method === 'POST' && body?.path?.includes('/charges/') && body?.path?.includes('/splits')) {
      const chargeId = body.chargeId;
      const { splits } = body;

      // Validate charge exists and get total amount
      const { data: charge, error: chargeError } = await supabase
        .from('charges')
        .select('amount, status, has_boleto_link')
        .eq('id', chargeId)
        .single();

      if (chargeError) throw chargeError;
      if (charge.status === 'completed') {
        throw new Error('Cannot modify splits for completed charges');
      }

      // Calculate total sum of splits
      const totalSum = splits.reduce((sum: number, split: any) => sum + split.amount_cents, 0);
      if (totalSum !== charge.amount) {
        throw new Error(`Split sum (${totalSum}) must equal charge amount (${charge.amount})`);
      }

      // Validate boleto link rules
      if (charge.has_boleto_link) {
        if (splits.length !== 1 || splits[0].method !== 'QUITA') {
          throw new Error('Charges with boleto link must have exactly one QUITA split');
        }
      } else {
        // Validate methods for non-boleto charges
        const validMethods = ['PIX', 'CARD'];
        for (const split of splits) {
          if (!validMethods.includes(split.method)) {
            throw new Error(`Invalid payment method: ${split.method}`);
          }
        }
        if (splits.length > 2) {
          throw new Error('Maximum 2 splits allowed for non-boleto charges');
        }
      }

      // Remove existing PENDING splits
      const { error: deleteError } = await supabase
        .from('payment_splits')
        .delete()
        .eq('charge_id', chargeId)
        .eq('status', 'pending');

      if (deleteError) throw deleteError;

      // Insert new splits
      const splitsToInsert = splits.map((split: any) => ({
        charge_id: chargeId,
        method: split.method,
        amount_cents: split.amount_cents,
        status: 'pending'
      }));

      const { data: newSplits, error: insertError } = await supabase
        .from('payment_splits')
        .insert(splitsToInsert)
        .select();

      if (insertError) throw insertError;

      return new Response(JSON.stringify({ splits: newSplits }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // PATCH /payment-splits/:id/status - Update split status (mock)
    if (req.method === 'POST' && body?.method === 'PATCH' && body?.path?.includes('/payment-splits/')) {
      const splitId = body.splitId;
      const { status } = body;

      if (!['concluded', 'failed'].includes(status)) {
        throw new Error('Invalid status. Must be "concluded" or "failed"');
      }

      // Get current split
      const { data: currentSplit, error: splitError } = await supabase
        .from('payment_splits')
        .select('*, charges!inner(id, amount)')
        .eq('id', splitId)
        .eq('status', 'pending');

      if (splitError) throw splitError;
      
      if (!currentSplit || currentSplit.length === 0) {
        throw new Error('Payment split not found or not in pending status');
      }
      
      const split = currentSplit[0]; // Get first result since we removed .single()

      // Update split status
      const { data: updatedSplit, error: updateError } = await supabase
        .from('payment_splits')
        .update({ 
          status, 
          processed_at: new Date().toISOString()
        })
        .eq('id', splitId)
        .select()
        .single();

      if (updateError) throw updateError;

      // If concluded, create transaction record
      if (status === 'concluded') {
        const { error: transactionError } = await supabase
          .from('transactions')
          .insert({
            transaction_id: `mock_${splitId}_${Date.now()}`,
            charge_id: split.charge_id,
            amount_in_cents: split.amount_cents,
            status: 'succeeded',
            payer_name: 'Mock Payer',
            payer_email: 'mock@example.com',
            payer_document: '00000000000',
            payer_phone_number: '11999999999',
            merchant_id: 'mock_merchant',
            creditor_name: 'Mock Creditor',
            creditor_document: '00000000000',
            card_holder_name: 'Mock Holder',
            card_number_last_four: '0000',
            installments: 1
          });

        if (transactionError) {
          console.error('Failed to create transaction:', transactionError);
        }

        // Check if all splits are concluded
        const { data: allSplits, error: allSplitsError } = await supabase
          .from('payment_splits')
          .select('status')
          .eq('charge_id', split.charge_id);

        if (allSplitsError) throw allSplitsError;

        const allConcluded = allSplits.every(split => split.status === 'concluded');
        
        if (allConcluded) {
          // Check if status is manually locked by admin
          const { data: chargeCheck } = await supabase
            .from('charges')
            .select('status_locked_at')
            .eq('id', split.charge_id)
            .single();

          if (chargeCheck?.status_locked_at) {
            console.log('Status locked manually for charge', split.charge_id, '- skipping auto update');
          } else {
            const { error: chargeUpdateError } = await supabase
              .from('charges')
              .update({ status: 'completed' })
              .eq('id', split.charge_id);

            if (chargeUpdateError) {
              console.error('Failed to update charge status:', chargeUpdateError);
            }
          }
        }
      }

      return new Response(JSON.stringify({ split: updatedSplit }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in payment-splits function:', error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

}
