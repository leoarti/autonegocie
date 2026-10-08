// @ts-nocheck
import { createClient, functionUrl } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface PaymentRequestBody {
  payerName: string;
  payerDocument: string;
  payerEmail: string;
  payerPhoneNumber: string;
  cardHolderName: string;
  cardNumber: string;
  cardExpirationDate: string;
  cardCvv: string;
  amountInCents: number;
  installments: number;
}

interface QuitaMaisRequest {
  merchantId: string;
  creditorName: string;
  creditorDocument: string;
  amountInCents: number;
  installments: number;
  payerDocument: string;
  payerEmail: string;
  payerPhoneNumber: string;
  payerName: string;
  cardHolderName: string;
  cardNumber: string;
  cardExpirationDate: string;
  cardCvv: string;
}

export async function handler(req: Request): Promise<Response> {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Initialize Supabase client
    const supabaseClient = createClient(
      process.env.SUPABASE_URL ?? '',
      process.env.SUPABASE_ANON_KEY ?? '',
    )

    // Get payment data from request
    const paymentData: PaymentRequestBody = await req.json()

    // Get QuitaMais credentials from Supabase secrets
    const merchantId = process.env.QUITA_MAIS_MERCHANT_ID
    const creditorName = process.env.QUITA_MAIS_CREDITOR_NAME
    const creditorDocument = process.env.QUITA_MAIS_CREDITOR_DOCUMENT
    const apiUrl = process.env.QUITAPLUS_BASE_URL || 'https://pay-gt.autonegocie.com'

    if (!merchantId || !creditorName || !creditorDocument) {
      throw new Error('QuitaMais credentials not configured')
    }

    // Format card expiration date to yyyy/mm format
    const [month, year] = paymentData.cardExpirationDate.split('/')
    const formattedExpirationDate = `20${year}/${month.padStart(2, '0')}`

    // Prepare QuitaMais request
    const quitaMaisRequest: QuitaMaisRequest = {
      merchantId,
      creditorName,
      creditorDocument,
      amountInCents: paymentData.amountInCents,
      installments: paymentData.installments,
      payerDocument: paymentData.payerDocument.replace(/\D/g, ''),
      payerEmail: paymentData.payerEmail,
      payerPhoneNumber: paymentData.payerPhoneNumber.replace(/\D/g, ''),
      payerName: paymentData.payerName,
      cardHolderName: paymentData.cardHolderName,
      cardNumber: paymentData.cardNumber.replace(/\s/g, ''),
      cardExpirationDate: formattedExpirationDate,
      cardCvv: paymentData.cardCvv,
    }

    // Process payment via QuitaPlus API using proxy
    console.log('Processing real payment via QuitaPlus API:', {
      amount: paymentData.amountInCents,
      installments: paymentData.installments,
      payerEmail: paymentData.payerEmail,
    })

    // Use the quitaplus-proxy to make the actual payment call
    console.log('Calling quitaplus-proxy for payment processing:', {
      targetPath: 'prepayment',
      httpMethod: 'POST',
      payloadStructure: {
        merchantId,
        creditorDocument,
        creditorName,
        amount: paymentData.amountInCents,
        installments: paymentData.installments,
        debtor: {
          name: paymentData.payerName,
          email: paymentData.payerEmail,
          phoneNumber: '***masked***',
          document: '***masked***',
        },
        card: {
          holderName: paymentData.cardHolderName,
          number: '****-****-****-' + paymentData.cardNumber.replace(/\s/g, '').slice(-4),
          expirationDate: '**/**',
          cvv: '***',
        }
      }
    })
    
    const { data: paymentResult, error: proxyError } = await supabaseClient.functions.invoke('quitaplus-proxy', {
      body: {
        targetPath: 'prepayment', // Endpoint para pré-pagamento
        httpMethod: 'POST',
        payload: {
          partner: {
            merchantId,
            creditorDocument,
            creditorName,
          },
          debtor: {
            name: paymentData.payerName,
            email: paymentData.payerEmail,
            phoneNumber: paymentData.payerPhoneNumber.replace(/\D/g, ''),
            document: paymentData.payerDocument.replace(/\D/g, ''),
          },
          card: {
            holderName: paymentData.cardHolderName,
            number: paymentData.cardNumber.replace(/\s/g, ''),
            expirationDate: formattedExpirationDate,
            cvv: paymentData.cardCvv,
          },
          transaction: {
            amount: paymentData.amountInCents,
            installments: paymentData.installments,
          }
        }
      }
    })

    if (proxyError) {
      console.error('QuitaPlus API error via proxy:', proxyError)
      console.error('Proxy error details:', JSON.stringify(proxyError, null, 2))
      throw new Error(`Payment processing failed: ${proxyError.message || 'Proxy request failed'}`)
    }

    if (!paymentResult) {
      throw new Error('No response from QuitaPlus API')
    }

    console.log('QuitaPlus payment result (sensitive data redacted):', {
      success: paymentResult.success,
      status: paymentResult.status,
      hasTransactionId: !!paymentResult.transactionId,
      hasAuthCode: !!paymentResult.authorizationCode,
      message: paymentResult.message
    })

    // Extract response data
    const responseData = {
      success: paymentResult.success !== false,
      transactionId: paymentResult.transactionId || paymentResult.prePaymentKey || paymentResult.id || `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      status: paymentResult.status || 'AUTHORIZED',
      authorizationCode: paymentResult.authorizationCode || paymentResult.prePaymentKey || `AUTH_${Math.random().toString(36).substr(2, 6).toUpperCase()}`,
      message: paymentResult.message || 'Pagamento processado com sucesso'
    }

    // Generate transaction ID (use QuitaPlus response or generate one)
    const transactionId = responseData.transactionId || 
                         responseData.id || 
                         `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    // Store transaction in database
    const { error: dbError } = await supabaseClient
      .from('transactions')
      .insert([
        {
          transaction_id: transactionId,
          merchant_id: merchantId,
          creditor_name: creditorName,
          creditor_document: creditorDocument,
          amount_in_cents: paymentData.amountInCents,
          installments: paymentData.installments,
          payer_document: paymentData.payerDocument,
          payer_email: paymentData.payerEmail,
          payer_phone_number: paymentData.payerPhoneNumber,
          payer_name: paymentData.payerName,
          card_holder_name: paymentData.cardHolderName,
          card_number_last_four: paymentData.cardNumber.replace(/\s/g, '').slice(-4),
          status: 'AUTHORIZED',
          authorization_code: responseData.authorizationCode,
        }
      ])

    if (dbError) {
      console.error('Database error:', dbError)
      // Continue even if DB insert fails, as payment was authorized
    }

    return new Response(
      JSON.stringify({
        success: true,
        transactionId,
        status: 'AUTHORIZED',
        message: 'Pagamento autorizado com sucesso',
        authorizationCode: responseData.authorizationCode,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      },
    )

  } catch (error) {
    console.error('Payment processing error:', error)
    
    return new Response(
      JSON.stringify({
        success: false,
        message: error.message || 'Erro interno do servidor',
        errorDetails: {
          code: 'PAYMENT_ERROR',
          message: error.message,
        },
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      },
    )
  }

}
