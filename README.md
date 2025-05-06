# Vex Shopify - Automatic Cart Addition

A Next.js application that monitors Shopify cart updates via webhooks and automatically adds a hidden product when specific trigger products are detected in the cart.

## Setup Instructions

### 1. Environment Variables

Create a `.env.local` file in the root of your project with the following environment variables:

```
SHOPIFY_API_SECRET=your_webhook_secret_key
SHOPIFY_STOREFRONT_ACCESS_TOKEN=your_storefront_api_token
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
HIDDEN_VARIANT_ID=the_variant_id_to_add
TRIGGER_VARIANT_IDS=trigger_variant_id_1,trigger_variant_id_2
```

### 2. Create a Custom App in Shopify

1. Log in to your Shopify Admin dashboard
2. Go to **Apps > App and sales channel settings > Develop apps**
3. Click **Create an app**
4. Name your app (e.g., "Automatic Cart Addition")
5. Set appropriate app configuration
6. Under **Configuration > API scopes**, add the required permissions:
   - `unauthenticated_write_checkouts` (or appropriate cart/checkout scopes)
7. Install the app to your store
8. Note down your **API secret key** and **Storefront API access token**

### 3. Configure Webhook in Shopify

1. Go to **Settings > Notifications > Webhooks**
2. Create a new webhook
3. Choose `carts/update` for the event type
4. Set the URL to `https://your-deployed-domain.com/api/webhook/cart-update`
5. Choose JSON format
6. Save the webhook

### 4. Configure the Hidden Product

1. Create a product in Shopify that you want to be automatically added
2. Note its Variant ID (found in the URL when editing the variant)
3. Make sure the product is:
   - Set as "Active"
   - Removed from all sales channels (to keep it hidden)

### 5. Deploy to Vercel

1. Push your code to a GitHub repository
2. Connect your repository to Vercel
3. Add your environment variables in the Vercel project settings
4. Deploy!

## Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

## Testing the Webhook Locally

For local development, you can use tools like ngrok to expose your localhost to the internet:

```bash
# Install ngrok if you haven't
npm install -g ngrok

# Start your Next.js dev server
npm run dev

# In another terminal, expose your local server
ngrok http 3000
```

Use the generated ngrok URL in your Shopify webhook configuration.

## How It Works

1. When a customer adds an item to their cart, Shopify sends a webhook notification to your endpoint
2. The endpoint verifies the webhook signature to ensure it's actually from Shopify
3. It checks if any of the configured trigger products are in the cart
4. If a trigger product is found and the hidden product isn't already in the cart:
   - It uses the Storefront API to add the hidden product to the cart
   - The hidden product will appear in the customer's cart automatically

## Troubleshooting

If you're experiencing issues:

1. Check your environment variables are correctly set
2. Verify that your webhook is active in Shopify
3. Ensure your custom app has the correct API permissions
4. Check the server logs for any errors

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
