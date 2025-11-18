# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an **x402 payment protocol demo on NEAR** - a three-component system that implements HTTP-native pay-per-request using `402 Payment Required` status codes with NEAR meta-transactions (DelegateAction/NEP-366) for **gasless payments**.

The x402 protocol enables programmatic micropayments without wallets, UIs, or the buyer needing gas tokens. The buyer signs off-chain, the facilitator (relayer) submits and pays gas, and the seller releases content upon settlement.

## Architecture

Three independent Bun+Hono services in `src/`:

1. **Facilitator (`src/facilitator.ts`)** - The relayer/verifier
   - `/verify` - Validates SignedDelegateAction matches payment requirements (asset, amount, recipient)
   - `/settle` - Submits the meta-transaction on-chain and pays gas using relayer credentials
   - Deserializes NEAR SignedDelegate using near-kit's `decodeSignedDelegateAction`, validates ft_transfer calls, and returns settlement receipts

2. **Seller (`src/seller.ts`)** - The protected API (weather endpoint)
   - Returns `402 Payment Required` with NEAR-specific `accepts[]` entry containing payment requirements
   - On retry with `X-PAYMENT` header, calls facilitator `/verify` then `/settle`
   - Returns `200 OK` with data + `X-PAYMENT-RESPONSE` header containing tx hash
   - Price lives in seller's environment (`PRICE_ATOMIC`)

3. **Buyer (`src/buyer.ts`)** - Headless payment client
   - Fetches `/weather`, receives 402 with payment instructions
   - Signs a SignedDelegateAction that calls `ft_transfer` to seller for exact amount
   - Retries with base64-encoded `X-PAYMENT` header containing the signed meta-tx
   - No NEAR needed - relayer pays all gas

## Payment Flow

```
Buyer → Seller: GET /weather
Seller → Buyer: 402 + {accepts: [{network, asset, payTo, amountExactAtomic, ...}]}

Buyer signs DelegateAction(ft_transfer to seller)
Buyer → Seller: GET /weather + X-PAYMENT: base64(SignedDelegateAction)

Seller → Facilitator: POST /verify (check asset/amount/recipient match)
Seller → Facilitator: POST /settle (submit meta-tx on-chain, relayer pays gas)
Seller → Buyer: 200 OK + weather JSON + X-PAYMENT-RESPONSE: base64(receipt)
```

## Key NEAR Concepts

- **Meta-transactions (DelegateAction)**: Buyer signs off-chain, facilitator submits on-chain and pays gas
- **NEP-141**: Fungible token standard used for payments (e.g., USDC, wNEAR)
- **Storage registration**: Both buyer and seller must be pre-registered on the token contract via `storage_deposit`
- **1 yoctoNEAR**: NEP-141 transfers require attaching exactly 1 yoctoNEAR (attached by relayer in inner call)
- **Atomic units**: `PRICE_ATOMIC` must match token decimals (USDC = 6, wNEAR = 24)

## near-kit Integration

This project uses [near-kit](https://kit.near.tools) - a modern TypeScript library for NEAR Protocol that simplifies blockchain interactions:

- **Simple initialization**: `new Near({ network, privateKey, defaultSignerId })` replaces manual Account/Provider/Signer setup
- **Clean view calls**: `near.view(contract, method, args)` instead of manual RPC queries
- **Transaction builder**: Fluent API with `.transaction().functionCall().delegate()` for creating meta-transactions
- **Built-in helpers**: `decodeSignedDelegateAction()` handles borsh deserialization automatically
- **Type safety**: Full TypeScript support with generic types for view/call methods

Key near-kit usage in this demo:
- **Buyer**: Creates delegate actions using `.transaction().functionCall().delegate()`
- **Facilitator**: Decodes and submits signed delegates using `decodeSignedDelegateAction()` and `.signedDelegateAction()`
- **Both**: Query balances with `near.view()` for cleaner, type-safe code

## Common Commands

```bash
# Install dependencies
bun install

# Start services (run in separate terminals)
bun run facilitator  # Starts relayer on :4022
bun run seller       # Starts weather API on :4021
bun run buyer        # Runs payment demo client

# Type checking
bun run typecheck

# Linting
bun run lint
```

## Environment Setup

Copy `.env.example` to `.env` and configure:

- **Accounts**: buyer, seller, relayer (all on testnet)
- **TOKEN_ACCOUNT_ID**: NEP-141 token contract (e.g., USDC contract address or `wrap.testnet`)
- **PRICE_ATOMIC**: Price in token atomic units (respect decimals!)
- **Private keys**: Buyer and relayer ed25519 keys (NEVER commit `.env`)

Both buyer and seller must be storage-registered on the token:
```bash
near call <token>.testnet storage_deposit '{"account_id":"<account>.testnet"}' --accountId <account>.testnet --amount 0.1
```

## x402 Protocol Specifics

- **Payment header**: `X-PAYMENT` contains base64(JSON) with `{scheme, network, asset, payTo, delegateB64, invoiceId}`
- **Receipt header**: `X-PAYMENT-RESPONSE` contains base64(JSON) with `{ok, txHash, blockHash, status}`
- **Scheme**: `"near-delegate-exact"` indicates NEAR meta-transaction with exact amount matching
- **Verification**: Facilitator deserializes SignedDelegate using `decodeSignedDelegateAction()`, finds `ft_transfer` action, validates recipient + amount
- **Settlement**: Facilitator uses near-kit's transaction builder to submit the signed delegate action on-chain

## Testing the Flow

1. Start facilitator: `bun run facilitator`
2. Start seller: `bun run seller`
3. Run buyer: `bun run buyer` - should show:
   - Initial 402 response with payment requirements
   - Meta-transaction signing (gasless)
   - Settlement confirmation with tx hash
   - Weather data after payment
   - Balance change (before/after)

## Production Hardening

When extending this demo:
- Add TTL/nonce validation to prevent replay attacks
- Rate limit facilitator endpoints
- Monitor relayer spend and implement sender allowlists
- Validate token metadata (decimals) on startup
- Implement retry logic with exponential backoff for settlement
- Add structured logging and observability for settlement failures

## Git Commits

Use conventional commit format with concise one-liners:
```
type: brief description
```

Common types:
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `chore:` - Maintenance tasks (deps, configs, scripts)
- `refactor:` - Code restructuring without behavior change

Examples:
- `feat: add retry logic for settlement failures`
- `fix: validate token decimals on startup`
- `docs: update README with storage registration steps`
- `chore: update dependencies to latest versions`
