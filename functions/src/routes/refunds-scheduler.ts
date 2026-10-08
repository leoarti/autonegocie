import { createClient, functionUrl } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const REFUND_TIMEOUT_HOURS = 24;
const REFUND_FEE_PERCENT = 5.0;

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
    const pathParts = url.pathname.split('/');

    // POST /refunds/scheduler/run
    if (req.method === 'POST' && pathParts.includes('scheduler') && pathParts.includes('run')) {
      const body = req.method === 'POST' ? await req.json() : {};
      const limit = body.limit || 50;

      const result = await processRefundScheduler(supabase, limit);
      
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // POST /refunds/:job_id/execute
    if (req.method === 'POST' && pathParts.length >= 3 && pathParts[1] === 'refunds' && pathParts[3] === 'execute') {
      const jobId = pathParts[2];
      
      const result = await executeRefundJob(supabase, jobId);
      
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // GET /refunds/jobs
    if (req.method === 'GET' && pathParts.includes('jobs')) {
      const params = new URLSearchParams(url.search);
      const filters = {
        startDate: params.get('startDate'),
        endDate: params.get('endDate'),
        status: params.get('status'),
        chargeId: params.get('chargeId'),
        limit: parseInt(params.get('limit') || '100')
      };

      const result = await getRefundJobs(supabase, filters);
      
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in refunds-scheduler function:', error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

async function processRefundScheduler(supabase: any, limit: number) {
  console.log(`Processing refund scheduler with limit: ${limit}`);
  
  const stats = {
    charges_eligiveis: 0,
    splits_refundados: 0,
    jobs_criados: 0,
    jobs_executados: 0,
    errors: []
  };

  try {
    // Find eligible charges
    const { data: eligibleCharges, error: chargesError } = await supabase
      .from('payment_splits')
      .select(`
        charge_id,
        id,
        method,
        amount_cents,
        status,
        processed_at,
        charges!inner(id, status)
      `)
      .eq('status', 'concluded')
      .lt('processed_at', new Date(Date.now() - REFUND_TIMEOUT_HOURS * 60 * 60 * 1000).toISOString())
      .limit(limit * 10); // Get more to filter

    if (chargesError) throw chargesError;

    console.log(`Found ${eligibleCharges?.length || 0} potential concluded splits`);

    // Group by charge_id and check eligibility
    const chargeGroups = new Map();
    for (const split of eligibleCharges || []) {
      if (!chargeGroups.has(split.charge_id)) {
        chargeGroups.set(split.charge_id, []);
      }
      chargeGroups.get(split.charge_id).push(split);
    }

    for (const [chargeId, concludedSplits] of chargeGroups.entries()) {
      if (stats.charges_eligiveis >= limit) break;

      // Check if charge has pending/failed splits
      const { data: allSplits, error: allSplitsError } = await supabase
        .from('payment_splits')
        .select('status')
        .eq('charge_id', chargeId);

      if (allSplitsError) {
        console.error(`Error getting splits for charge ${chargeId}:`, allSplitsError);
        stats.errors.push(`Error getting splits for charge ${chargeId}: ${allSplitsError.message}`);
        continue;
      }

      const hasPendingOrFailed = allSplits.some(s => ['pending', 'failed'].includes(s.status));
      
      if (!hasPendingOrFailed) {
        console.log(`Charge ${chargeId} has no pending/failed splits, skipping`);
        continue;
      }

      // Check if already processed (idempotency)
      const { data: existingJobs, error: jobsError } = await supabase
        .from('refund_jobs')
        .select('id')
        .eq('charge_id', chargeId)
        .eq('status', 'processed');

      if (jobsError) {
        console.error(`Error checking existing jobs for charge ${chargeId}:`, jobsError);
        stats.errors.push(`Error checking existing jobs for charge ${chargeId}: ${jobsError.message}`);
        continue;
      }

      if (existingJobs && existingJobs.length > 0) {
        console.log(`Charge ${chargeId} already has processed refund jobs, skipping`);
        continue;
      }

      stats.charges_eligiveis++;
      console.log(`Processing eligible charge: ${chargeId} with ${concludedSplits.length} concluded splits`);

      // Process each concluded split
      for (const split of concludedSplits) {
        try {
          // Check idempotency with mock_events
          const eventKey = `REFUND:${split.id}`;
          const { data: existingEvent } = await supabase
            .from('mock_events')
            .select('id')
            .eq('event_key', eventKey)
            .single();

          if (existingEvent) {
            console.log(`Split ${split.id} already processed (found mock event), skipping`);
            continue;
          }

          // Create refund job
          const { data: job, error: jobError } = await supabase
            .from('refund_jobs')
            .insert({
              charge_id: chargeId,
              original_amount_cents: split.amount_cents,
              refund_amount_cents: split.amount_cents,
              fee_amount_cents: Math.round(split.amount_cents * (REFUND_FEE_PERCENT / 100)),
              reason: 'TIMEOUT_24H_PENDING_OTHER_SPLITS',
              scheduled_for: new Date().toISOString(),
              status: 'pending'
            })
            .select()
            .single();

          if (jobError) {
            console.error(`Error creating refund job for split ${split.id}:`, jobError);
            stats.errors.push(`Error creating refund job for split ${split.id}: ${jobError.message}`);
            continue;
          }

          stats.jobs_criados++;
          console.log(`Created refund job ${job.id} for split ${split.id}`);

          // Execute the job immediately
          const executed = await executeRefundJobInternal(supabase, job.id, {
            splitId: split.id,
            chargeId: chargeId,
            method: split.method,
            amount: split.amount_cents,
            fee: Math.round(split.amount_cents * (REFUND_FEE_PERCENT / 100))
          });

          if (executed.success) {
            stats.jobs_executados++;
            stats.splits_refundados++;
          } else {
            stats.errors.push(executed.error || `Failed to execute job ${job.id}`);
          }

        } catch (error) {
          console.error(`Error processing split ${split.id}:`, error);
          stats.errors.push(`Error processing split ${split.id}: ${error.message}`);
        }
      }
    }

  } catch (error) {
    console.error('Error in processRefundScheduler:', error);
    stats.errors.push(`Global error: ${error.message}`);
  }

  console.log('Refund scheduler completed:', stats);
  return stats;
}

async function executeRefundJob(supabase: any, jobId: string) {
  console.log(`Executing refund job: ${jobId}`);

  try {
    // Get job details
    const { data: job, error: jobError } = await supabase
      .from('refund_jobs')
      .select(`
        *,
        payment_splits!inner(id, method, charge_id)
      `)
      .eq('id', jobId)
      .in('status', ['pending', 'failed'])
      .single();

    if (jobError) throw jobError;
    if (!job) throw new Error('Job not found or not executable');

    const splitInfo = job.payment_splits[0];
    
    return await executeRefundJobInternal(supabase, jobId, {
      splitId: splitInfo.id,
      chargeId: splitInfo.charge_id,
      method: splitInfo.method,
      amount: job.refund_amount_cents,
      fee: job.fee_amount_cents
    });

  } catch (error) {
    console.error(`Error executing refund job ${jobId}:`, error);
    return { success: false, error: error.message };
  }
}

async function executeRefundJobInternal(supabase: any, jobId: string, splitInfo: any) {
  const { splitId, chargeId, method, amount, fee } = splitInfo;

  try {
    // Update split status to refunded
    const { error: splitError } = await supabase
      .from('payment_splits')
      .update({ 
        status: 'refunded',
        processed_at: new Date().toISOString()
      })
      .eq('id', splitId);

    if (splitError) throw splitError;

    // Create refund transaction
    const { error: refundTransactionError } = await supabase
      .from('transactions')
      .insert({
        transaction_id: `refund_${splitId}_${Date.now()}`,
        charge_id: chargeId,
        amount_in_cents: -amount, // Negative for refund
        status: 'succeeded',
        payer_name: 'System Refund',
        payer_email: 'system@refund.local',
        payer_document: '00000000000',
        payer_phone_number: '00000000000',
        merchant_id: 'system_refund',
        creditor_name: 'System',
        creditor_document: '00000000000',
        card_holder_name: 'System Refund',
        card_number_last_four: '0000',
        installments: 1
      });

    if (refundTransactionError) {
      console.error('Failed to create refund transaction:', refundTransactionError);
    }

    // Create fee transaction
    const { error: feeTransactionError } = await supabase
      .from('transactions')
      .insert({
        transaction_id: `fee_${splitId}_${Date.now()}`,
        charge_id: chargeId,  
        amount_in_cents: fee, // Positive for fee
        status: 'succeeded',
        payer_name: 'System Fee',
        payer_email: 'system@fee.local',
        payer_document: '00000000000',
        payer_phone_number: '00000000000',
        merchant_id: 'system_fee',
        creditor_name: 'System',
        creditor_document: '00000000000',
        card_holder_name: 'System Fee',
        card_number_last_four: '0000',
        installments: 1
      });

    if (feeTransactionError) {
      console.error('Failed to create fee transaction:', feeTransactionError);
    }

    // Mark job as processed
    const { error: jobUpdateError } = await supabase
      .from('refund_jobs')
      .update({ 
        status: 'processed',
        processed_at: new Date().toISOString()
      })
      .eq('id', jobId);

    if (jobUpdateError) throw jobUpdateError;

    // Create idempotency record
    const { error: eventError } = await supabase
      .from('mock_events')
      .insert({
        provider: 'REFUND_SCHEDULER',
        event_key: `REFUND:${splitId}`,
        payload: {
          job_id: jobId,
          split_id: splitId,
          charge_id: chargeId,
          method: method,
          refund_amount: amount,
          fee_amount: fee,
          reason: 'TIMEOUT_24H_PENDING_OTHER_SPLITS'
        },
        processed_at: new Date().toISOString()
      });

    if (eventError) {
      console.error('Failed to create idempotency event:', eventError);
    }

    console.log(`Successfully executed refund job ${jobId} for split ${splitId}`);
    return { success: true };

  } catch (error) {
    // Mark job as failed
    await supabase
      .from('refund_jobs')
      .update({ 
        status: 'failed',
        error_details: { error: error.message, timestamp: new Date().toISOString() }
      })
      .eq('id', jobId);

    console.error(`Failed to execute refund job ${jobId}:`, error);
    return { success: false, error: error.message };
  }
}

async function getRefundJobs(supabase: any, filters: any) {
  console.log('Getting refund jobs with filters:', filters);

  let query = supabase
    .from('refund_jobs')
    .select(`
      *,
      charges!inner(payer_name, payer_email, description)
    `)
    .order('created_at', { ascending: false })
    .limit(filters.limit);

  if (filters.startDate) {
    query = query.gte('created_at', filters.startDate);
  }
  
  if (filters.endDate) {
    query = query.lte('created_at', filters.endDate);
  }
  
  if (filters.status) {
    query = query.eq('status', filters.status);
  }
  
  if (filters.chargeId) {
    query = query.eq('charge_id', filters.chargeId);
  }

  const { data: jobs, error } = await query;
  
  if (error) throw error;

  return { jobs: jobs || [] };
}
