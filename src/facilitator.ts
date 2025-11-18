import { deserialize } from "borsh"
import { Hono } from "hono"
import { Near, DelegateAction, SignedDelegate } from "near-kit"
import { z } from "zod"

// Borsh schema for deserializing SignedDelegate (NEP-366 format)
const SIGNED_DELEGATE_SCHEMA = new Map([
  [
    SignedDelegate,
    {
      kind: "struct",
      fields: [
        ["delegateAction", DelegateAction],
        ["signature", { kind: "struct", fields: [["data", ["u8"]]] }],
      ],
    },
  ],
  [
    DelegateAction,
    {
      kind: "struct",
      fields: [
        ["senderId", "string"],
        ["receiverId", "string"],
        ["actions", [{ kind: "option" }]],
        ["nonce", "u64"],
        ["maxBlockHeight", "u64"],
        ["publicKey", { kind: "struct", fields: [["data", ["u8"]]] }],
      ],
    },
  ],
])

const {
  NEAR_RPC = "https://rpc.testnet.near.org",
  TOKEN_ACCOUNT_ID,
  SELLER_ACCOUNT_ID,
  RELAYER_ACCOUNT_ID,
  RELAYER_PRIVATE_KEY,
  FACILITATOR_PORT = "4022",
} = process.env

if (!TOKEN_ACCOUNT_ID || !SELLER_ACCOUNT_ID || !RELAYER_ACCOUNT_ID || !RELAYER_PRIVATE_KEY) {
  throw new Error(
    "Missing required env vars in facilitator (TOKEN_ACCOUNT_ID, SELLER_*, RELAYER_*)",
  )
}

function decodeB64(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, "base64"))
}

function getNear(): Near {
  if (!RELAYER_ACCOUNT_ID || !RELAYER_PRIVATE_KEY) {
    throw new Error("RELAYER credentials not configured")
  }
  return new Near({
    network: "testnet",
    rpcUrl: NEAR_RPC,
    privateKey: RELAYER_PRIVATE_KEY as `ed25519:${string}`,
    defaultSignerId: RELAYER_ACCOUNT_ID,
  })
}

const PaymentPayload = z.object({
  scheme: z.literal("near-delegate-exact"),
  network: z.string(),
  asset: z.string(),
  payTo: z.string(),
  delegateB64: z.string(),
  invoiceId: z.string().optional(),
  maxAmountRequired: z.string().optional(),
})

const PaymentDetails = z.object({
  scheme: z.literal("near-delegate-exact"),
  network: z.string(),
  asset: z.string(),
  payTo: z.string(),
  amountExactAtomic: z.string(),
})

// Verify payment matches seller's requirements
function verifyPayment(
  payload: z.infer<typeof PaymentPayload>,
  required: z.infer<typeof PaymentDetails>,
): SignedDelegate {
  // Check basic fields match
  if (payload.asset !== required.asset) throw new Error("Asset mismatch")
  if (payload.payTo !== required.payTo) throw new Error("Recipient mismatch")
  if (payload.network !== required.network) throw new Error("Network mismatch")

  // Deserialize signed delegate
  const delegate = deserialize(
    SCHEMA.SignedDelegate,
    Buffer.from(decodeB64(payload.delegateB64)),
  ) as SignedDelegate

  if (delegate.delegateAction.receiverId !== required.asset) {
    throw new Error("Delegate must target token contract")
  }

  // Find ft_transfer action and verify amount + recipient
  const requiredAmount = BigInt(required.amountExactAtomic)
  let foundAmount: bigint | null = null

  for (const action of delegate.delegateAction.actions) {
    if ("functionCall" in action && action.functionCall) {
      const { methodName, args } = action.functionCall
      if (methodName === "ft_transfer" || methodName === "ft_transfer_call") {
        const argsStr = Buffer.from(args).toString("utf8")
        const parsed = JSON.parse(argsStr)
        const recipient = parsed.receiver_id || parsed.receiverId
        if (recipient === required.payTo) {
          foundAmount = BigInt(parsed.amount || "0")
        }
      }
    }
  }

  if (foundAmount === null) throw new Error("No transfer to seller found")
  if (foundAmount !== requiredAmount) throw new Error("Amount mismatch")

  return delegate
}

async function settlePayment(delegate: SignedDelegate) {
  const relayer = getRelayer()

  // Submit meta-tx: relayer sends to delegate sender with signedDelegate action
  const result = await relayer.signAndSendTransaction({
    receiverId: delegate.delegateAction.senderId,
    actions: [actionCreators.signedDelegate(delegate)],
  })

  return {
    ok: true,
    txHash: result.transaction.hash,
    blockHash: result.transaction_outcome.id,
    status: result.status,
  }
}

const app = new Hono()

app.post("/verify", async (c) => {
  try {
    const { paymentPayload, paymentDetails } = (await c.req.json()) as {
      paymentPayload: unknown
      paymentDetails: unknown
    }

    const payment = PaymentPayload.parse(paymentPayload)
    const required = PaymentDetails.parse(paymentDetails)
    const delegate = verifyPayment(payment, required)

    return c.json({ valid: true, sender: delegate.delegateAction.senderId })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    return c.json({ valid: false, error }, 400)
  }
})

app.post("/settle", async (c) => {
  try {
    const { delegateB64 } = (await c.req.json()) as { delegateB64: string }
    const delegate = deserialize(
      SCHEMA.SignedDelegate,
      Buffer.from(decodeB64(delegateB64)),
    ) as SignedDelegate

    const settlement = await settlePayment(delegate)
    return c.json(settlement)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    return c.json({ ok: false, error }, 400)
  }
})

export default {
  port: Number(FACILITATOR_PORT),
  fetch: app.fetch,
}
