import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

// This is a webhook handler for the "checkout/completed" or "orders/create" events
// It detects when a qualifying purchase is made and adds a free item directly to the order
// for fulfillment rather than just flagging it

// This will eventually be populated from environment variables
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || '';
const TRIGGER_VARIANT_IDS = (process.env.TRIGGER_VARIANT_IDS || '').split(',');
const OG_VARIANT_ID = process.env.OG_VARIANT_ID || '';
const SHOPIFY_ADMIN_API_KEY = process.env.SHOPIFY_ADMIN_API_KEY || '';
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || '';
const BYPASS_WEBHOOK_VERIFICATION = process.env.BYPASS_WEBHOOK_VERIFICATION === 'true';

// TypeScript interfaces for Shopify checkout data
interface LineItem {
  variant_id: string | number;
  product_id?: string | number;
  quantity: number;
  [key: string]: unknown;
}

interface ShopifyOrder {
  id: string;
  order_number: string;
  line_items: LineItem[];
  [key: string]: unknown;
}

interface AdminApiResponse {
  data?: {
    orderEdit?: {
      calculatedLineItems?: {
        edges: Array<{
          node: {
            id: string;
          };
        }>;
      };
      id: string;
      userErrors: Array<{
        field: string | null;
        message: string;
      }>;
    };
    orderEditAddVariant?: {
      calculatedLineItem: {
        id: string;
      };
      userErrors: Array<{
        field: string | null;
        message: string;
      }>;
    };
    orderEditCommit?: {
      order: {
        id: string;
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
 * Checks if an order contains any of the trigger variant IDs
 */
function hasTriggerProduct(order: ShopifyOrder): boolean {
  if (!order.line_items || !Array.isArray(order.line_items) || TRIGGER_VARIANT_IDS.length === 0) {
    return false;
  }

  return order.line_items.some((item: LineItem) => 
    TRIGGER_VARIANT_IDS.includes(String(item.product_id))
  );
}

/**
 * Checks if an order already contains the OG Pack
 */
function hasOGPack(order: ShopifyOrder): boolean {
  if (!order.line_items || !Array.isArray(order.line_items) || !OG_VARIANT_ID) {
    return false;
  }

  return order.line_items.some((item: LineItem) => 
    String(item.product_id) === OG_VARIANT_ID
  );
}

/**
 * Adds the free item directly to the order using Admin API
 */
async function addFreeItemToOrder(orderId: string): Promise<AdminApiResponse | null> {
  if (!SHOPIFY_ADMIN_API_KEY || !OG_VARIANT_ID) {
    console.error('Missing required environment variables for API call');
    return null;
  }

  const graphqlEndpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-04/graphql.json`;
  
  try {
    // Step 1: Begin an order edit
    const beginEditMutation = `
      mutation beginEdit($id: ID!) {
        orderEdit(id: $id) {
          id
          calculatedLineItems(first: 5) {
            edges {
              node {
                id
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

    const beginEditResponse = await fetch(graphqlEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY
      },
      body: JSON.stringify({
        query: beginEditMutation,
        variables: { id: orderId }
      })
    });

    if (!beginEditResponse.ok) {
      throw new Error(`HTTP error! status: ${beginEditResponse.status}`);
    }

    const beginEditResult = await beginEditResponse.json();
    console.log('Begin edit result:', JSON.stringify(beginEditResult, null, 2));

    if (beginEditResult.errors || (beginEditResult.data?.orderEdit?.userErrors && beginEditResult.data.orderEdit.userErrors.length > 0)) {
      throw new Error('Error beginning order edit: ' + JSON.stringify(beginEditResult.errors || beginEditResult.data?.orderEdit?.userErrors));
    }

    const orderEditId = beginEditResult.data.orderEdit.id;

    // Step 2: Add the variant to the order
    const addVariantMutation = `
      mutation addVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
        orderEditAddVariant(
          id: $id,
          variantId: $variantId,
          quantity: $quantity,
          allowDuplicates: false
        ) {
          calculatedLineItem {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const addVariantResponse = await fetch(graphqlEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY
      },
      body: JSON.stringify({
        query: addVariantMutation,
        variables: { 
          id: orderEditId,
          variantId: `gid://shopify/ProductVariant/${OG_VARIANT_ID}`,
          quantity: 1
        }
      })
    });

    if (!addVariantResponse.ok) {
      throw new Error(`HTTP error! status: ${addVariantResponse.status}`);
    }

    const addVariantResult = await addVariantResponse.json();
    console.log('Add variant result:', JSON.stringify(addVariantResult, null, 2));

    if (addVariantResult.errors || (addVariantResult.data?.orderEditAddVariant?.userErrors && addVariantResult.data.orderEditAddVariant.userErrors.length > 0)) {
      throw new Error('Error adding variant to order: ' + JSON.stringify(addVariantResult.errors || addVariantResult.data?.orderEditAddVariant?.userErrors));
    }

    // Step 3: Set the new line item price to $0 (free)
    const lineItemId = addVariantResult.data.orderEditAddVariant.calculatedLineItem.id;
    
    const updateLineItemMutation = `
      mutation updateLineItem($id: ID!, $lineItemId: ID!, $price: MoneyInput!) {
        orderEditSetQuantity(
          id: $id,
          lineItemId: $lineItemId,
          quantity: 1,
          recomputeTaxes: true
        ) {
          calculatedLineItem {
            id
          }
          userErrors {
            field
            message
          }
        }
        orderEditUpdateLineItem(
          id: $id,
          lineItemId: $lineItemId,
          price: $price
        ) {
          calculatedLineItem {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const updateLineItemResponse = await fetch(graphqlEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY
      },
      body: JSON.stringify({
        query: updateLineItemMutation,
        variables: { 
          id: orderEditId,
          lineItemId: lineItemId,
          price: {
            amount: "0.00",
            currencyCode: "USD" // Use appropriate currency for your store
          }
        }
      })
    });

    if (!updateLineItemResponse.ok) {
      throw new Error(`HTTP error! status: ${updateLineItemResponse.status}`);
    }

    const updateLineItemResult = await updateLineItemResponse.json();
    console.log('Update line item result:', JSON.stringify(updateLineItemResult, null, 2));

    // Step 4: Commit the order edit
    const commitMutation = `
      mutation commitEdit($id: ID!) {
        orderEditCommit(
          id: $id,
          notifyCustomer: false, 
          staffNote: "Added free item as part of promotion"
        ) {
          order {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const commitResponse = await fetch(graphqlEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY
      },
      body: JSON.stringify({
        query: commitMutation,
        variables: { id: orderEditId }
      })
    });

    if (!commitResponse.ok) {
      throw new Error(`HTTP error! status: ${commitResponse.status}`);
    }

    const commitResult = await commitResponse.json();
    console.log('Commit result:', JSON.stringify(commitResult, null, 2));

    if (commitResult.errors || (commitResult.data?.orderEditCommit?.userErrors && commitResult.data.orderEditCommit.userErrors.length > 0)) {
      throw new Error('Error committing order edit: ' + JSON.stringify(commitResult.errors || commitResult.data?.orderEditCommit?.userErrors));
    }

    return commitResult;
  } catch (error) {
    console.error('Error updating order:', error);
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
    const order = JSON.parse(rawBody) as ShopifyOrder;

    // Log order details for debugging
    console.log('Received order webhook:', JSON.stringify(order, null, 2));
    
    if (order.line_items) {
      console.log('Order line items details:', JSON.stringify(order.line_items, null, 2));
    }

    // Check if order contains a trigger product and doesn't already have the OG Pack
    if (hasTriggerProduct(order) && !hasOGPack(order)) {
      console.log('Trigger condition met, adding free item to order');
      
      // Extract order ID in the format Shopify expects
      const orderId = order.id;
      
      if (!orderId) {
        console.error('Could not determine order ID from webhook payload');
        return NextResponse.json({ error: 'Missing order ID' }, { status: 400 });
      }

      // Add the free item directly to the order
      const result = await addFreeItemToOrder(orderId);
      
      if (!result || result.errors) {
        console.error('Error adding free item to order:', result?.errors || 'Unknown error');
        return NextResponse.json(
          { error: 'Failed to add free item to order', details: result?.errors || 'Unknown error' },
          { status: 500 }
        );
      }

      return NextResponse.json(
        { success: true, message: 'Free item added to order' },
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