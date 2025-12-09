require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const QRCode = require("qrcode");
const crypto = require("crypto");

// ts-khqr library (might be ESM internally; if require fails, check its README)
const tsKhqr = require("ts-khqr");
const { KHQR, CURRENCY, COUNTRY, TAG } = tsKhqr;

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const BAKONG_BASE_URL = process.env.BAKONG_BASE_URL;
const BAKONG_TOKEN = process.env.BAKONG_TOKEN;

const BAKONG_ACCOUNT_ID = process.env.BAKONG_ACCOUNT_ID;
const MERCHANT_NAME = process.env.MERCHANT_NAME || "My Cafe";
const MERCHANT_CITY = process.env.MERCHANT_CITY || "Phnom Penh";
const DEFAULT_CURRENCY = (process.env.CURRENCY || "USD").toUpperCase();

// Simple in-memory store: orderId -> {...}
const orders = {};

// Helper: generate simple order id
function generateOrderId() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return `CAFE-${y}${m}${d}${hh}${mm}${ss}-${rand}`;
}

/**
 * POST /api/create-khqr
 * Body: { amount: number, currency?: "USD" | "KHR" }
 * Creates dynamic KHQR for this order total.
 */
app.post("/api/create-khqr", async (req, res) => {
  try {
    const { amount, currency } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid amount" });
    }

    const cur = (currency || DEFAULT_CURRENCY).toUpperCase();
    if (!["USD", "KHR"].includes(cur)) {
      return res
        .status(400)
        .json({ ok: false, error: "Currency must be USD or KHR" });
    }

    if (!BAKONG_ACCOUNT_ID || !BAKONG_ACCOUNT_ID.includes("@")) {
      return res.status(500).json({
        ok: false,
        error:
          "BAKONG_ACCOUNT_ID is not set correctly in .env (e.g. myname@aclb)",
      });
    }

    const orderId = generateOrderId();

    // Amount rules:
    //   - KHR: must be integer (no cents)
    //   - USD: can have decimal
    const khqrAmount = cur === "KHR" ? Math.round(amount) : Number(amount);

    // Optional: expiration (10 minutes from now)
    const expirationTimestamp = Date.now() + 10 * 60 * 1000;

    // Build KHQR payload via ts-khqr
    const khqrResult = KHQR.generate({
      tag: TAG.INDIVIDUAL, // or TAG.MERCHANT, depending on your account type
      accountID: BAKONG_ACCOUNT_ID,
      merchantName: MERCHANT_NAME,
      merchantCity: MERCHANT_CITY,
      countryCode: COUNTRY.KH,
      currency: cur === "USD" ? CURRENCY.USD : CURRENCY.KHR,
      amount: khqrAmount,
      merchantCategoryCode: "5999",
      expirationTimestamp,
      additionalData: {
        billNumber: orderId,
        purposeOfTransaction: "Cafe order",
      },
    });

    // Depending on ts-khqr version, data may be under .data.qr or .qr
    const khqrString =
      khqrResult?.data?.qr || khqrResult?.qr || khqrResult?.data || "";

    if (!khqrString) {
      return res.status(500).json({
        ok: false,
        error:
          "Failed to generate KHQR string (check ts-khqr version / result shape)",
      });
    }

    // MD5 hash of KHQR string: used for Bakong /v1/check_transaction_by_md5
    const md5 = crypto.createHash("md5").update(khqrString).digest("hex");

    // Generate QR image (PNG base64)
    const qrPngDataUrl = await QRCode.toDataURL(khqrString);

    // Store order
    orders[orderId] = {
      orderId,
      amount: khqrAmount,
      currency: cur,
      khqrString,
      md5,
      status: "PENDING",
    };

    return res.json({
      ok: true,
      orderId,
      amount: khqrAmount,
      currency: cur,
      qrString: khqrString,
      md5,
      qrImage: qrPngDataUrl,
    });
  } catch (err) {
    console.error("create-khqr error", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * GET /api/check-payment/:orderId
 * Uses stored MD5 to ask Bakong if this KHQR has been paid.
 */
app.get("/api/check-payment/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = orders[orderId];

    if (!order) {
      return res.status(404).json({ ok: false, error: "Order not found" });
    }

    // If already marked PAID, no need to call Bakong again
    if (order.status === "PAID") {
      return res.json({
        ok: true,
        status: "PAID",
        amount: order.amount,
        currency: order.currency,
      });
    }

    if (!BAKONG_TOKEN || BAKONG_TOKEN === "YOUR_BAKONG_API_TOKEN_HERE") {
      // No real token yet -> just always PENDING
      return res.json({
        ok: true,
        status: "PENDING",
        note: "BAKONG_TOKEN not set yet; backend is not checking real status.",
      });
    }

    // Call Bakong /v1/check_transaction_by_md5
    const response = await axios.post(
      `${BAKONG_BASE_URL}/v1/check_transaction_by_md5`,
      { md5: order.md5 },
      {
        headers: {
          Authorization: `Bearer ${BAKONG_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = response.data;

    // NOTE: exact response shape depends on Bakong docs.
    // Here we assume:
    //  - responseCode === 0 => success
    //  - data.amount, data.currency exist
    if (data.responseCode === 0 && data.data) {
      const paidAmount = Number(data.data.amount);
      const paidCurrency = data.data.currency;

      // Basic validation: same amount + same currency
      if (
        paidCurrency === order.currency &&
        Math.abs(paidAmount - order.amount) < 0.0001
      ) {
        order.status = "PAID";
      }
    }

    return res.json({
      ok: true,
      status: order.status,
    });
  } catch (err) {
    console.error(
      "check-payment error",
      err.response?.data || err.message || err
    );
    return res.status(500).json({ ok: false, error: "Check payment error" });
  }
});

app.listen(PORT, () => {
  console.log(`Bakong backend listening on http://localhost:${PORT}`);
});
