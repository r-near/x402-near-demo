# x402 on NEAR

**Gasless, programmable payments for HTTP APIs using NEAR meta-transactions.**

This is a working implementation of the [x402 protocol](https://x402.org) on NEAR Protocol. It turns `402 Payment Required` into a real payment system where clients can pay for API access without holding gas tokens—perfect for AI agents, headless services, and programmatic API consumption.

## What This Does

You want to charge for API access. Your clients don't want wallets, popups, or gas management.

With x402 on NEAR:
- **Clients pay with tokens, not NEAR** - they sign off-chain, a relayer pays gas
- **No wallet UI** - pure HTTP headers, works in any client
- **Per-request pricing** - charge $0.001 per API call if you want
- **Instant settlement** - payment confirmed on-chain before returning data

**Perfect for:** AI agents, data APIs, rate-limited services, paywalled content.

## The Flow

```
1. Client → Seller:  GET /weather
   Seller → Client:  402 Payment Required + payment instructions

2. Client signs NEAR meta-transaction (off-chain, gasless)

3. Client → Seller:  GET /weather + X-PAYMENT header
   Seller → Relayer:  Verify + settle transaction (relayer pays gas)
   Seller → Client:  200 OK + weather data + receipt
```

**Key insight:** The client just signs. The relayer submits and pays gas. The seller gets paid before returning data.

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Copy and configure .env
cp .env.example .env
# Edit .env with your NEAR testnet accounts and token

# 3. Run services (in separate terminals)
bun run facilitator  # Starts relayer on :4022
bun run seller       # Starts weather API on :4021
bun run buyer        # Runs payment demo
```

You'll see:
- Initial `402` response with payment requirements
- Client signs meta-transaction (no gas needed)
- Settlement confirmation with transaction hash
- Weather data returned after payment
- Token balance change (before/after)

## How It Works

Three simple services:

### 1. **Seller** (`src/seller.ts`)
Your protected API. Returns `402` with payment requirements on first call. On retry with `X-PAYMENT` header, calls facilitator to verify and settle, then returns your data.

```typescript
// Price lives with the seller
PRICE_ATOMIC=10000  // 0.01 USDC (6 decimals)
```

### 2. **Facilitator** (`src/facilitator.ts`)
The relayer/verifier. Has two endpoints:
- `POST /verify` - Validates the signed meta-transaction matches payment requirements
- `POST /settle` - Submits transaction on-chain and pays gas

### 3. **Buyer** (`src/buyer.ts`)
Your client (or an agent). Gets `402`, signs a NEAR `DelegateAction` that transfers tokens to seller, retries with `X-PAYMENT` header.

## Setup Requirements

### NEAR Testnet Accounts

You need three accounts:

1. **Buyer** - holds tokens, signs off-chain (no NEAR needed)
2. **Seller** - receives payments (must be storage-registered on token)
3. **Relayer** - submits transactions and pays gas (funded with NEAR)

### Token Setup

Use any NEP-141 token on testnet. For testing, `wrap.testnet` (wNEAR) works great.

**Important:** Both buyer and seller must be storage-registered:

```bash
# For buyer
near contract call-function as-transaction wrap.testnet storage_deposit \
  json-args '{"account_id":"buyer.testnet"}' \
  prepaid-gas 30Tgas attached-deposit 0.1NEAR \
  sign-as buyer.testnet network-config testnet \
  sign-with-legacy-keychain send

# For seller
near contract call-function as-transaction wrap.testnet storage_deposit \
  json-args '{"account_id":"seller.testnet"}' \
  prepaid-gas 30Tgas attached-deposit 0.1NEAR \
  sign-as seller.testnet network-config testnet \
  sign-with-legacy-keychain send
```

### Environment Configuration

```bash
# Network
NEAR_NETWORK=testnet
NEAR_RPC=https://rpc.testnet.near.org

# Token (NEP-141 contract)
TOKEN_ACCOUNT_ID=wrap.testnet

# Accounts
SELLER_ACCOUNT_ID=seller.testnet
RELAYER_ACCOUNT_ID=relayer.testnet
RELAYER_PRIVATE_KEY=ed25519:xxx...

BUYER_ACCOUNT_ID=buyer.testnet
BUYER_PRIVATE_KEY=ed25519:yyy...

# Price in atomic units (respect token decimals!)
# USDC (6 decimals): 10000 = 0.01 USDC
# wNEAR (24 decimals): 10000000000000000000000 = 0.01 NEAR
PRICE_ATOMIC=10000

# Ports
SELLER_PORT=4021
FACILITATOR_PORT=4022
```

## NEAR Meta-Transactions Explained

**DelegateAction (NEP-366)** is NEAR's meta-transaction primitive:

1. **Buyer** signs a `DelegateAction` off-chain (no gas needed)
2. **Relayer** wraps it in a regular transaction and submits (pays gas)
3. NEAR executes the inner action as if the buyer sent it

In this demo:
- Buyer signs: `ft_transfer(seller, amount)` on token contract
- Relayer posts: `signedDelegate(buyer's signature)`
- Result: Tokens move from buyer → seller, relayer pays gas

## Project Structure

```
src/
├── facilitator.ts   # Relayer (/verify + /settle endpoints)
├── seller.ts        # Protected API (402 → payment → 200)
└── buyer.ts         # Headless client (signs + pays)

.env.example         # Configuration template
package.json         # Bun scripts (facilitator, seller, buyer)
```

## Troubleshooting

**`PAYMENT_INVALID: Delegate missing required transfer`**
- Your signed meta-tx doesn't include `ft_transfer` to the seller for the exact amount

**`PAYMENT_NOT_SETTLED`**
- Seller or buyer not storage-registered on token contract
- Relayer account out of NEAR (can't pay gas)
- Check relayer has enough NEAR: `near account view-account-summary relayer.testnet network-config testnet now`

**Wrong decimals / amounts**
- `PRICE_ATOMIC` must match token decimals exactly
- USDC = 6 decimals (`1000000` = 1 USDC)
- wNEAR = 24 decimals (`1000000000000000000000000` = 1 NEAR)

**Buyer "needs gas"?**
- Not for payments! But storage registration requires one-time NEAR deposit
- In production, relayer can sponsor storage registration for new users

## Production Considerations

Before deploying:

- **Nonce/replay protection**: Add TTL and invoice expiry checks
- **Rate limiting**: Protect `/verify` and `/settle` endpoints
- **Relayer monitoring**: Track spend, implement sender allowlists
- **Token validation**: Verify token metadata (decimals) on startup
- **Idempotency**: Handle duplicate payment submissions gracefully
- **Observability**: Log settlement success/failure rates

## The x402 Protocol

x402 is an open protocol for HTTP-native payments. This implementation follows the spec:

- **`402 Payment Required`** response with `accepts[]` array
- **`X-PAYMENT`** request header with signed transaction
- **`X-PAYMENT-RESPONSE`** response header with settlement receipt

The protocol is chain-agnostic—this demo uses NEAR, but x402 also works on EVM (EIP-3009) and Solana (Token-2022).

## Why NEAR?

NEAR's meta-transactions make this particularly elegant:

- **True gasless UX** - buyers never touch NEAR token
- **Fast finality** - 1-2 second settlement
- **Low cost** - relayer pays ~0.0003 NEAR per transaction
- **No smart contracts needed** - works with any NEP-141 token

## License

MIT

---

**Questions?** Open an issue. **Want to contribute?** PRs welcome.
