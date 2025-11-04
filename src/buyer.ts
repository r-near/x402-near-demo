import { Account } from "@near-js/accounts"
import type { KeyPairString } from "@near-js/crypto"
import { JsonRpcProvider } from "@near-js/providers"
import { KeyPairSigner } from "@near-js/signers"
import { actionCreators, encodeSignedDelegate } from "@near-js/transactions"
import pc from "picocolors"

const {
  NEAR_RPC = "https://rpc.testnet.near.org",
  TOKEN_ACCOUNT_ID,
  SELLER_ACCOUNT_ID,
  SELLER_PORT = "4021",
  BUYER_ACCOUNT_ID,
  BUYER_PRIVATE_KEY,
} = process.env

if (!TOKEN_ACCOUNT_ID || !SELLER_ACCOUNT_ID) {
  throw new Error("Missing TOKEN_ACCOUNT_ID/SELLER_ACCOUNT_ID")
}
if (!BUYER_ACCOUNT_ID || !BUYER_PRIVATE_KEY) {
  throw new Error("Missing BUYER creds")
}

function toB64(u8: Uint8Array) {
  return Buffer.from(u8).toString("base64")
}

interface AcceptsEntry {
  scheme: string
  network: string
  asset: string
  payTo: string
  amountExactAtomic: string
  maxTimeoutSeconds: number
  mimeType: string
  resource: string
  description: string
}

interface PaymentResponse {
  accepts: AcceptsEntry[]
  invoice: { id: string; createdAt: number }
}

async function main() {
  const url = `http://localhost:${SELLER_PORT}/weather?city=San%20Jose`

  console.log(pc.cyan("\n🌐 x402 Payment Demo - NEAR Meta-Transactions\n"))

  // Get initial balance
  if (!BUYER_ACCOUNT_ID || !BUYER_PRIVATE_KEY || !TOKEN_ACCOUNT_ID || !SELLER_ACCOUNT_ID) {
    throw new Error("Missing required environment variables")
  }

  const provider = new JsonRpcProvider({ url: NEAR_RPC })
  const signer = KeyPairSigner.fromSecretKey(BUYER_PRIVATE_KEY as KeyPairString)
  const buyer = new Account(BUYER_ACCOUNT_ID, provider, signer)

  console.log(pc.dim("📊 Checking balances..."))
  const initialBalance = (await provider.query({
    request_type: "call_function",
    account_id: TOKEN_ACCOUNT_ID,
    method_name: "ft_balance_of",
    args_base64: Buffer.from(JSON.stringify({ account_id: BUYER_ACCOUNT_ID })).toString("base64"),
    finality: "final",
  })) as unknown as { result: number[] }
  const initialBalanceStr = JSON.parse(Buffer.from(initialBalance.result).toString())
  console.log(pc.dim(`  Your balance: ${Number(initialBalanceStr) / 1e6} USDC\n`))

  // First call → get 402 with payment requirements
  console.log(pc.yellow("🔒 Requesting protected resource..."))
  let res = await fetch(url)
  if (res.status !== 402) {
    console.log(pc.red(`❌ Expected 402, got: ${res.status}`), await res.text())
    return
  }

  const { accepts, invoice } = (await res.json()) as PaymentResponse
  const paymentReq = accepts[0]
  if (!paymentReq) {
    console.log(pc.red("❌ No payment options in 402 response"))
    return
  }

  const priceUSDC = Number(paymentReq.amountExactAtomic) / 1e6
  console.log(pc.yellow(`  💰 Payment required: ${pc.bold(`${priceUSDC} USDC`)}`))
  console.log(pc.dim(`  Paying to: ${SELLER_ACCOUNT_ID}\n`))

  // Build ft_transfer call with exact amount from seller's 402
  console.log(pc.dim("✍️  Signing meta-transaction (gasless)..."))
  const transfer = actionCreators.functionCall(
    "ft_transfer",
    Buffer.from(
      JSON.stringify({
        receiver_id: SELLER_ACCOUNT_ID,
        amount: paymentReq.amountExactAtomic,
        memo: `x402 payment ${invoice.id}`,
      }),
    ),
    30_000_000_000_000n, // 30 Tgas
    1n, // 1 yoctoNEAR
  )

  const [, signedDelegate] = await buyer.createSignedMetaTransaction(
    TOKEN_ACCOUNT_ID,
    [transfer],
    600,
  )

  // Build X-PAYMENT header
  const payment = {
    scheme: "near-delegate-exact",
    network: paymentReq.network,
    asset: paymentReq.asset,
    payTo: paymentReq.payTo,
    delegateB64: toB64(encodeSignedDelegate(signedDelegate)),
    invoiceId: invoice.id,
  }

  // Retry with payment
  console.log(pc.dim("📡 Submitting payment to facilitator...\n"))
  const startTime = Date.now()
  res = await fetch(url, {
    headers: { "x-payment": Buffer.from(JSON.stringify(payment)).toString("base64") },
  })
  const duration = ((Date.now() - startTime) / 1000).toFixed(2)

  if (res.status === 200) {
    console.log(pc.green(`✅ Payment confirmed in ${duration}s`))

    const data = (await res.json()) as { report: Record<string, unknown>; paid: { tx: string } }
    const receipt = res.headers.get("x-payment-response")
    const settlement = receipt
      ? (JSON.parse(Buffer.from(receipt, "base64").toString("utf8")) as { txHash?: string })
      : null

    if (settlement?.txHash) {
      console.log(pc.blue(`  🔗 Transaction: https://testnet.nearblocks.io/txns/${settlement.txHash}\n`))
    }

    console.log(pc.cyan("📦 Resource unlocked:"))
    console.log(`  ${JSON.stringify(data.report)}\n`)

    // Check final balance
    const finalBalance = (await provider.query({
      request_type: "call_function",
      account_id: TOKEN_ACCOUNT_ID,
      method_name: "ft_balance_of",
      args_base64: Buffer.from(JSON.stringify({ account_id: BUYER_ACCOUNT_ID })).toString("base64"),
      finality: "final",
    })) as unknown as { result: number[] }
    const finalBalanceStr = JSON.parse(Buffer.from(finalBalance.result).toString())
    console.log(pc.dim("📊 Updated balance:"))
    console.log(pc.dim(`  Your balance: ${Number(finalBalanceStr) / 1e6} USDC`))
    console.log(pc.dim(`  Amount paid: ${priceUSDC} USDC`))
  } else {
    console.log(pc.red(`❌ Payment failed: ${res.status}`))
    console.dir(await res.json(), { depth: null })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
