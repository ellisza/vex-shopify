import { NextResponse } from 'next/server';

// This is a webhook handler for the "checkout/completed" or "orders/create" events
// It detects when a qualifying purchase is made and adds a free item directly to the order
// for fulfillment rather than just flagging it

// This will eventually be populated from environment variables
const OG_VARIANT_ID = process.env.OG_VARIANT_ID || '';
const SHOPIFY_ADMIN_API_KEY = process.env.SHOPIFY_ADMIN_API_KEY || '';
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || '';

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
 * Adds the free item directly to the order using Admin API and Order Edit operations
 */
async function addFreeItemToOrder(order: ShopifyOrder): Promise<AdminApiResponse | null> {
  if (!SHOPIFY_ADMIN_API_KEY || !OG_VARIANT_ID) {
    console.error('Missing required environment variables for API call');
    return null;
  }

  const graphqlEndpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-04/graphql.json`;
  
  // We need to ensure we're using the correct order ID format
  console.log('Raw order details:');
  console.log('- id:', order.id);
  console.log('- admin_graphql_api_id:', order.admin_graphql_api_id);
  console.log('- order_number:', order.order_number);
  
  // The ID value must be the GID format or it won't work
  let orderGid = order.admin_graphql_api_id;
  
  // If we don't have the GID format ID, try to construct it
  if (!orderGid || !orderGid.startsWith('gid://')) {
    const numericId = order.id;
    if (numericId) {
      orderGid = `gid://shopify/Order/${numericId}`;
    }
  }
  
  if (!orderGid) {
    console.error('Unable to determine order GID from order data:', order);
    throw new Error('Unable to determine order GID');
  }
  
  console.log(`Using order GID: ${orderGid}`);
  
  try {
    // Step 1: Begin an order edit session using the format from the docs
    console.log('Starting order edit session');
    const beginEditMutation = `
      mutation orderEditBegin($id: ID!) {
        orderEditBegin(id: $id) {
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
        query: beginEditMutation,
        variables: {
          id: orderGid
        }
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
      mutation orderEditAddVariant($allowDuplicates: Boolean, $id: ID!, $quantity: Int!, $variantId: ID!) {
        orderEditAddVariant(
          allowDuplicates: $allowDuplicates,
          id: $id,
          variantId: $variantId,
          quantity: $quantity
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
          allowDuplicate: false,
          id: calculatedOrderId,
          variantId: variantGid,
          quantity: 1
        }
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

    // Step 3: Commit the changes to the order
    console.log('Committing order edit changes');
    const commitMutation = `
      mutation orderEditCommit($id: ID!, $notifyCustomer: Boolean!, $staffNote: String) {
        orderEditCommit(
          id: $id,
          notifyCustomer: $notifyCustomer,
          staffNote: $staffNote
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
        variables: {
          id: calculatedOrderId,
          notifyCustomer: false,
          staffNote: "Added free promotional item"
        }
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

export async function GET() {
  try {
    // Hardcoded order data for testing
    const testOrder: ShopifyOrder = {
      id: 5380452647120,
      admin_graphql_api_id: 'gid://shopify/Order/5380452647120',
      order_number: 241132,
      line_items: []  // Not actually using this for our test
    };

    console.log('Test endpoint called with hardcoded order #', testOrder.order_number);
    console.log('Admin GraphQL API ID:', testOrder.admin_graphql_api_id);
    
    // First, fetch order details to verify it exists and check its status
    const graphqlEndpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-04/graphql.json`;
    console.log('Fetching order details...');
    
    const getOrderQuery = `
      query GetOrderDetails {
        order(id: "gid://shopify/Order/5380452647120") {
            id
            name
            createdAt
            currencyCode
        }
      }
    `;
    
    const orderResponse = await fetch(graphqlEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY
      },
      body: JSON.stringify({
        query: getOrderQuery
      })
    });
    
    if (!orderResponse.ok) {
      const statusText = await orderResponse.text();
      console.error(`HTTP error when fetching order: ${orderResponse.status}, ${statusText}`);
      throw new Error(`HTTP error! status: ${orderResponse.status}, details: ${statusText}`);
    }
    
    const orderResult = await orderResponse.json();
    console.log('Order details:', JSON.stringify(orderResult, null, 2));
    
    if (orderResult.errors) {
      console.error('Error fetching order:', orderResult.errors);
      return NextResponse.json(
        { error: 'Failed to fetch order', details: orderResult.errors },
        { status: 500 }
      );
    }
    
    // Fetch the default variant for the product
    console.log('Fetching product details...');
    const getProductDefaultVariantQuery = `
      query GetProductDefaultVariant {
        product(id: "gid://shopify/Product/8294799933648") {
          id
          title
          variants(first: 10) {
            edges {
              node {
                id
                title
              }
            }
          }
        }
      }
    `;
    
    const productResponse = await fetch(graphqlEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY
      },
      body: JSON.stringify({
        query: getProductDefaultVariantQuery
      })
    });

    if (!productResponse.ok) {
      const statusText = await productResponse.text();
      console.error(`HTTP error when fetching product: ${productResponse.status}, ${statusText}`);
      throw new Error(`HTTP error! status: ${productResponse.status}, details: ${statusText}`);
    }

    const productResult = await productResponse.json();
    console.log('Product details:', JSON.stringify(productResult, null, 2));

    if (productResult.errors) {
      console.error('Error fetching product:', productResult.errors);
      return NextResponse.json(
        { error: 'Failed to fetch product', details: productResult.errors },
        { status: 500 }
      );
    }

    // Extract the variant ID from the response
    const variantId = productResult.data?.product?.variants?.edges[0]?.node?.id;
    if (!variantId) {
      console.error('No variant ID found in product response');
      return NextResponse.json(
        { error: 'Failed to get variant ID from product' },
        { status: 500 }
      );
    }

    // Override the OG_VARIANT_ID with the fetched variant ID
    process.env.OG_VARIANT_ID = variantId;
    console.log(`Using variant ID: ${variantId}`);
    
    // Directly attempt to add the free item to the order
    console.log('Attempting to edit order...');
    const result = await addFreeItemToOrder(testOrder);
    
    if (!result || result.errors) {
      console.error('Error adding free item to order:', result?.errors || 'Unknown error');
      return NextResponse.json(
        { error: 'Failed to add free item to order', details: result?.errors || 'Unknown error' },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { 
        success: true, 
        message: 'Free item added to order',
        //result,
        product: productResult.data?.product
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error processing request:', error);
    return NextResponse.json(
      { error: 'Error processing request', details: String(error) },
      { status: 500 }
    );
  }
} 