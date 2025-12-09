// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const QRCode = require("qrcode");
const { BakongKHQR, khqrData, IndividualInfo } = require("bakong-khqr");

const app = express();
app.use(cors());
app.use(express.json());

// ===== CONFIG FROM ENV =====
const PORT = process.env.PORT || 4000;
const BAKONG_BASE_URL =
  process.env.BAKONG_BASE_URL || "https://api-bakong.nbc.gov.kh";
const BAKONG_TOKEN = process.env.BAKONG_TOKEN || ""; // can be empty for now
const BAKONG_ACCOUNT_ID = process.env.BAKONG_ACCOUNT_ID || "";
const MERCHANT_NAME = process.env.MERCHANT_NAME || "CVG Cafe";
const MERCHANT_CITY = process.env.MERCHANT_CITY || "Phnom Penh";
const DEFAULT_CURRENCY = (process.env.CURRENCY || "USD").toUpperCase();

// ===== IN-MEMORY ORDER STORE =====
const ORDERS = {}; // orderId -> { orderId, amount, currency, md5, qrString, status }

// ===== HELPERS =====
function generateOrderId() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const rand = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0");
  return `CAFE-${y}${m}${d}${hh}${mm}${ss}-${rand}`;
}

// Simple health check
app.get("/", (req, res) => {
  res.send("Bakong backend running ✅");
});

// ===== 1) CREATE DYNAMIC KHQR =====
app.post("/api/create-khqr", async (req, res) => {
  try {
    let { amount, currency } = req.body;

    amount = Number(amount || 0);
    if (!amount || amount <= 0) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid amount (must be > 0)" });
    }

    if (!BAKONG_ACCOUNT_ID || !BAKONG_ACCOUNT_ID.includes("@")) {
      return res.status(500).json({
        ok: false,
        error:
          "BAKONG_ACCOUNT_ID is not set or invalid. Example: yourid@aclb in .env",
      });
    }

    const currencyCode = (currency || DEFAULT_CURRENCY).toUpperCase();
    const khqrCurrency =
      currencyCode === "KHR" ? khqrData.currency.khr : khqrData.currency.usd;

    const orderId = generateOrderId();

    // Dynamic QR: expires in 10 minutes
    const expirationTimestamp = Date.now() + 10 * 60 * 1000;

    const optionalData = {
      currency: khqrCurrency,
      amount: amount,
      storeLabel: MERCHANT_NAME,
      merchantCategoryCode: "5999",
      billNumber: orderId,
      purposeOfTransaction: "Cafe order",
      expirationTimestamp,
    };

    const khqr = new BakongKHQR();

    const individualInfo = new IndividualInfo(
      BAKONG_ACCOUNT_ID, // e.g. yourid@aclb
      khqrCurrency,
      MERCHANT_NAME,
      MERCHANT_CITY,
      optionalData
    );

    const result = khqr.generateIndividual(individualInfo);

    if (!result || result.status.code !== 0 || !result.data) {
      console.error("KHQR generate error:", result);
      return res.status(500).json({
        ok: false,
        error: "Failed to generate KHQR",
      });
    }

    const qrString = result.data.qr; // EMV string
    const md5 = result.data.md5; // md5 hash of qr data

    // Convert QR string -> PNG data URL
    const qrImage = await QRCode.toDataURL(qrString, {
      width: 320,
      margin: 2,
    });

    // Store order in memory
    ORDERS[orderId] = {
      orderId,
      amount,
      currency: currencyCode,
      qrString,
      md5,
      status: "PENDING",
      createdAt: new Date().toISOString(),
    };

    return res.json({
      ok: true,
      orderId,
      amount,
      currency: currencyCode,
      qrString,
      md5,
      qrImage,
    });
  } catch (err) {
    console.error("create-khqr error:", err);
    return res.status(500).json({
      ok: false,
      error: "Server error while creating KHQR",
    });
  }
});

// ===== 2) CHECK PAYMENT STATUS =====
app.get("/api/check-payment/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = ORDERS[orderId];

    if (!order) {
      return res.status(404).json({ ok: false, error: "Order not found" });
    }

    // Already paid in memory
    if (order.status === "PAID") {
      return res.json({
        ok: true,
        status: "PAID",
        amount: order.amount,
        currency: order.currency,
      });
    }

    // If no token yet, we can't call Bakong – just keep it pending
    if (!BAKONG_TOKEN || BAKONG_TOKEN === "YOUR_BAKONG_API_TOKEN_HERE") {
      return res.json({
        ok: true,
        status: "PENDING",
        note: "BAKONG_TOKEN not set. Payment check is not active yet.",
      });
    }

    // Call Bakong /v1/check_transaction_by_md5
    const resp = await axios.post(
      `${BAKONG_BASE_URL}/v1/check_transaction_by_md5`,
      { md5: order.md5 },
      {
        headers: {
          Authorization: `Bearer ${BAKONG_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = resp.data;

    // Assuming Bakong response format:
    // { responseCode: 0, data: { amount: "1.50", currency: "USD", ... } }
    if (data && data.responseCode === 0 && data.data) {
      const paidAmount = Number(data.data.amount);
      const paidCurrency = data.data.currency;

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
      amount: order.amount,
      currency: order.currency,
    });
  } catch (err) {
    console.error(
      "check-payment error:",
      err.response?.data || err.message || err
    );
    return res.status(500).json({
      ok: false,
      error: "Server error while checking payment",
    });
  }
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`Bakong backend listening on port ${PORT}`);
});
