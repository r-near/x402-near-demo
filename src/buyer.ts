import { Near } from "near-kit"
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

  const near = new Near({
    network: { rpcUrl: NEAR_RPC, networkId: "testnet" },
    privateKey: BUYER_PRIVATE_KEY as `ed25519:${string}`,
    defaultSignerId: BUYER_ACCOUNT_ID,
  })

  console.log(pc.dim("📊 Checking balances..."))
  const initialBalanceStr = await near.view<string>(TOKEN_ACCOUNT_ID, "ft_balance_of", {
    account_id: BUYER_ACCOUNT_ID,
  })
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
  const { payload } = await near
    .transaction(TOKEN_ACCOUNT_ID)
    .functionCall(
      TOKEN_ACCOUNT_ID,
      "ft_transfer",
      {
        receiver_id: SELLER_ACCOUNT_ID,
        amount: paymentReq.amountExactAtomic,
        memo: `x402 payment ${invoice.id}`,
      },
      { attachedDeposit: "1 yocto", gas: "30 Tgas" },
    )
    .delegate({ blockHeightOffset: 600 })

  // Build X-PAYMENT header
  const payment = {
    scheme: "near-delegate-exact",
    network: paymentReq.network,
    asset: paymentReq.asset,
    payTo: paymentReq.payTo,
    delegateB64: payload,
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
    const finalBalanceStr = await near.view<string>(TOKEN_ACCOUNT_ID, "ft_balance_of", {
      account_id: BUYER_ACCOUNT_ID,
    })
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
