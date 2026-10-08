// @ts-nocheck
import { createClient, functionUrl } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface ProcessChargeRequest {
  chargeId: string;
  immediate?: boolean; // Para processamento imediato vs cron
}

export async function handler(req: Request): Promise<Response> {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  try {
    const { chargeId, immediate = false }: ProcessChargeRequest = await req.json()
    
    console.log(`Processing charge: ${chargeId}, immediate: ${immediate}`)
    
    // Initialize Supabase client
    const supabaseUrl = process.env.SUPABASE_URL!
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const supabase = createClient(supabaseUrl, supabaseKey)
    
    // Get charge details
    const { data: charge, error: chargeError } = await supabase
      .from('charges')
      .select('*')
      .eq('id', chargeId)
      .single()
    
    if (chargeError || !charge) {
      throw new Error(`Charge not found: ${chargeId}`)
    }
    
    // Check if charge is active and pending
    if (!charge.is_active || (charge.status !== 'pending' && !immediate)) {
      console.log(`Charge ${chargeId} is not eligible for processing`)
      return new Response(
        JSON.stringify({ message: 'Charge not eligible for processing' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    
    // Generate idempotency key
    const now = new Date()
    const idempotencyKey = `charge_${chargeId}_${now.getTime()}`
    
    // Check if execution already exists
    const { data: existingExecution } = await supabase
      .from('charge_executions')
      .select('id')
      .eq('idempotency_key', idempotencyKey)
      .single()
    
    if (existingExecution) {
      console.log(`Execution already exists for key: ${idempotencyKey}`)
      return new Response(
        JSON.stringify({ message: 'Execution already processed' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    
    // Update charge status to processing (only if not manually locked)
    if (!charge.status_locked_at) {
      await supabase
        .from('charges')
        .update({ status: 'processing' })
        .eq('id', chargeId)
    } else {
      console.log(`Charge ${chargeId} status is manually locked - skipping auto update`)
    }
    
    let executionResult = {
      status: 'failed' as const,
      payment_link_id: null as string | null,
      payment_link_url: null as string | null,
      quita_guid: null as string | null,
      execution_log: {} as any,
      error_details: null as any
    }
    
    try {
      // Build payment data for Quita+
      const paymentData = {
        orderType: "boleto", // Default to boleto for now
        amount: charge.amount,
        description: charge.description || `Cobrança - ${charge.payer_name}`,
        payer: {
          name: charge.payer_name,
          email: charge.payer_email,
          phoneNumber: charge.payer_phone,
          document: charge.payer_document
        },
        checkout: {
          installments: charge.installments,
          maskFee: charge.mask_fee
        }
      }
      
      console.log('Calling quitaplus-proxy with data:', JSON.stringify({
        ...paymentData,
        payer: { ...paymentData.payer, document: '***masked***', phoneNumber: '***masked***' }
      }))
      
      // Call quitaplus-proxy to create payment link
      const { data: paymentResult, error: paymentError } = await supabase.functions.invoke('quitaplus-proxy', {
        body: paymentData
      })
      
      if (paymentError) {
        throw new Error(`Payment creation failed: ${paymentError.message}`)
      }
      
      if (!paymentResult) {
        throw new Error('No payment result received')
      }
      
      // Success - extract payment details
      executionResult = {
        status: 'completed',
        payment_link_id: paymentResult.linkId || null,
        payment_link_url: paymentResult.linkUrl || null,
        quita_guid: paymentResult.guid || null,
        execution_log: {
          processed_at: now.toISOString(),
          payment_data: paymentData,
          api_response: paymentResult
        },
        error_details: null
      }
      
      // Update charge status to completed (only if not manually locked)
      if (!charge.status_locked_at) {
        await supabase
          .from('charges')
          .update({ status: 'completed' })
          .eq('id', chargeId)
      }
      
      console.log(`Charge ${chargeId} processed successfully`)
      
      // Schedule next execution if recurring
      if (charge.recurrence_type !== 'pontual' && charge.next_charge_date) {
        const nextChargeDate = new Date(charge.next_charge_date)
        const currentTime = new Date()
        
        // Only schedule if next charge date is in the future
        if (nextChargeDate > currentTime) {
          // Calculate next occurrence
          const { data: newNextDate } = await supabase.rpc('calculate_next_charge_date', {
            base_date: charge.next_charge_date,
            recurrence_type: charge.recurrence_type,
            interval_value: charge.recurrence_interval
          })
          
          // Update next_charge_date for the next occurrence
          await supabase
            .from('charges')
            .update({ 
              next_charge_date: newNextDate,
              status: 'pending' // Reset to pending for next execution
            })
            .eq('id', chargeId)
          
          console.log(`Next charge scheduled for: ${newNextDate}`)
        }
      }
      
    } catch (error: any) {
      console.error(`Error processing charge ${chargeId}:`, error)
      
      executionResult = {
        status: 'failed',
        payment_link_id: null,
        payment_link_url: null,
        quita_guid: null,
        execution_log: {
          processed_at: now.toISOString(),
          error_occurred: true
        },
        error_details: {
          message: error.message,
          stack: error.stack,
          timestamp: now.toISOString()
        }
      }
      
      // Update charge status to failed (only if not manually locked)
      if (!charge.status_locked_at) {
        await supabase
          .from('charges')
          .update({ status: 'failed' })
          .eq('id', chargeId)
      }
    }
    
    // Record execution
    const { error: executionError } = await supabase
      .from('charge_executions')
      .insert({
        charge_id: chargeId,
        execution_date: now.toISOString(),
        status: executionResult.status,
        payment_link_id: executionResult.payment_link_id,
        payment_link_url: executionResult.payment_link_url,
        quita_guid: executionResult.quita_guid,
        execution_log: executionResult.execution_log,
        error_details: executionResult.error_details,
        idempotency_key: idempotencyKey
      })
    
    if (executionError) {
      console.error('Error recording execution:', executionError)
    }
    
    return new Response(
      JSON.stringify({
        success: executionResult.status === 'completed',
        chargeId,
        execution: executionResult
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
    
  } catch (error: any) {
    console.error('Error in process-charge:', error)
    return new Response(
      JSON.stringify({ 
        error: 'Failed to process charge',
        details: error.message
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }

}
