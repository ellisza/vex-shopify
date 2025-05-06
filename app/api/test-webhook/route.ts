import { NextRequest, NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    message: 'Use POST method with sample cart data to test the webhook handler',
    example: {
      id: 'cart_1234567890',
      items: [
        { 
          variant_id: 'Enter one of your TRIGGER_VARIANT_IDS here',
          quantity: 1
        }
      ]
    }
  });
}

export async function POST(request: NextRequest) {
  try {
    // Forward the request to the actual webhook handler
    const cartUpdateUrl = new URL('/api/webhook/cart-update', request.url);
    
    // Clone the request body
    const body = await request.text();
    
    // Make sure BYPASS_WEBHOOK_VERIFICATION is set to true in your .env.local file
    // Otherwise, this test endpoint won't work correctly
    
    // Forward the request to the webhook handler
    const response = await fetch(cartUpdateUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body,
    });
    
    // Return the response from the webhook handler
    const result = await response.json();
    
    return NextResponse.json({
      message: 'Test webhook forwarded to handler',
      status: response.status,
      result
    });
  } catch (error) {
    console.error('Error in test webhook:', error);
    return NextResponse.json(
      { error: 'Error processing test webhook', details: String(error) },
      { status: 500 }
    );
  }
} 