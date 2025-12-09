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

// ================= CONFIG =================
const PORT = process.env.PORT || 4000;
const BAKONG_BASE_URL =
  process.env.BAKONG_BASE_URL || "https://api-bakong.nbc.gov.kh";
const BAKONG_TOKEN = process.env.BAKONG_TOKEN || "";
const BAKONG_ACCOUNT_ID = process.env.BAKONG_ACCOUNT_ID || "";
const MERCHANT_NAME = process.env.MERCHANT_NAME || "CVG Cafe";
const MERCHANT_CITY = process.env.MERCHANT_CITY || "Phnom Penh";
const DEFAULT_CURRENCY = (process.env.CURRENCY || "USD").toUpperCase();

// ================= MEMORY STORE =================
const ORDERS = {}; // { [orderId]: { orderId, amount, currency, md5, status } }

// ================= HELPERS =================
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

app.get("/", (req, res) => {
  res.send("Bakong backend running ✅");
});

// =====================================================
// 1) CREATE KHQR (we aim for fixed amount here)
// =====================================================
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
          "BAKONG_ACCOUNT_ID is not set correctly (e.g. yourid@aclb) in env",
      });
    }

    const currencyCode = (currency || DEFAULT_CURRENCY).toUpperCase();
    const khqrCurrency =
      currencyCode === "KHR" ? khqrData.currency.khr : khqrData.currency.usd;

    const orderId = generateOrderId();
    const expirationTimestamp = Date.now() + 10 * 60 * 1000; // 10 minutes

    // ✅ IMPORTANT: correct signature for IndividualInfo:
    // new IndividualInfo(bakongAccountID, merchantName, merchantCity, optionalData)
    const optionalData = {
      currency: khqrCurrency,       // used for transactionCurrency
      amount: amount,               // we want this to become transactionAmount
      merchantCategoryCode: "5999",
      billNumber: orderId,
      purposeOfTransaction: "Cafe order",
      storeLabel: MERCHANT_NAME,
      expirationTimestamp,          // for dynamic behavior
    };

    const individualInfo = new IndividualInfo(
      BAKONG_ACCOUNT_ID,
      MERCHANT_NAME,
      MERCHANT_CITY,
      optionalData
    );

    const khqr = new BakongKHQR();
    const result = khqr.generateIndividual(individualInfo);

    if (!result || result.status.code !== 0 || !result.data) {
      console.error("KHQR generate error:", result);
      return res.status(500).json({
        ok: false,
        error: "Failed to generate KHQR",
        detail: result?.status?.message || null,
      });
    }

    const qrString = result.data.qr;
    const md5 = result.data.md5;

    // 🔍 DEBUG: see exactly what is inside the QR
    try {
      const decoded = BakongKHQR.decode(qrString);
      console.log("Decoded KHQR for order:", orderId);
      console.log(JSON.stringify(decoded, null, 2));
    } catch (err) {
      console.error("Failed to decode KHQR for debug:", err);
    }

    const qrImage = await QRCode.toDataURL(qrString, {
      width: 320,
      margin: 2,
    });

    ORDERS[orderId] = {
      orderId,
      amount,
      currency: currencyCode,
      md5,
      status: "PENDING",
      createdAt: new Date().toISOString(),
    };

    res.json({
      ok: true,
      orderId,
      amount,
      currency: currencyCode,
      qrImage,
    });
  } catch (err) {
    console.error("create-khqr error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// =====================================================
// 2) CHECK PAYMENT STATUS
// =====================================================
app.get("/api/check-payment/:orderId", async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const order = ORDERS[orderId];

    if (!order) {
      return res.status(404).json({ ok: false, error: "Order not found" });
    }

    if (order.status === "PAID") {
      return res.json({
        ok: true,
        status: "PAID",
        amount: order.amount,
        currency: order.currency,
      });
    }

    if (!BAKONG_TOKEN || BAKONG_TOKEN === "YOUR_BAKONG_API_TOKEN_HERE") {
      return res.json({
        ok: true,
        status: "PENDING",
        note: "BAKONG_TOKEN not set; live payment check disabled",
      });
    }

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
    if (data && data.responseCode === 0 && data.data) {
      // you can add extra validation here (amount, currency)
      order.status = "PAID";
    }

    res.json({
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
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// =====================================================
// START SERVER
// =====================================================
app.listen(PORT, () => {
  console.log(`Bakong backend listening on port ${PORT}`);
});
