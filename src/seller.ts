import { Hono } from "hono"

const {
  NEAR_NETWORK = "testnet",
  TOKEN_ACCOUNT_ID,
  SELLER_ACCOUNT_ID,
  PRICE_ATOMIC = "1000",
  SELLER_PORT = "4021",
  FACILITATOR_PORT = "4022",
} = process.env

if (!TOKEN_ACCOUNT_ID || !SELLER_ACCOUNT_ID) {
  throw new Error("Missing TOKEN_ACCOUNT_ID or SELLER_ACCOUNT_ID in seller env")
}

// Build the x402-style NEAR "accepts" entry with exact amount
function buildAccepts(resource: string) {
  return [
    {
      scheme: "near-delegate-exact",
      network: NEAR_NETWORK,
      asset: TOKEN_ACCOUNT_ID, // NEP-141 token id
      payTo: SELLER_ACCOUNT_ID, // seller revenue account
      amountExactAtomic: PRICE_ATOMIC, // << price lives here
      maxTimeoutSeconds: 60,
      mimeType: "application/json",
      resource,
      description: `Weather for ${(Number(PRICE_ATOMIC) / 1e6).toFixed(6)} (assuming 6 decimals)`,
    },
  ]
}

const app = new Hono()

app.get("/weather", async (c) => {
  const paymentHeader = c.req.header("x-payment")

  // No payment? Return 402 with payment instructions
  if (!paymentHeader) {
    return c.json(
      {
        message: "Payment Required",
        accepts: buildAccepts(c.req.url),
        invoice: { id: crypto.randomUUID(), createdAt: Date.now() },
      },
      402,
    )
  }

  try {
    const payment = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"))
    const required = buildAccepts(c.req.url)[0]

    // Verify payment structure
    const verifyRes = await fetch(`http://localhost:${FACILITATOR_PORT}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload: payment, paymentDetails: required }),
    })
    const verification = (await verifyRes.json()) as { valid: boolean; error?: string }
    if (!verification.valid) {
      return c.json({ error: "PAYMENT_INVALID", details: verification.error }, 402)
    }

    // Settle on-chain
    const settleRes = await fetch(`http://localhost:${FACILITATOR_PORT}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delegateB64: payment.delegateB64 }),
    })
    const settlement = (await settleRes.json()) as { ok: boolean; txHash?: string; error?: string }
    if (!settlement.ok) {
      return c.json({ error: "PAYMENT_NOT_SETTLED", details: settlement.error }, 402)
    }

    // Success! Return data + receipt
    c.header("x-payment-response", Buffer.from(JSON.stringify(settlement)).toString("base64"))
    return c.json({
      report: { weather: "sunny", temperatureF: 70 },
      paid: {
        asset: TOKEN_ACCOUNT_ID,
        amount: required?.amountExactAtomic ?? "0",
        tx: settlement.txHash,
      },
    })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    return c.json({ error: "PAYMENT_ERROR", details: error }, 402)
  }
})

export default {
  port: Number(SELLER_PORT),
  fetch: app.fetch,
}
