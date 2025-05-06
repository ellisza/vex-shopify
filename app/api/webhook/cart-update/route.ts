import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

// This will eventually be populated from environment variables
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || '';
const HIDDEN_VARIANT_ID = process.env.HIDDEN_VARIANT_ID || '';
const TRIGGER_VARIANT_IDS = (process.env.TRIGGER_VARIANT_IDS || '').split(',');
const SHOPIFY_STOREFRONT_ACCESS_TOKEN = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || '';
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || '';
const BYPASS_WEBHOOK_VERIFICATION = process.env.BYPASS_WEBHOOK_VERIFICATION === 'true';

// TypeScript interfaces for Shopify cart data
interface CartItem {
  variant_id: string | number;
  quantity: number;
  id?: string;
  product_id?: string | number;
  [key: string]: unknown;
}

interface ShopifyCart {
  id?: string;
  token?: string;
  items: CartItem[];
  [key: string]: unknown;
}

interface StorefrontApiResponse {
  data?: {
    cartLinesAdd?: {
      cart: {
        id: string;
        lines: {
          edges: Array<{
            node: {
              id: string;
              merchandise: {
                id: string;
              };
              quantity: number;
            };
          }>;
        };
      };
      userErrors: Array<{
        field: string | null;
        message: string;
      }>;
    };
  };
  errors?: Array<{
    message: string;
    [key: string]: unknown;
  }>;
}

/**
 * Verifies that the webhook request is genuinely from Shopify
 */
function verifyShopifyWebhook(
  body: string,
  hmacHeader: string | null
): boolean {
  // If in development mode and bypass is enabled, skip verification
  if (BYPASS_WEBHOOK_VERIFICATION) {
    console.warn('⚠️ Webhook verification bypassed - NEVER use this in production!');
    return true;
  }

  if (!SHOPIFY_WEBHOOK_SECRET || !hmacHeader) return false;

  const generatedHash = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(body)
    .digest('base64');

  return crypto.timingSafeEqual(
    Buffer.from(generatedHash),
    Buffer.from(hmacHeader)
  );
}

/**
 * Checks if a cart contains any of the trigger variant IDs
 */
function hasTriggerProduct(cart: ShopifyCart): boolean {
  if (!cart?.items || !Array.isArray(cart.items) || TRIGGER_VARIANT_IDS.length === 0) {
    return false;
  }

  return cart.items.some((item: CartItem) => 
    TRIGGER_VARIANT_IDS.includes(String(item.variant_id))
  );
}

/**
 * Checks if the hidden product is already in the cart
 */
function hasHiddenProduct(cart: ShopifyCart): boolean {
  if (!cart?.items || !Array.isArray(cart.items) || !HIDDEN_VARIANT_ID) {
    return false;
  }

  return cart.items.some((item: CartItem) => 
    String(item.variant_id) === HIDDEN_VARIANT_ID
  );
}

/**
 * Adds the hidden product to the cart using Storefront API
 */
async function addHiddenProductToCart(cartId: string): Promise<StorefrontApiResponse | null> {
  if (!SHOPIFY_STOREFRONT_ACCESS_TOKEN || !HIDDEN_VARIANT_ID) {
    console.error('Missing required environment variables for API call');
    return null;
  }

  const graphqlEndpoint = `https://${SHOPIFY_STORE_DOMAIN}/api/2024-04/graphql.json`;
  
  const mutation = `
    mutation cartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
      cartLinesAdd(cartId: $cartId, lines: $lines) {
        cart {
          id
          lines(first: 10) {
            edges {
              node {
                id
                merchandise {
                  ... on ProductVariant {
                    id
                  }
                }
                quantity
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    cartId,
    lines: [
      {
        merchandiseId: `gid://shopify/ProductVariant/${HIDDEN_VARIANT_ID}`,
        quantity: 1
      }
    ]
  };

  try {
    const response = await fetch(graphqlEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_ACCESS_TOKEN
      },
      body: JSON.stringify({
        query: mutation,
        variables
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error adding product to cart:', error);
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    // Get the request body as text to verify the HMAC
    const rawBody = await request.text();
    
    // Verify webhook signature
    const hmacHeader = request.headers.get('x-shopify-hmac-sha256');
    const isVerified = verifyShopifyWebhook(rawBody, hmacHeader);
    
    if (!isVerified) {
      console.error('Invalid webhook signature');
      return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 });
    }

    // Parse the body after verification
    const cart = JSON.parse(rawBody) as ShopifyCart;

    console.log({cart});

    // Check if cart contains a trigger product but not the hidden product
    if (hasTriggerProduct(cart) && !hasHiddenProduct(cart)) {
      console.log('Trigger condition met, adding hidden product to cart');
      
      // Extract cart ID - the format will depend on what Shopify provides in the webhook payload
      // This might need adjustment based on the actual webhook payload structure
      const cartId = cart.id || cart.token;
      
      if (!cartId) {
        console.error('Could not determine cart ID from webhook payload');
        return NextResponse.json({ error: 'Missing cart ID' }, { status: 400 });
      }

      // Add the hidden product to the cart
      const result = await addHiddenProductToCart(cartId);
      
      if (result && result.data && result.data.cartLinesAdd && result.data.cartLinesAdd.userErrors && result.data.cartLinesAdd.userErrors.length > 0) {
        console.error('Error adding product:', result.data.cartLinesAdd.userErrors);
        return NextResponse.json(
          { error: 'Failed to add product', details: result.data.cartLinesAdd.userErrors },
          { status: 500 }
        );
      }

      return NextResponse.json(
        { success: true, message: 'Hidden product added to cart' },
        { status: 200 }
      );
    }

    // If conditions not met, just acknowledge receipt
    return NextResponse.json({ success: true, message: 'Webhook received' }, { status: 200 });
  } catch (error) {
    console.error('Error processing webhook:', error);
    return NextResponse.json(
      { error: 'Error processing webhook', details: String(error) },
      { status: 500 }
    );
  }
} 