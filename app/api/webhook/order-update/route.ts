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
  id: string | number;
  admin_graphql_api_id?: string;
  order_number: string | number;
  line_items: LineItem[];
  [key: string]: unknown;
}

interface AdminApiResponse {
  data?: {
    orderEditBegin?: {
      calculatedOrder: {
        id: string;
      };
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
    orderEditSetQuantity?: {
      calculatedLineItem: {
        id: string;
      };
      userErrors: Array<{
        field: string | null;
        message: string;
      }>;
    };
    orderEditAddLineItemDiscount?: {
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

  console.log('Checking for trigger products. Configured trigger IDs:', TRIGGER_VARIANT_IDS);
  
  for (const item of order.line_items) {
    console.log(`Line item product_id: ${item.product_id}, checking if in trigger list`);
    if (item.product_id && TRIGGER_VARIANT_IDS.includes(String(item.product_id))) {
      console.log(`Found matching trigger product: ${item.product_id}`);
      return true;
    }
  }
  
  return false;
}

/**
 * Checks if an order already contains the OG Pack
 */
function hasOGPack(order: ShopifyOrder): boolean {
  if (!order.line_items || !Array.isArray(order.line_items) || !OG_VARIANT_ID) {
    return false;
  }

  console.log(`Checking if order already has OG Pack (ID: ${OG_VARIANT_ID})`);
  
  for (const item of order.line_items) {
    // Check both product_id and variant_id since either could match
    if ((item.product_id && String(item.product_id) === OG_VARIANT_ID) || 
        (item.variant_id && String(item.variant_id) === OG_VARIANT_ID)) {
      console.log(`Order already has OG Pack`);
      return true;
    }
  }
  
  return false;
}

/**
 * Adds the free item directly to the order using Admin API and Order Edit operations
 */
async function addFreeItemToOrder(orderId: string | number): Promise<AdminApiResponse | null> {
  if (!SHOPIFY_ADMIN_API_KEY || !OG_VARIANT_ID) {
    console.error('Missing required environment variables for API call');
    return null;
  }

  const graphqlEndpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-04/graphql.json`;
  
  // Convert numeric order ID to required Shopify GraphQL ID format
  const orderGid = typeof orderId === 'number' || /^\d+$/.test(String(orderId))
    ? `gid://shopify/Order/${orderId}`
    : orderId;
    
  console.log(`Using order GID: ${orderGid}`);
  
  try {
    // Step 1: Begin an order edit session - this is the first required step for editing an order
    console.log('Starting order edit session');
    const beginEditMutation = `
      mutation {
        orderEditBegin(id: "${orderGid}") {
          calculatedOrder {
            id
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
        query: beginEditMutation
      })
    });

    if (!beginEditResponse.ok) {
      const statusText = await beginEditResponse.text();
      console.error(`HTTP error when beginning edit: ${beginEditResponse.status}, ${statusText}`);
      throw new Error(`HTTP error! status: ${beginEditResponse.status}, details: ${statusText}`);
    }

    const beginEditResult = await beginEditResponse.json();
    console.log('Begin edit response:', JSON.stringify(beginEditResult, null, 2));

    if (beginEditResult.errors || (beginEditResult.data?.orderEditBegin?.userErrors && beginEditResult.data.orderEditBegin.userErrors.length > 0)) {
      const errors = beginEditResult.errors || beginEditResult.data?.orderEditBegin?.userErrors;
      console.error('Error beginning order edit:', JSON.stringify(errors));
      throw new Error('Error beginning order edit: ' + JSON.stringify(errors));
    }

    if (!beginEditResult.data?.orderEditBegin?.calculatedOrder?.id) {
      console.error('No calculatedOrder ID returned:', JSON.stringify(beginEditResult));
      throw new Error('No calculatedOrder ID returned from orderEditBegin mutation');
    }

    const calculatedOrderId = beginEditResult.data.orderEditBegin.calculatedOrder.id;
    console.log(`Order edit session created with calculatedOrder ID: ${calculatedOrderId}`);

    // Step 2: Add the variant to the order
    // Ensure variant ID is in the correct format
    const variantGid = /^gid:\/\/shopify\/ProductVariant\//.test(OG_VARIANT_ID)
      ? OG_VARIANT_ID
      : `gid://shopify/ProductVariant/${OG_VARIANT_ID}`;
      
    console.log(`Adding variant with GID: ${variantGid}`);

    const addVariantMutation = `
      mutation {
        orderEditAddVariant(
          id: "${calculatedOrderId}", 
          variantId: "${variantGid}", 
          quantity: 1
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
        query: addVariantMutation
      })
    });

    if (!addVariantResponse.ok) {
      const statusText = await addVariantResponse.text();
      console.error(`HTTP error when adding variant: ${addVariantResponse.status}, ${statusText}`);
      throw new Error(`HTTP error! status: ${addVariantResponse.status}, details: ${statusText}`);
    }

    const addVariantResult = await addVariantResponse.json();
    console.log('Add variant response:', JSON.stringify(addVariantResult, null, 2));

    if (addVariantResult.errors || (addVariantResult.data?.orderEditAddVariant?.userErrors && addVariantResult.data.orderEditAddVariant.userErrors.length > 0)) {
      const errors = addVariantResult.errors || addVariantResult.data?.orderEditAddVariant?.userErrors;
      console.error('Error adding variant to order:', JSON.stringify(errors));
      throw new Error('Error adding variant to order: ' + JSON.stringify(errors));
    }

    if (!addVariantResult.data?.orderEditAddVariant?.calculatedLineItem?.id) {
      console.error('No calculatedLineItem ID returned:', JSON.stringify(addVariantResult));
      throw new Error('No calculatedLineItem ID returned from orderEditAddVariant mutation');
    }

    // Step 3: Get the line item ID for the newly added variant
    const lineItemId = addVariantResult.data.orderEditAddVariant.calculatedLineItem.id;
    console.log(`Added line item ID: ${lineItemId}`);

    // Step 4: Add a 100% discount to make the item free
    console.log('Adding 100% discount to make item free');
    const addDiscountMutation = `
      mutation {
        orderEditAddLineItemDiscount(
          discount: {
            description: "Free promotional item", 
            value: {
              percentage: 100
            }
          }, 
          id: "${calculatedOrderId}", 
          lineItemId: "${lineItemId}"
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

    const addDiscountResponse = await fetch(graphqlEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY
      },
      body: JSON.stringify({
        query: addDiscountMutation
      })
    });

    if (!addDiscountResponse.ok) {
      const statusText = await addDiscountResponse.text();
      console.error(`HTTP error when adding discount: ${addDiscountResponse.status}, ${statusText}`);
      throw new Error(`HTTP error! status: ${addDiscountResponse.status}, details: ${statusText}`);
    }

    const addDiscountResult = await addDiscountResponse.json();
    console.log('Add discount response:', JSON.stringify(addDiscountResult, null, 2));

    if (addDiscountResult.errors || (addDiscountResult.data?.orderEditAddLineItemDiscount?.userErrors && addDiscountResult.data.orderEditAddLineItemDiscount.userErrors.length > 0)) {
      const errors = addDiscountResult.errors || addDiscountResult.data?.orderEditAddLineItemDiscount?.userErrors;
      console.error('Error adding discount to line item:', JSON.stringify(errors));
      throw new Error('Error adding discount to line item: ' + JSON.stringify(errors));
    }

    // Step 5: Commit the changes to the order
    console.log('Committing order edit changes');
    const commitMutation = `
      mutation {
        orderEditCommit(
          id: "${calculatedOrderId}", 
          notifyCustomer: false, 
          staffNote: "Added free promotional item"
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
        query: commitMutation
      })
    });

    if (!commitResponse.ok) {
      const statusText = await commitResponse.text();
      console.error(`HTTP error when committing edit: ${commitResponse.status}, ${statusText}`);
      throw new Error(`HTTP error! status: ${commitResponse.status}, details: ${statusText}`);
    }

    const commitResult = await commitResponse.json();
    console.log('Commit response:', JSON.stringify(commitResult, null, 2));

    if (commitResult.errors || (commitResult.data?.orderEditCommit?.userErrors && commitResult.data.orderEditCommit.userErrors.length > 0)) {
      const errors = commitResult.errors || commitResult.data?.orderEditCommit?.userErrors;
      console.error('Error committing order edit:', JSON.stringify(errors));
      throw new Error('Error committing order edit: ' + JSON.stringify(errors));
    }

    console.log('Successfully added free item to order');
    return commitResult;
  } catch (error) {
    console.error('Error adding free item to order:', error);
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
    console.log('Received order webhook for order #', order.order_number);
    console.log('Admin GraphQL API ID:', order.admin_graphql_api_id);
    
    if (order.line_items) {
      console.log(`Order contains ${order.line_items.length} line items`);
      order.line_items.forEach((item, index) => {
        console.log(`Item ${index + 1}: product_id=${item.product_id}, variant_id=${item.variant_id}, quantity=${item.quantity}`);
      });
    }

    // Check if order contains a trigger product and doesn't already have the OG Pack
    if (hasTriggerProduct(order) && !hasOGPack(order)) {
      console.log('Trigger condition met, adding free item to order');
      
      // Extract order ID - use admin_graphql_api_id if available, otherwise numeric id
      const orderId = order.id || order.admin_graphql_api_id;
      
      if (!orderId) {
        console.error('Could not determine order ID from webhook payload');
        return NextResponse.json({ error: 'Missing order ID' }, { status: 400 });
      }

      console.log(`Adding free item to order ID: ${orderId}`);
      
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
    } else {
      console.log('Trigger conditions not met:');
      console.log('- Has trigger product:', hasTriggerProduct(order));
      console.log('- Already has OG pack:', hasOGPack(order));
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